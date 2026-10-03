"""飞书机器人桥：长连接收消息 → 去重 / @ 过滤 / 绑定 → 用绑定用户自己的 Agent 回复。

设计要点（与 jarvis/wechat.py 同构）：
- 长连接线程只做解析、去重、入队并立即 ack（官方要求 3 秒内）；回复在工作池里算，
  同一会话内的同一发信人严格串行，不同人最多 REPLY_WORKERS 路并行（复用微信桥的分发器）。
- 每条消息按 open_id 找到绑定的贾维斯用户，在该用户的租户里跑 Agent；会话线程
  单聊 ``fs-p-*``、群聊 ``fs-g-*``、群话题 ``fs-t-*`` 互相隔离。
- 群聊只响应 @机器人 的消息；机器人发来的消息一律忽略（防互相回复成环）。
- 回复优先用 CardKit 流式卡片（「思考中…」占位 + 打字机输出）；卡片不可用
  （如缺 cardkit:card:write 权限）自动降级为 Markdown 富文本，再不行降级纯文本。
- 去重：官方文档明确「如有幂等需求请使用 message_id 去重，不要依赖 event_id」，
  这里两者都记；另外丢弃 15 分钟前的旧消息，防止断线恢复后批量补回复。
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Callable

from jarvis.channels.feishu.api import DEFAULT_DOMAIN, FeishuAPI, FeishuAPIError
from jarvis.channels.feishu.bindings import BIND_CODE_TTL_SECONDS, BindingStore
from jarvis.channels.feishu.ws import LongConnection
from jarvis.tenancy import tenant_scope
from jarvis.wechat import _ReplyDispatcher, link_summary_prompt

log = logging.getLogger(__name__)

REPLY_WORKERS = 4
CARD_ELEMENT_ID = "answer"
THINKING_TEXT = "思考中…"
CARD_UPDATE_INTERVAL_SECONDS = 0.6   # 单卡片接口上限 10 次/秒，留足余量
CARD_MAX_CHARS = 6000                # 卡片整体 ≤30KB；中文 3 字节/字，留余量
TEXT_CHUNK_CHARS = 6000              # 富文本 ≤30KB，同样按 6000 字分段
CARD_COOLDOWN_SECONDS = 1800         # 缺权限时停用流式卡片 30 分钟再试
STALE_MESSAGE_SECONDS = 900
DEDUP_TTL_SECONDS = 12 * 3600
DEDUP_MAX_ITEMS = 4096
UNBOUND_HINT_INTERVAL_SECONDS = 600
TYPING_EMOJI = "Typing"

BIND_RE = re.compile(r"^(?:/bind|绑定)\s*(\d{6})$", re.IGNORECASE)
UNBIND_COMMANDS = frozenset({"解绑", "解除绑定", "/unbind"})

EMPTY_REPLY = "（贾维斯没有生成文本回复。）"
NOT_READY_REPLY = "（贾维斯还在启动，请稍后再试。）"
_BIND_STEPS = "请打开贾维斯网页 → 头像菜单 → 飞书，生成 6 位绑定码，然后在这里发送「绑定 123456」"
UNBOUND_REPLY = (
    "你好，我是贾维斯。这个飞书账号还没绑定贾维斯账号，暂时不能对话。\n"
    f"{_BIND_STEPS}（换成你的绑定码，10 分钟内有效）。"
)
STALE_BINDING_REPLY = f"你绑定的贾维斯账号已停用或不存在。{_BIND_STEPS}，重新绑定即可。"
BIND_IN_GROUP_REPLY = "为避免绑定码泄露，请私聊我发送「绑定 123456」完成绑定。"
BIND_LOCKED_REPLY = "绑定码错误次数过多，请一小时后再试。"
BIND_INVALID_REPLY = "绑定码不对或已过期。请回到贾维斯网页 → 头像菜单 → 飞书，重新生成一个再发给我。"
UNBIND_REPLY = "已解除这个飞书账号与贾维斯账号的绑定。"
UNBIND_NONE_REPLY = "这个飞书账号目前没有绑定贾维斯账号。"
AUDIO_REPLY = "（暂时还听不了飞书语音消息，请改发文字。）"
UNSUPPORTED_REPLY = "（目前只支持文字和图片消息。）"
IMAGE_PROMPT = (
    "我发了一张图片，以下是对画面的识别描述，请基于它先简要回应，我可能会继续追问图里的细节。"
    "\n\n【图片内容】\n{desc}\n【图片内容结束】"
)


class _UserFacing(Exception):
    """准备提示词阶段的失败，消息本身就是给用户看的人话。"""


@dataclass(frozen=True)
class FeishuSettings:
    app_id: str = ""
    app_secret: str = ""
    domain: str = DEFAULT_DOMAIN
    streaming_card: bool = True

    @classmethod
    def from_env(cls) -> "FeishuSettings":
        return cls(
            app_id=os.getenv("FEISHU_APP_ID", "").strip(),
            app_secret=os.getenv("FEISHU_APP_SECRET", "").strip(),
            domain=os.getenv("FEISHU_DOMAIN", "").strip() or DEFAULT_DOMAIN,
            streaming_card=os.getenv("FEISHU_STREAMING_CARD", "1").strip() != "0",
        )

    @property
    def configured(self) -> bool:
        return bool(self.app_id and self.app_secret)


@dataclass(frozen=True)
class Inbound:
    event_id: str
    message_id: str
    chat_id: str
    chat_type: str
    topic_id: str
    open_id: str
    msg_type: str
    text: str
    image_keys: tuple[str, ...] = ()
    create_ms: int = 0

    @property
    def is_group(self) -> bool:
        return self.chat_type != "p2p"

    @property
    def alias(self) -> str:
        """贾维斯会话线程别名：单聊、群聊、群话题互相隔离（同一群里每个用户各自一条）。"""
        if not self.is_group:
            return "fs-p-" + self.chat_id[-16:]
        if self.topic_id:
            return "fs-t-" + self.topic_id[-16:]
        return "fs-g-" + self.chat_id[-16:]


class _Dedup:
    def __init__(self, clock: Callable[[], float], ttl: float = DEDUP_TTL_SECONDS, limit: int = DEDUP_MAX_ITEMS):
        self._clock, self._ttl, self._limit = clock, ttl, limit
        self._items: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    def seen_or_add(self, *keys: str) -> bool:
        keys = tuple(k for k in keys if k and not k.endswith(":"))
        now = self._clock()
        with self._lock:
            while self._items and next(iter(self._items.values())) < now - self._ttl:
                self._items.popitem(last=False)
            if any(k in self._items for k in keys):
                return True
            for key in keys:
                self._items[key] = now
            while len(self._items) > self._limit:
                self._items.popitem(last=False)
            return False


# ---- 文本处理 ----

def split_markdown(text: str, limit: int = TEXT_CHUNK_CHARS) -> list[str]:
    """长回复分段：优先在段落/换行处切，跨段的代码块自动补闭合与重开。"""
    text = (text or "").strip()
    if not text:
        return []
    chunks: list[str] = []
    while len(text) > limit:
        cut = text.rfind("\n\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = limit
        chunks.append(text[:cut].rstrip())
        text = text[cut:].lstrip("\n")
    chunks.append(text)
    fixed, carry = [], False
    for chunk in chunks:
        if carry:
            chunk = "```\n" + chunk
        carry = chunk.count("```") % 2 == 1
        fixed.append(chunk + "\n```" if carry else chunk)
    return fixed


def _mention_map(mentions) -> dict[str, dict]:
    result = {}
    for item in mentions if isinstance(mentions, list) else []:
        if isinstance(item, dict) and isinstance(item.get("key"), str):
            result[item["key"]] = item
    return result


def _is_bot_mention(item: dict, bot_open_id: str) -> bool:
    ident = item.get("id") if isinstance(item.get("id"), dict) else {}
    if bot_open_id:
        return ident.get("open_id") == bot_open_id
    return item.get("mentioned_type") == "bot"


def _render_mention(key: str, mentions: dict[str, dict], bot_open_id: str) -> str:
    if key == "@_all":
        return "@所有人"
    item = mentions.get(key)
    if item is None:
        return key
    if _is_bot_mention(item, bot_open_id):
        return ""
    return "@" + str(item.get("name") or "")


_PLACEHOLDER_RE = re.compile(r"@_user_\d+|@_all(?![A-Za-z0-9_])")


def _post_body(content: dict) -> tuple[str, list]:
    if isinstance(content.get("content"), list):
        return str(content.get("title") or ""), content["content"]
    for value in content.values():  # 带语言键的结构：{"zh_cn": {...}}
        if isinstance(value, dict) and isinstance(value.get("content"), list):
            return str(value.get("title") or ""), value["content"]
    return "", []


def parse_content(msg_type: str, content: dict, mentions, bot_open_id: str) -> tuple[str, list[str]]:
    """消息内容 → (纯文本, 图片 key 列表)。@占位符换成名字，@机器人本身去掉。"""
    mention_map = _mention_map(mentions)
    images: list[str] = []
    if msg_type == "text":
        raw = str(content.get("text") or "")
        text = _PLACEHOLDER_RE.sub(lambda m: _render_mention(m.group(0), mention_map, bot_open_id), raw)
    elif msg_type == "post":
        title, rows = _post_body(content)
        lines = [title] if title else []
        for row in rows:
            parts = []
            for element in row if isinstance(row, list) else []:
                if not isinstance(element, dict):
                    continue
                tag = element.get("tag")
                if tag in ("text", "md", "code_block"):
                    parts.append(str(element.get("text") or ""))
                elif tag == "a":
                    parts.append(f"{element.get('text') or ''}({element.get('href') or ''})")
                elif tag == "at":
                    parts.append(_render_mention(str(element.get("user_id") or ""), mention_map, bot_open_id))
                elif tag == "img" and element.get("image_key"):
                    images.append(str(element["image_key"]))
            lines.append("".join(parts))
        text = "\n".join(lines)
    elif msg_type == "image":
        text = ""
        if content.get("image_key"):
            images.append(str(content["image_key"]))
    else:
        text = ""
    text = re.sub(r"[ \t ]+", " ", text).strip()
    return text, images


def mentions_bot(mentions, bot_open_id: str) -> bool:
    items = [m for m in mentions if isinstance(m, dict)] if isinstance(mentions, list) else []
    if bot_open_id:
        return any(_is_bot_mention(m, bot_open_id) for m in items)
    # 取不到机器人 open_id 时退化：默认权限下群里只会推送 @本机器人 的消息
    return bool(items)


def parse_event(event: dict, bot_open_id: str = "") -> Inbound | None:
    """im.message.receive_v1 事件 → Inbound；非用户消息、群里没 @机器人 的返回 None。"""
    header = event.get("header") if isinstance(event.get("header"), dict) else {}
    if header.get("event_type") != "im.message.receive_v1":
        return None
    body = event.get("event") if isinstance(event.get("event"), dict) else {}
    sender = body.get("sender") if isinstance(body.get("sender"), dict) else {}
    if sender.get("sender_type") != "user":
        return None  # 机器人（含其他机器人）发的消息一律忽略，防止互相回复成环
    message = body.get("message") if isinstance(body.get("message"), dict) else {}
    sender_id = sender.get("sender_id") if isinstance(sender.get("sender_id"), dict) else {}
    message_id = str(message.get("message_id") or "")
    chat_id = str(message.get("chat_id") or "")
    open_id = str(sender_id.get("open_id") or "")
    if not (message_id and chat_id and open_id):
        return None
    chat_type = str(message.get("chat_type") or "p2p")
    mentions = message.get("mentions") or []
    if chat_type != "p2p" and not mentions_bot(mentions, bot_open_id):
        return None  # 群聊礼貌规则：只响应 @机器人
    msg_type = str(message.get("message_type") or "")
    try:
        content = json.loads(message.get("content") or "{}")
    except (TypeError, ValueError):
        content = {}
    text, images = parse_content(msg_type, content if isinstance(content, dict) else {}, mentions, bot_open_id)
    try:
        create_ms = int(message.get("create_time") or 0)
    except (TypeError, ValueError):
        create_ms = 0
    return Inbound(
        event_id=str(header.get("event_id") or ""), message_id=message_id, chat_id=chat_id,
        chat_type=chat_type, topic_id=str(message.get("thread_id") or ""), open_id=open_id,
        msg_type=msg_type, text=text, image_keys=tuple(images), create_ms=create_ms,
    )


def image_extension(data: bytes, content_type: str) -> str:
    if data.startswith(b"\x89PNG"):
        return "png"
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data.startswith(b"BM"):
        return "bmp"
    return {"image/png": "png", "image/webp": "webp", "image/bmp": "bmp", "image/heic": "heic"}.get(content_type, "jpg")


# 工具名 → 进度提示里的中文（与网页 web-src/src/toolInfo.js 同口径）
TOOL_LABELS = {
    "now": "看时间", "calc": "计算", "weather": "查天气", "weather_here": "查本地天气",
    "my_location": "查位置", "coding_status": "查编程进度", "memo_add": "记备忘", "memo_list": "查备忘",
    "memo_del": "删备忘", "profile_remember": "记住画像", "profile_list": "查画像",
    "profile_forget": "忘记画像", "schedule_add": "加日程", "schedule_list": "查日程",
    "schedule_del": "删日程", "todo_add": "加待办", "todo_list": "查待办", "todo_done": "完成待办",
    "sys_query": "系统查询", "web_search": "联网搜索", "web_extract": "读取网页",
    "movie_ratings": "查电影评分", "esports_scores": "查电竞比分", "ticket_search": "查票务",
    "meeting_start": "开始会议纪要", "meeting_stop": "结束会议纪要", "recall_history": "翻聊天记录",
    "flow_run": "运行流程", "flow_list": "看我的流程",
}


def tool_label(name: str) -> str:
    if name in TOOL_LABELS:
        return TOOL_LABELS[name]
    try:   # 插件提供的工具（含导入的第三方插件）：用插件名
        from jarvis.plugins import tool_display
        label = tool_display(name)
    except Exception:
        label = None
    return f"用「{label['name']}」" if label else "处理"


def humanize_failure(exc: Exception) -> str:
    """技术异常 → 人话；异常类名只进日志。飞书里多是普通成员，配置细节（主密钥、Provider、
    API Key）对他们没有可操作性，统一指向管理员。"""
    from jarvis.provider_settings import ProviderSettingsError

    if isinstance(exc, ProviderSettingsError):
        log.warning("feishu reply blocked by provider config: %s", exc.code)
        if exc.code == "RATE_LIMITED":
            return "（模型服务正忙，请稍等一分钟再发我一次。）"
        if exc.code == "TIMEOUT":
            return "（模型响应超时了，稍后再把这条消息发我一次。）"
        return "（贾维斯的模型配置暂时不可用，我先答不了；请联系管理员在贾维斯网页的设置里检查模型配置。）"
    if isinstance(exc, TimeoutError) or "timeout" in type(exc).__name__.lower():
        return "（联网检索或模型响应超时了，稍后再把这条消息发我一次。）"
    return "（我这边刚才没处理成功，请稍后再试一次；如果反复失败，请让管理员在网页端检查模型与联网配置。）"


# ---- 流式卡片 ----

class CardStream:
    """一张 CardKit 流式卡片：创建 → 回复引用 → 节流全量更新 → 关闭流式。"""

    def __init__(self, api: FeishuAPI, clock: Callable[[], float], interval: float = CARD_UPDATE_INTERVAL_SECONDS):
        self._api, self._clock, self._interval = api, clock, interval
        self.card_id = ""
        self._seq = 0
        self._last_text: str | None = None
        self._last_at = float("-inf")
        self._failures = 0

    def open(self, reply_to: str, *, in_thread: bool) -> None:
        card = {
            "schema": "2.0",
            "config": {"streaming_mode": True, "summary": {"content": ""}},
            "body": {"elements": [{"tag": "markdown", "element_id": CARD_ELEMENT_ID, "content": THINKING_TEXT}]},
        }
        self.card_id = self._api.create_card(card)
        self._api.reply(reply_to, "interactive", {"type": "card", "data": {"card_id": self.card_id}},
                        in_thread=in_thread)
        self._last_text = THINKING_TEXT

    def push(self, text: str, *, force: bool = False) -> bool:
        text = text or THINKING_TEXT
        if not self.card_id or self._failures >= 3:
            return False
        if text == self._last_text:
            return True
        now = self._clock()
        if not force and now - self._last_at < self._interval:
            return False
        self._last_at = now
        self._seq += 1
        try:
            self._api.update_card_text(self.card_id, CARD_ELEMENT_ID, text, self._seq)
        except FeishuAPIError as exc:
            self._failures += 1
            log.warning("feishu card update failed: code=%s", exc.code)
            return False
        self._failures = 0
        self._last_text = text
        return True

    def progress(self, text: str, tool: str | None) -> None:
        body = text.strip()
        if len(body) > CARD_MAX_CHARS:
            body = body[:CARD_MAX_CHARS] + "…"
        if tool:
            body = (body + "\n\n" if body else "") + f"*正在{tool_label(tool)}…*"
        self.push(body, force=bool(tool))

    def finish(self, text: str, summary: str) -> bool:
        """写入最终内容并关闭流式模式；返回最终内容是否已上屏。"""
        shown = self.push(text, force=True)
        if self.card_id:
            self._seq += 1
            try:
                self._api.card_settings(self.card_id, {
                    "config": {"streaming_mode": False, "summary": {"content": summary[:60]}},
                }, self._seq)
            except FeishuAPIError as exc:  # 关不掉也会在 10 分钟后自动关闭
                log.warning("feishu card finish failed: code=%s", exc.code)
        return shown


# ---- 桥 ----

class FeishuBridge:
    def __init__(
        self,
        *,
        settings_getter: Callable[[], FeishuSettings] = FeishuSettings.from_env,
        api_factory: Callable[[FeishuSettings], FeishuAPI] | None = None,
        connection_factory=None,
        bindings: BindingStore | None = None,
        describe_image: Callable[[bytes, str], str] | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        dispatcher_factory=None,
    ) -> None:
        self._settings_getter = settings_getter
        self._api_factory = api_factory or (
            lambda s: FeishuAPI(s.app_id, s.app_secret, domain=s.domain)
        )
        self._connection_factory = connection_factory or (
            lambda s, **hooks: LongConnection(s.app_id, s.app_secret, domain=s.domain, **hooks)
        )
        self.bindings = bindings or BindingStore()
        self._describe_image = describe_image
        self._clock = clock
        self._wall_clock = wall_clock
        self._dispatcher_factory = dispatcher_factory or (
            lambda: _ReplyDispatcher(REPLY_WORKERS, thread_name_prefix="jarvis-feishu-reply")
        )
        self._lock = threading.RLock()
        self._settings = FeishuSettings()
        self._state = {"state": "disabled", "error": "", "since": ""}
        self._generation = 0
        self._api: FeishuAPI | None = None
        self._conn = None
        self._dispatcher = None
        self._bot_open_id = ""
        self._bot_name = ""
        self._card_disabled_until = 0.0
        self._hinted: dict[str, float] = {}
        self._dedup = _Dedup(clock)
        self._bundle_for = None
        self._chunk_text: Callable[[object], str] = lambda content: content if isinstance(content, str) else str(content)
        self._tenant_store = None
        self._accounts = None
        self._quick_reply = None
        self._message_hook = None

    def configure(self, *, bundle_for, chunk_text, tenant_store, accounts, quick_reply=None,
                  message_hook=None) -> None:
        with self._lock:
            self._bundle_for = bundle_for
            self._chunk_text = chunk_text
            self._tenant_store = tenant_store
            self._accounts = accounts
            # (user_id, text) -> str | None：提醒的「稍后 / 好了」回复短语，None 表示照常交给 Agent
            self._quick_reply = quick_reply
            # (user_id, channel, text, on_start=...) -> str | None：消息触发流程（第二十轮，jarvis/flows/hooks.py）
            self._message_hook = message_hook

    # ---- 生命周期与状态 ----

    def status(self) -> dict:
        with self._lock:
            return {
                **self._state,
                "configured": self._settings.configured,
                "bot_name": self._bot_name,
                "streaming_card": self._settings.streaming_card and self._clock() >= self._card_disabled_until,
            }

    def start(self) -> dict:
        with self._lock:
            if self._conn is not None:
                return self.status()
            settings = self._settings_getter()
            self._settings = settings
            if not settings.configured:
                self._state.update(state="disabled", error="", since="")
                return self.status()
            self._generation += 1
            generation = self._generation
            self._api = self._api_factory(settings)
            self._dispatcher = self._dispatcher_factory()
            self._conn = self._connection_factory(
                settings,
                on_event=self.handle_event,
                on_state=lambda state, error, g=generation: self._on_conn_state(g, state, error),
                before_connect=self._refresh_bot_identity,
            )
            self._state.update(state="connecting", error="", since="")
            conn = self._conn
        conn.start()
        return self.status()

    def shutdown(self) -> None:
        with self._lock:
            self._generation += 1
            conn, self._conn = self._conn, None
            dispatcher, self._dispatcher = self._dispatcher, None
            api, self._api = self._api, None
            if self._settings.configured:
                self._state.update(state="stopped", error="", since="")
        if conn is not None:
            conn.stop(timeout=3)
        if dispatcher is not None:
            dispatcher.stop()
        if api is not None:
            api.close()

    def _on_conn_state(self, generation: int, state: str, error: str) -> None:
        with self._lock:
            if generation != self._generation:
                return  # 旧连接线程的迟到回调不能覆盖新状态
            since = time.strftime("%Y-%m-%d %H:%M:%S") if state == "connected" else ""
            self._state.update(state=state, error=error, since=since)

    def _refresh_bot_identity(self) -> None:
        api = self._api
        if api is None or self._bot_open_id:
            return
        info = api.bot_info()
        with self._lock:
            self._bot_open_id = str(info.get("open_id") or "")
            self._bot_name = str(info.get("app_name") or "")

    # ---- 主动推送（日程提醒 / 晨报 / 巡检，见 jarvis/delivery.py） ----

    def bound_users(self) -> list[str]:
        """已绑定飞书的贾维斯账号（去重）；渠道未启用时为空，扫描线程据此跳过。"""
        with self._lock:
            if self._api is None:
                return []
        users = sorted({uid for uid in self.bindings.all().values() if uid})
        return [uid for uid in users if self._accounts is None or self._active_username(uid)]

    def push_ready(self, user_id: str) -> bool:
        with self._lock:
            if self._api is None:
                return False
        return self.bindings.count_for(user_id) > 0

    def doc_target(self, user_id: str) -> tuple[FeishuAPI, list[str]] | None:
        """建飞书文档用：(客户端, 该账号绑定的 open_id 列表)；渠道未启用、未绑定或账号停用返回 None。"""
        with self._lock:
            api = self._api
        if api is None or (self._accounts is not None and not self._active_username(user_id)):
            return None
        open_ids = [open_id for open_id, bound in self.bindings.all().items() if bound == user_id]
        return (api, open_ids) if open_ids else None

    def push_text(self, user_id: str, text: str) -> bool:
        """私聊推一条文字给该账号绑定的每个飞书身份；任一送达即 True，失败只记日志不抛错。"""
        with self._lock:
            api = self._api
        if api is None or not text.strip():
            return False
        if self._accounts is not None and not self._active_username(user_id):
            return False   # 账号已停用：绑定还在也不推
        delivered = False
        for open_id, bound in self.bindings.all().items():
            if bound != user_id:
                continue
            try:
                api.send("open_id", open_id, "text", {"text": text})
                delivered = True
            except FeishuAPIError as exc:
                log.warning("feishu push failed: code=%s", exc.code)
        return delivered

    # ---- 收消息（长连接线程，必须快） ----

    def handle_event(self, event: dict) -> None:
        if self._api is None:
            return  # 已停机：旧连接线程迟到的事件直接丢弃
        inbound = parse_event(event, self._bot_open_id)
        if inbound is None:
            return
        if self._dedup.seen_or_add("m:" + inbound.message_id, "e:" + inbound.event_id):
            log.info("feishu duplicate message skipped: %s", inbound.message_id[-8:])
            return
        if inbound.create_ms and self._wall_clock() - inbound.create_ms / 1000 > STALE_MESSAGE_SECONDS:
            log.info("feishu stale message skipped: %s", inbound.message_id[-8:])
            return
        with self._lock:
            dispatcher = self._dispatcher
        if dispatcher is None:
            self.process(inbound)  # 无工作池（测试/探针）时同步处理
            return
        if not dispatcher.submit(f"{inbound.chat_id}:{inbound.open_id}", lambda: self.process(inbound)):
            log.info("feishu reply skipped: dispatcher stopped")

    # ---- 处理一条消息（工作池线程） ----

    def process(self, inbound: Inbound) -> None:
        try:
            self._process(inbound)
        except Exception as exc:  # 单条失败不能拖垮后续消息
            log.warning("feishu message job crashed: %s", type(exc).__name__)

    def _process(self, inbound: Inbound) -> None:
        text = inbound.text.strip()
        bind = BIND_RE.match(text)
        if bind:
            self._handle_bind(inbound, bind.group(1))
            return
        if text in UNBIND_COMMANDS:
            removed = self.bindings.unbind_open_id(inbound.open_id)
            self._deliver_text(inbound, UNBIND_REPLY if removed else UNBIND_NONE_REPLY)
            return
        if self._bundle_for is None or self._accounts is None or self._tenant_store is None:
            self._deliver_text(inbound, NOT_READY_REPLY)
            return
        user_id = self.bindings.user_for(inbound.open_id)
        if not user_id or not self._active_username(user_id):
            self._hint_unbound(inbound, stale=bool(user_id))
            return
        if not inbound.is_group and text and self._quick_reply is not None:
            try:
                answer = self._quick_reply(user_id, text)
            except Exception as exc:
                log.warning("feishu quick reply failed: %s", type(exc).__name__)
                answer = None
            if answer:
                self._deliver_text(inbound, answer)
                return
        if inbound.msg_type == "audio":
            self._deliver_text(inbound, AUDIO_REPLY)
            return
        if text and self._message_hook is not None and self._flow_hook(inbound, user_id, text):
            return
        if not text and not inbound.image_keys:
            if inbound.msg_type in ("text", "post"):
                text = "你好"  # 群里只 @ 了一下
            else:
                self._deliver_text(inbound, UNSUPPORTED_REPLY)
                return
        self._respond(inbound, user_id, lambda: self._build_prompt(inbound, text))

    def _flow_hook(self, inbound: Inbound, user_id: str, text: str) -> bool:
        """消息触发流程：命中就由流程处理并回复结果（返回 True）；没命中或查不了照常交给 Agent。"""
        reaction = ""

        def started(_flow_name: str) -> None:
            nonlocal reaction
            reaction = self._typing_on(inbound.message_id)   # 流程可能跑一会儿：先挂「打字中」

        try:
            answer = self._message_hook(user_id, "feishu", text, on_start=started)
        except Exception as exc:
            log.warning("feishu flow hook failed: %s", type(exc).__name__)
            answer = None
        if answer:
            for chunk in split_markdown(answer):
                self._deliver_markdown(inbound, chunk)
        if reaction:
            try:
                self._require_api().delete_reaction(inbound.message_id, reaction)
            except FeishuAPIError:
                pass
        return bool(answer)

    def _active_username(self, user_id: str) -> str | None:
        try:
            for row in self._accounts.list_users():
                if row.get("id") == user_id and row.get("active"):
                    return str(row.get("username") or "")
        except Exception as exc:
            log.warning("feishu account lookup failed: %s", type(exc).__name__)
        return None

    def _handle_bind(self, inbound: Inbound, code: str) -> None:
        if inbound.is_group:
            self._deliver_text(inbound, BIND_IN_GROUP_REPLY)
            return
        result, user_id = self.bindings.redeem(code, inbound.open_id)
        if result == "locked":
            self._deliver_text(inbound, BIND_LOCKED_REPLY)
        elif result != "ok" or not user_id:
            self._deliver_text(inbound, BIND_INVALID_REPLY)
        else:
            name = self._active_username(user_id) if self._accounts is not None else None
            self._hinted.pop(inbound.open_id, None)
            self._deliver_text(inbound, (
                f"绑定成功：这个飞书账号已连接到贾维斯账号「{name or user_id[:8]}」。"
                "现在可以直接和我对话了，群聊里 @我 即可；发送「解绑」可解除绑定。"
            ))

    def _hint_unbound(self, inbound: Inbound, *, stale: bool) -> None:
        now = self._clock()
        last = self._hinted.get(inbound.open_id)
        if last is not None and now - last < UNBOUND_HINT_INTERVAL_SECONDS:
            return
        self._hinted[inbound.open_id] = now
        self._deliver_text(inbound, STALE_BINDING_REPLY if stale else UNBOUND_REPLY)

    def _build_prompt(self, inbound: Inbound, text: str) -> str:
        if not inbound.image_keys:
            return link_summary_prompt(text) or text  # 光发一条链接 = 读文总结（与微信桥一致）
        api = self._require_api()
        try:
            data, ctype = api.download_resource(inbound.message_id, inbound.image_keys[0], "image")
        except FeishuAPIError as exc:
            log.warning("feishu image download failed: code=%s", exc.code)
            raise _UserFacing("（图片下载失败，请稍后重发；如持续失败请让管理员检查机器人的消息读取权限。）") from exc
        from jarvis import vision  # 复用网页上传同一套 qwen3-vl 识别（DASHSCOPE_API_KEY）

        describe = self._describe_image or vision.describe_image
        try:
            desc = describe(data, image_extension(data, ctype))
        except vision.VisionError as exc:  # VisionError 的消息本身就是给用户看的人话
            raise _UserFacing(f"（图片识别失败：{exc}）") from exc
        prompt = IMAGE_PROMPT.format(desc=desc)
        return f"{prompt}\n\n我的问题：{text}" if text else prompt

    def _require_api(self) -> FeishuAPI:
        with self._lock:
            api = self._api
        if api is None:
            raise FeishuAPIError(-1, "bridge stopped")
        return api

    # ---- 调 Agent ----

    def _run_agent(self, user_id: str, inbound: Inbound, prompt: str, progress) -> str:
        from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

        from jarvis.graph import heal_dangling_tool_calls

        title = "飞书 · " + (inbound.text or ("图片" if inbound.image_keys else "对话")).replace("\n", " ")[:18]
        with tenant_scope(user_id):
            thread = self._tenant_store().upsert_thread(inbound.alias, prompt, title=title)
            with self._bundle_for(user_id) as bundle:
                agent = bundle.agent
                config = {"configurable": {"thread_id": thread.checkpoint_thread_id}}
                heal_dangling_tool_calls(agent, thread.checkpoint_thread_id)
                inputs = {"messages": [{"role": "user", "content": prompt}]}
                stream = getattr(agent, "stream", None)
                if progress is None or not callable(stream):
                    result = agent.invoke(inputs, config=config)
                    return self._chunk_text(result["messages"][-1].content)
                turn, tool = "", None
                for chunk, _meta in stream(inputs, config=config, stream_mode="messages"):
                    if isinstance(chunk, ToolMessage):
                        turn, tool = "", None  # 工具跑完，新一轮模型输出从头显示
                    elif isinstance(chunk, AIMessageChunk):
                        for call in chunk.tool_call_chunks or []:
                            if call.get("name"):
                                tool = call["name"]
                        turn += self._chunk_text(chunk.content)
                    elif isinstance(chunk, AIMessage):
                        turn = self._chunk_text(chunk.content)
                    else:
                        continue
                    progress(turn, tool)
                if turn.strip():
                    return turn
                try:  # 兜底：以落盘的最后一条消息为准
                    messages = (agent.get_state(config).values or {}).get("messages", [])
                    return self._chunk_text(messages[-1].content) if messages else ""
                except Exception:
                    return ""

    # ---- 回复 ----

    def _card_available(self) -> bool:
        return self._settings.streaming_card and self._clock() >= self._card_disabled_until

    def _respond(self, inbound: Inbound, user_id: str, build_prompt: Callable[[], str]) -> None:
        from jarvis import usage
        if blocked := usage.check_model(user_id):   # 今天的模型用量到上限：回人话，不调模型
            self._deliver_text(inbound, blocked)
            return
        api = self._require_api()
        card = None
        if self._card_available():
            card = CardStream(api, self._clock)
            try:
                card.open(inbound.message_id, in_thread=bool(inbound.topic_id))
            except FeishuAPIError as exc:
                card = None
                if exc.permission_denied:
                    self._card_disabled_until = self._clock() + CARD_COOLDOWN_SECONDS
                    log.warning("feishu streaming card unavailable (code=%s, 缺 cardkit:card:write 权限？)，"
                                "%d 秒内降级为普通消息", exc.code, CARD_COOLDOWN_SECONDS)
                else:
                    log.warning("feishu streaming card open failed: code=%s", exc.code)
        reaction = "" if card is not None else self._typing_on(inbound.message_id)
        try:
            prompt = build_prompt()
            answer = self._run_agent(user_id, inbound, prompt, card.progress if card else None)
        except _UserFacing as exc:
            answer = str(exc)
        except Exception as exc:
            log.warning("feishu agent reply failed: %s", type(exc).__name__)
            answer = humanize_failure(exc)
        chunks = split_markdown(answer) or [EMPTY_REPLY]
        if card is not None:
            head = chunks[0] + ("\n\n*（回复较长，后续内容见下一条消息）*" if len(chunks) > 1 else "")
            summary = " ".join(chunks[0].split())
            if card.finish(head, summary):
                chunks = chunks[1:]
        for chunk in chunks:
            self._deliver_markdown(inbound, chunk)
        if reaction:
            try:
                api.delete_reaction(inbound.message_id, reaction)
            except FeishuAPIError:
                pass

    def _typing_on(self, message_id: str) -> str:
        try:
            return self._require_api().add_reaction(message_id, TYPING_EMOJI)
        except FeishuAPIError:
            return ""  # 「打字中」只是体验加分项，失败不影响回复

    def _deliver_markdown(self, inbound: Inbound, text: str) -> None:
        """富文本 md 标签（官方推荐的 Markdown 发法）→ 纯文本 → 直接发到会话（原消息被撤回时）。"""
        api = self._require_api()
        in_thread = bool(inbound.topic_id)
        try:
            api.reply(inbound.message_id, "post", {"zh_cn": {"content": [[{"tag": "md", "text": text}]]}},
                      in_thread=in_thread)
            return
        except FeishuAPIError as exc:
            log.warning("feishu markdown reply failed, falling back to text: code=%s", exc.code)
        self._deliver_text(inbound, text)

    def _deliver_text(self, inbound: Inbound, text: str) -> None:
        try:
            api = self._require_api()
        except FeishuAPIError:
            return
        try:
            api.reply(inbound.message_id, "text", {"text": text}, in_thread=bool(inbound.topic_id))
            return
        except FeishuAPIError as exc:
            log.warning("feishu text reply failed: code=%s", exc.code)
        try:
            api.send("chat_id", inbound.chat_id, "text", {"text": text})
        except FeishuAPIError as exc:
            log.warning("feishu send failed: code=%s", exc.code)


__all__ = [
    "BIND_CODE_TTL_SECONDS", "CardStream", "FeishuBridge", "FeishuSettings", "Inbound",
    "humanize_failure", "parse_content", "parse_event", "split_markdown",
]
