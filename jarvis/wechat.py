"""服务端个人微信桥：iLink 扫码登录、凭据恢复与消息长轮询。"""
from __future__ import annotations

import base64
import os
import re
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
import json
import logging
import random
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

import httpx
import segno

from jarvis import config
from jarvis import wechat_voice

ILINK = "https://ilinkai.weixin.qq.com/ilink/bot"
ILINK_CHANNEL_VERSION = "2.4.6"
ILINK_APP_ID = "bot"
ILINK_APP_CLIENT_VERSION = str((2 << 16) | (4 << 8) | 6)
QR_EXPIRES_SECONDS = 180
REPLY_CHUNK_SIZE = 1500
# 回复计算工作池上限：一个人的慢回复（联网搜索可达 60s+）不能拖住其他人，
# 也不能无限开线程；≤20 人规模下 4 个并发回复足够。
REPLY_WORKERS = 4
# 语音识别链路（下载/解码/识别）任何一环失败时给用户的固定提示（任务书指定文案）。
VOICE_NOT_UNDERSTOOD = "这段语音我没听清，麻烦再说一次或打字"

# 发链接即总结：消息基本只有一条链接时，包装成确定性的读文总结指令（对齐元宝的微信玩法）
_URL_RE = re.compile(r"https?://[^\s<>\"）)】]+")
LINK_SUMMARY_PROMPT = (
    "请用 web_extract 读取这个链接的正文，用要点式总结主要内容（不超过 5 条），"
    "最后用一句话给出结论；正文提取失败就改用 web_search 按标题检索后如实说明。链接：{url}"
)


def link_summary_prompt(text: str) -> str | None:
    """消息=「链接（可带少量寒暄）」→ 返回总结指令；带了明确问题则返回 None 按原文走。"""
    urls = _URL_RE.findall(text)
    if not urls:
        return None
    stripped = _URL_RE.sub("", text).strip()
    if len(stripped) > 12:
        return None
    return LINK_SUMMARY_PROMPT.format(url=urls[0])


# 群聊礼貌规则：只有被 @ 才应答（@名字可用 JARVIS_WECHAT_GROUP_NAME 覆盖，默认「贾维斯」）
def group_mention_text(text: str) -> str | None:
    name = os.getenv("JARVIS_WECHAT_GROUP_NAME", "贾维斯").strip()
    if not name:
        return None
    tag = f"@{name}"
    if tag not in text:
        return None
    cleaned = text.replace(tag, " ").replace("\u2005", " ").strip()
    return cleaned or "你好"


# 提醒推送绑定：确定性命令词（不进大模型，谁发绑谁——由用户自己指定收提醒的会话）
PUSH_BIND_COMMANDS = ("提醒发给我", "把提醒发到这里", "提醒发到这里")
PUSH_UNBIND_COMMANDS = ("取消提醒推送", "关闭提醒推送")
PUSH_BOUND_REPLY = "好的，以后日程到点我会在这里主动提醒你。发「取消提醒推送」可以关闭。"
PUSH_UNBOUND_REPLY = "好的，日程到点我不再主动推送提醒。"
# 必须低于 iLink 心跳帧间隔（实测约 18 秒）：心跳字节会不断重置 read 超时，
# 僵死会话（连接活、心跳在发、但响应永不完成也不派消息）在更长的超时下
# 永远不会被翻新，表现为「状态已连接却收不到任何消息」（2026-08-12 线上）。
UPDATES_READ_TIMEOUT_SECONDS = 15

log = logging.getLogger(__name__)


def _probe_shape(value, depth: int = 0):
    """脱敏描述报文结构：保留 key 名、类型与小整数值，长字符串只记长度。

    微信语音等非文本消息的协议结构未知，只能靠真实报文反推；
    内容本身（语音数据、文本、URL）绝不能进日志。
    """
    if depth >= 5:
        return "…"
    if isinstance(value, dict):
        return {str(k): _probe_shape(v, depth + 1) for k, v in list(value.items())[:24]}
    if isinstance(value, list):
        return [_probe_shape(v, depth + 1) for v in value[:6]]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        return value if -1_000_000 < value < 1_000_000 else f"int({len(str(value))}位)"
    if isinstance(value, str):
        return f"str(len={len(value)})"
    return type(value).__name__


def _probe_non_text(message: dict) -> None:
    """对非纯文本消息记录脱敏结构日志，为语音消息协议探明供数据。"""
    try:
        items = message.get("item_list", [])
        non_text = not isinstance(items, list) or any(
            isinstance(it, dict) and it.get("type") != 1 for it in items
        )
        if message.get("message_type") != 1 or non_text:
            log.info(
                "WeChat non-text probe: %s",
                json.dumps(_probe_shape(message), ensure_ascii=False),
            )
    except Exception:
        pass


class _ReplyDispatcher:
    """按发信人串行、总并发受限的回复执行器。

    长轮询线程只负责收发与入队；回复计算（Agent 全链路）在这里的工作池中
    进行。同一发信人的消息严格按到达顺序串行，不同发信人最多 REPLY_WORKERS
    路并行，互不等待。
    """

    def __init__(self, max_workers: int = REPLY_WORKERS) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=max(1, int(max_workers)),
            thread_name_prefix="jarvis-wechat-reply",
        )
        self._lock = threading.Lock()
        self._done = threading.Condition(self._lock)
        self._queues: dict[str, deque] = {}
        self._pending = 0
        self._stopped = False

    def submit(self, sender: str, job) -> bool:
        """入队一条消息的回复任务；已停止时拒绝（返回 False）。"""
        with self._lock:
            if self._stopped:
                return False
            queue = self._queues.get(sender)
            if queue is None:
                queue = deque()
                self._queues[sender] = queue
                queue.append(job)
                self._pending += 1
                self._executor.submit(self._run_sender, sender)
            else:
                queue.append(job)
                self._pending += 1
            return True

    def _run_sender(self, sender: str) -> None:
        """独占地消费一个发信人的队列：天然保证同人串行、顺序不乱。"""
        while True:
            with self._lock:
                queue = self._queues.get(sender)
                if not queue or self._stopped:
                    self._queues.pop(sender, None)
                    return
                job = queue.popleft()
            try:
                job()
            except Exception as exc:  # 单条消息失败不能影响后续消息
                log.warning("WeChat reply job crashed: %s", type(exc).__name__)
            finally:
                with self._lock:
                    self._pending -= 1
                    self._done.notify_all()

    def drain(self, timeout: float | None = None) -> bool:
        """等待所有已入队任务完成；测试与优雅停机使用。"""
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._done:
            while self._pending > 0:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self._done.wait(remaining)
            return True

    def stop(self) -> None:
        """停止接收新任务并丢弃未开始的任务；进行中的任务自然结束。"""
        with self._lock:
            self._stopped = True
        self._executor.shutdown(wait=False, cancel_futures=True)


class WeChatBridge:
    """一套进程内桥接状态机；网络和线程边界可注入以便确定性测试。"""

    def __init__(
        self,
        agent_getter=None,
        chunk_text=None,
        owner_getter=None,
        data_dir_getter: Callable[[], Path] | None = None,
        client_factory=None,
        thread_factory=None,
        sleeper=None,
        voice_pipeline=None,
    ):
        self._voice = voice_pipeline or wechat_voice.VoicePipeline()
        self._agent_getter = agent_getter
        self._chunk_text = chunk_text
        self._owner_getter = owner_getter
        self._runtime_getter = None
        self._data_dir_getter = data_dir_getter or config.data_dir
        self._client_factory = client_factory or (
            lambda: httpx.Client(trust_env=False)
        )
        self._thread_factory = thread_factory or threading.Thread
        self._sleep = sleeper or time.sleep
        self._lock = threading.RLock()
        self._state = {
            "state": "idle",
            "qr_uri": "",
            "error": "",
            "since": "",
        }
        self._generation = 0
        self._updates_stop = threading.Event()
        self._updates_thread = None
        self._dispatcher = None

    def configure(self, agent_getter, chunk_text, owner_getter=None, runtime_getter=None) -> None:
        """由 Web 服务注入 Agent 与消息文本转换器。"""
        with self._lock:
            self._agent_getter = agent_getter
            self._chunk_text = chunk_text
            self._owner_getter = owner_getter
            self._runtime_getter = runtime_getter

    def _token_path(self) -> Path:
        data_dir = self._data_dir_getter()
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir / "wechat_token"

    def _sync_path(self) -> Path:
        data_dir = self._data_dir_getter()
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir / "wechat_sync.json"

    def _load_sync_buf(self) -> str:
        try:
            payload = json.loads(self._sync_path().read_text(encoding="utf-8"))
            value = payload.get("get_updates_buf", "")
            return value if isinstance(value, str) else ""
        except (OSError, TypeError, ValueError):
            return ""

    def _save_sync_buf(self, value: str) -> None:
        if not value:
            return
        path = self._sync_path()
        pending = path.with_suffix(".tmp")
        pending.write_text(
            json.dumps({"get_updates_buf": value}, ensure_ascii=False),
            encoding="utf-8",
        )
        pending.chmod(0o600)
        pending.replace(path)
        path.chmod(0o600)

    def _clear_sync_buf(self) -> None:
        self._sync_path().unlink(missing_ok=True)

    # ---- 提醒主动推送：绑定的联系人与最近一次 context_token（0600 落盘） ----

    def _push_target_path(self) -> Path:
        data_dir = self._data_dir_getter()
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir / "wechat_push_target.json"

    def _load_push_target(self) -> dict | None:
        try:
            payload = json.loads(self._push_target_path().read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        from_id = payload.get("from_id", "")
        if not isinstance(from_id, str) or not from_id:
            return None
        context = payload.get("context_token", "")
        return {"from_id": from_id, "context_token": context if isinstance(context, str) else ""}

    def _save_push_target(self, from_id: str, context_token) -> None:
        path = self._push_target_path()
        pending = path.with_suffix(".tmp")
        pending.write_text(
            json.dumps({
                "from_id": from_id,
                "context_token": context_token if isinstance(context_token, str) else "",
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        pending.chmod(0o600)
        pending.replace(path)
        path.chmod(0o600)

    def _clear_push_target(self) -> None:
        self._push_target_path().unlink(missing_ok=True)

    def _refresh_push_context(self, from_id: str, context_token) -> None:
        """绑定联系人的 context_token 随最新消息滚动，降低推送时已过期的概率。"""
        if not isinstance(context_token, str) or not context_token:
            return
        target = self._load_push_target()
        if target and target["from_id"] == from_id and context_token != target["context_token"]:
            self._save_push_target(from_id, context_token)

    def _push_channel(self) -> tuple[dict, str] | None:
        """推送通道三要素齐了才返回 (target, token)：已连接、已绑定、有凭据。"""
        with self._lock:
            if self._state["state"] != "connected":
                return None
        target = self._load_push_target()
        if not target:
            return None
        try:
            token = self._token_path().read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return (target, token) if token else None

    def push_available(self) -> bool:
        return self._push_channel() is not None

    def push_text(self, text: str) -> bool:
        """主动推送一条文字（日程提醒等）给绑定联系人；未绑定/未连接返回 False 不抛错。"""
        channel = self._push_channel()
        if channel is None:
            return False
        target, token = channel
        client = self._client_factory()
        try:
            for chunk in self._split_reply(text):
                self._send_items(
                    client, token, target["from_id"], target["context_token"],
                    [{"type": 1, "text_item": {"text": chunk}}],
                )
            return True
        except (httpx.HTTPError, TypeError, ValueError) as exc:
            log.warning("WeChat push failed: %s", type(exc).__name__)
            return False
        finally:
            client.close()

    def push_voice_then_text(self, text: str) -> bool:
        """晨报电台推送：先试语音条（失败只降级），再发文字；文字发出即算成功。"""
        channel = self._push_channel()
        if channel is None:
            return False
        target, token = channel
        client = self._client_factory()
        try:
            try:
                items = self._voice.voice_reply_items(text)
                self._send_items(client, token, target["from_id"], target["context_token"], items)
            except wechat_voice.VoiceError as exc:
                log.warning("radio voice degraded to text (synthesis/encode): %s", type(exc).__name__)
            except (httpx.HTTPError, TypeError, ValueError) as exc:
                log.warning("radio voice degraded to text (send): %s", type(exc).__name__)
            sent_any = False
            for chunk in self._split_reply(text):
                try:
                    self._send_items(
                        client, token, target["from_id"], target["context_token"],
                        [{"type": 1, "text_item": {"text": chunk}}],
                    )
                    sent_any = True
                except (httpx.HTTPError, TypeError, ValueError) as exc:
                    log.warning("radio text push failed: %s", type(exc).__name__)
            return sent_any
        finally:
            client.close()

    @staticmethod
    def _base_info() -> dict:
        return {
            "channel_version": ILINK_CHANNEL_VERSION,
            "bot_agent": "JWS-Agent",
        }

    @staticmethod
    def _headers(token: str) -> dict:
        return {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
            "X-WECHAT-UIN": base64.b64encode(
                str(random.randint(1, 2**32 - 1)).encode()
            ).decode(),
            "Authorization": f"Bearer {token}",
        }

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def _set(self, **changes) -> None:
        with self._lock:
            self._state.update(changes)

    def _set_for_generation(self, generation: int, **changes) -> bool:
        with self._lock:
            if generation != self._generation:
                return False
            self._state.update(changes)
            return True

    def connect(self) -> dict:
        """获取一个二维码；正在连接或已在线时保持幂等。"""
        with self._lock:
            if self._state["state"] in {"loading", "waiting", "connected"}:
                return dict(self._state)
            self._generation += 1
            generation = self._generation
            self._state.update(
                state="loading", qr_uri="", error="", since=""
            )

        client = None
        try:
            client = self._client_factory()
            response = client.get(
                f"{ILINK}/get_bot_qrcode",
                params={"bot_type": 3},
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or payload.get("ret") not in (None, 0):
                raise ValueError("unexpected response")
            qrcode = payload.get("qrcode")
            scan_url = payload.get("qrcode_img_content")
            if not isinstance(qrcode, str) or not qrcode:
                raise ValueError("missing qrcode")
            if not isinstance(scan_url, str) or not scan_url:
                raise ValueError("missing qrcode image content")
            qr_uri = segno.make(scan_url).svg_data_uri(scale=4, border=2)

            with self._lock:
                if generation != self._generation:
                    return dict(self._state)
                self._state.update(
                    state="waiting",
                    qr_uri=qr_uri,
                    error="",
                    since=time.strftime("%H:%M:%S"),
                )
                worker = self._thread_factory(
                    target=self._poll_qrcode,
                    args=(generation, qrcode),
                    daemon=True,
                    name="jarvis-wechat-qr",
                )
                worker.start()
                return dict(self._state)
        except (KeyError, TypeError, ValueError):
            self._set_for_generation(
                generation,
                state="error",
                qr_uri="",
                error="取二维码失败：iLink 响应异常，请重试",
                since="",
            )
            return self.status()
        except (httpx.HTTPError, OSError) as exc:
            log.warning("iLink QR request failed: %s", type(exc).__name__)
            self._set_for_generation(
                generation,
                state="error",
                qr_uri="",
                error="取二维码失败：网络异常，请重试",
                since="",
            )
            return self.status()
        except Exception as exc:
            log.exception("Unexpected iLink QR error: %s", type(exc).__name__)
            self._set_for_generation(
                generation,
                state="error",
                qr_uri="",
                error="取二维码失败：服务异常，请重试",
                since="",
            )
            return self.status()
        finally:
            if client is not None:
                client.close()

    def _poll_qrcode(self, generation: int, qrcode: str) -> None:
        """轮询本代二维码；旧代次永远不能覆盖新状态。"""
        client = self._client_factory()
        deadline = time.monotonic() + QR_EXPIRES_SECONDS
        try:
            while time.monotonic() < deadline:
                with self._lock:
                    if (
                        generation != self._generation
                        or self._state["state"] != "waiting"
                    ):
                        return
                try:
                    response = client.get(
                        f"{ILINK}/get_qrcode_status",
                        params={"qrcode": qrcode},
                        timeout=35,
                    )
                    response.raise_for_status()
                    payload = response.json()
                    if not isinstance(payload, dict):
                        raise ValueError("invalid QR status")
                    if payload.get("status") == "confirmed":
                        token = payload.get("bot_token")
                        if not isinstance(token, str) or not token:
                            raise ValueError("missing bot token")
                        self._confirm_login(generation, token)
                        return
                    if payload.get("status") in {"expired", "cancelled"}:
                        self._set_for_generation(
                            generation,
                            state="idle",
                            qr_uri="",
                            error="二维码已失效，请重新生成",
                            since="",
                        )
                        return
                except (httpx.HTTPError, TypeError, ValueError):
                    # 状态接口本身可能长轮询超时；下一轮继续等扫码确认。
                    pass
                self._sleep(1)

            self._set_for_generation(
                generation,
                state="idle",
                qr_uri="",
                error="二维码超时，请重新生成",
                since="",
            )
        finally:
            client.close()

    def _confirm_login(self, generation: int, token: str) -> bool:
        """只允许当前二维码代次写凭据并取得消息轮询所有权。"""
        with self._lock:
            if generation != self._generation:
                return False
            path = self._token_path()
            self._clear_sync_buf()
            path.write_text(token, encoding="utf-8")
            path.chmod(0o600)
            self._state.update(
                state="connected", qr_uri="", error="", since=""
            )
            self._start_updates_locked(generation, token)
            return True

    def _start_updates_locked(self, generation: int, token: str) -> None:
        self._updates_stop.set()
        stop = threading.Event()
        self._updates_stop = stop
        self._stop_dispatcher_locked()
        self._dispatcher = _ReplyDispatcher()
        worker = self._thread_factory(
            target=self._updates_loop,
            args=(generation, token, stop),
            daemon=True,
            name="jarvis-wechat-updates",
        )
        self._updates_thread = worker
        worker.start()

    def _stop_dispatcher_locked(self) -> None:
        dispatcher, self._dispatcher = self._dispatcher, None
        if dispatcher is not None:
            dispatcher.stop()

    def _reply(self, text: str, from_id: str) -> str:
        if not self._agent_getter or not self._chunk_text or not self._owner_getter:
            return "贾维斯尚未就绪。"
        owner = self._owner_getter()
        if owner is None:
            return "贾维斯账号未就绪。"
        contact = from_id.split("@", 1)[0]
        alias = "wx-" + contact[-12:]
        from jarvis.graph import heal_dangling_tool_calls
        from jarvis.tenancy import TenantStore, tenant_scope

        with tenant_scope(owner.user_id):
            store = TenantStore()
            store.migrate_legacy()
            thread = store.upsert_thread(alias, text)
            runtime = self._runtime_getter(owner.user_id) if self._runtime_getter else nullcontext(
                type("LegacyBundle", (), {"agent": self._agent_getter()})()
            )
            with runtime as bundle:
                heal_dangling_tool_calls(bundle.agent, thread.checkpoint_thread_id)
                result = bundle.agent.invoke(
                    {"messages": [{"role": "user", "content": text}]},
                    config={"configurable": {"thread_id": thread.checkpoint_thread_id}},
                )
        return self._chunk_text(result["messages"][-1].content)

    @staticmethod
    def _text_of(message: dict) -> str:
        for item in message.get("item_list", []):
            if isinstance(item, dict) and item.get("type") == 1:
                text_item = item.get("text_item", {})
                if isinstance(text_item, dict):
                    text = text_item.get("text", "")
                    return text if isinstance(text, str) else ""
        return ""

    @staticmethod
    def _split_reply(text: str, limit: int = REPLY_CHUNK_SIZE) -> list[str]:
        text = text.strip()
        if not text:
            return ["（贾维斯没有生成文本回复。）"]
        return [text[index:index + limit] for index in range(0, len(text), limit)]

    @staticmethod
    def _humanize_reply_failure(exc: Exception) -> str:
        """把技术异常翻译成人话 + 下一步建议；异常类名只进日志，不发给用户。"""
        if isinstance(exc, (httpx.TimeoutException, TimeoutError)) or (
            "timeout" in type(exc).__name__.lower()
        ):
            return "（联网检索或模型响应超时了，稍后再把这条消息发我一次。）"
        return (
            "（我这边刚才没处理成功，请稍后再试一次；"
            "如果反复失败，请让管理员在网页端检查模型与联网配置。）"
        )

    def _send_items(
        self, client, token: str, from_id: str, context_token: str, item_list: list
    ) -> None:
        """发送一条 sendmessage；协议或网络失败原样抛出，由调用方定降级策略。"""
        response = client.post(
            f"{ILINK}/sendmessage",
            headers=self._headers(token),
            timeout=20,
            json={
                "msg": {
                    "from_user_id": "",
                    "to_user_id": from_id,
                    "client_id": f"jws-agent:{uuid.uuid4().hex}",
                    "message_type": 2,
                    "message_state": 2,
                    "context_token": context_token,
                    "item_list": item_list,
                },
                "base_info": self._base_info(),
            },
        )
        response.raise_for_status()
        sent_payload = response.json()
        if (
            isinstance(sent_payload, dict)
            and sent_payload.get("ret") not in (None, 0)
        ):
            raise ValueError("send rejected")

    def _send_text_chunks(
        self, client, token: str, from_id: str, context_token: str, text: str
    ) -> None:
        """分段发送文字回复；单段失败只告警不中断后续段。"""
        for chunk in self._split_reply(text):
            try:
                self._send_items(
                    client, token, from_id, context_token,
                    [{"type": 1, "text_item": {"text": chunk}}],
                )
            except (httpx.HTTPError, TypeError, ValueError) as exc:
                log.warning(
                    "iLink sendmessage failed for %s: %s",
                    from_id[:16],
                    type(exc).__name__,
                )

    def _deliver_reply(
        self, client, token: str, from_id: str, context_token: str, text: str
    ) -> None:
        """计算并发送对一条私聊消息的回复；整段在回复工作池线程中运行。"""
        prompt = link_summary_prompt(text) or text  # 光发一条链接=让贾维斯读文总结
        try:
            answer = self._reply(prompt, from_id)
        except Exception as exc:
            log.warning("JARVIS WeChat reply failed: %s", type(exc).__name__)
            answer = self._humanize_reply_failure(exc)

        self._send_text_chunks(client, token, from_id, context_token, answer)

    def _deliver_voice_reply(
        self, client, token: str, from_id: str, context_token: str, voice_item: dict
    ) -> None:
        """收到语音：下载→解码→识别→回复（语音+文字各一条）。

        识别链路任何一环失败只回固定「没听清」提示——领导定的底线是绝不沉默。
        """
        try:
            heard = self._voice.transcribe(voice_item)
        except wechat_voice.VoiceError as exc:
            log.warning("WeChat voice transcribe failed: %s", type(exc).__name__)
            self._send_text_chunks(
                client, token, from_id, context_token, VOICE_NOT_UNDERSTOOD
            )
            return
        except Exception as exc:
            log.warning("WeChat voice transcribe crashed: %s", type(exc).__name__)
            self._send_text_chunks(
                client, token, from_id, context_token, VOICE_NOT_UNDERSTOOD
            )
            return

        try:
            answer = self._reply(heard, from_id)
        except Exception as exc:
            log.warning("JARVIS WeChat reply failed: %s", type(exc).__name__)
            answer = self._humanize_reply_failure(exc)

        self._send_voice_then_text(
            client, token, from_id, context_token, heard, answer
        )

    def _send_voice_then_text(
        self, client, token: str, from_id: str, context_token: str,
        heard: str, answer: str,
    ) -> None:
        """语音+文字各一条；发语音任一环失败→只发文字（领导定的降级策略）。"""
        try:
            items = self._voice.voice_reply_items(answer)
            self._send_items(client, token, from_id, context_token, items)
        except wechat_voice.VoiceError as exc:
            log.warning(
                "WeChat voice reply degraded to text (synthesis/encode): %s",
                type(exc).__name__,
            )
        except (httpx.HTTPError, TypeError, ValueError) as exc:
            log.warning(
                "WeChat voice reply degraded to text (send): %s", type(exc).__name__
            )
        except Exception as exc:
            log.warning(
                "WeChat voice reply degraded to text (unexpected): %s",
                type(exc).__name__,
            )
        text = f"（语音识别）你说的是：「{heard}」\n\n{answer}"
        self._send_text_chunks(client, token, from_id, context_token, text)

    def _handle_updates_response(
        self, client, token: str, payload: dict
    ) -> str:
        """处理一次 getupdates 数据并返回下一轮 buffer。

        有活动轮询会话时，私聊消息入队即返回：回复由 _ReplyDispatcher 工作池
        计算发送（同一发信人串行，不同发信人并行），长轮询线程只收发不算。
        没有会话（如直接调用协议探针）时退化为内联同步处理。
        """
        if not isinstance(payload, dict):
            raise ValueError("invalid updates response")
        next_buf = payload.get("get_updates_buf", "")
        if not isinstance(next_buf, str):
            next_buf = ""
        self._save_sync_buf(next_buf)
        messages = payload.get("msgs", [])
        if not isinstance(messages, list):
            raise ValueError("invalid messages")
        with self._lock:
            dispatcher = self._dispatcher

        for message in messages:
            if not isinstance(message, dict):
                continue
            _probe_non_text(message)
            from_id = message.get("from_user_id", "")
            if not isinstance(from_id, str) or not from_id:
                continue
            if "@im.chatroom" in from_id or "group" in from_id.lower():
                # 群聊礼貌规则：只处理文本且被 @ 的消息，其余一律沉默
                if message.get("message_type") != 1:
                    continue
                mention = group_mention_text(self._text_of(message).strip())
                if mention is None:
                    continue
                group_ctx = message.get("context_token", "")
                if dispatcher is None:
                    self._deliver_reply(client, token, from_id, group_ctx, mention)
                    continue
                accepted = dispatcher.submit(
                    from_id,
                    lambda c=client, t=token, f=from_id, ctx=group_ctx, x=mention: (
                        self._deliver_reply(c, t, f, ctx, x)
                    ),
                )
                if not accepted:
                    log.info("WeChat group reply skipped: dispatcher stopped")
                continue
            context_token = message.get("context_token", "")
            self._refresh_push_context(from_id, context_token)
            voice_item = wechat_voice.find_voice_item(message)
            if voice_item is not None:
                if dispatcher is None:
                    self._deliver_voice_reply(
                        client, token, from_id, context_token, voice_item
                    )
                    continue
                accepted = dispatcher.submit(
                    from_id,
                    lambda c=client, t=token, f=from_id, ctx=context_token,
                    v=voice_item: self._deliver_voice_reply(c, t, f, ctx, v),
                )
                if not accepted:
                    log.info("WeChat voice reply skipped: dispatcher stopped")
                continue
            if message.get("message_type") != 1:
                continue
            text = self._text_of(message).strip()
            if not text:
                continue
            if text in PUSH_BIND_COMMANDS:   # 绑定提醒推送：确定性命令，不进大模型
                self._save_push_target(from_id, context_token)
                self._send_text_chunks(client, token, from_id, context_token, PUSH_BOUND_REPLY)
                continue
            if text in PUSH_UNBIND_COMMANDS:
                self._clear_push_target()
                self._send_text_chunks(client, token, from_id, context_token, PUSH_UNBOUND_REPLY)
                continue
            if dispatcher is None:
                self._deliver_reply(client, token, from_id, context_token, text)
                continue
            accepted = dispatcher.submit(
                from_id,
                lambda c=client, t=token, f=from_id, ctx=context_token, x=text: (
                    self._deliver_reply(c, t, f, ctx, x)
                ),
            )
            if not accepted:
                log.info("WeChat reply skipped: dispatcher stopped")
        return next_buf

    def _updates_loop(
        self, generation: int, token: str, stop: threading.Event
    ) -> None:
        client = self._client_factory()
        buffer = self._load_sync_buf()
        try:
            while not stop.is_set():
                with self._lock:
                    if (
                        generation != self._generation
                        or self._state["state"] != "connected"
                    ):
                        return
                try:
                    response = client.post(
                        f"{ILINK}/getupdates",
                        headers=self._headers(token),
                        timeout=httpx.Timeout(45, read=UPDATES_READ_TIMEOUT_SECONDS),
                        json={
                            "get_updates_buf": buffer,
                            "base_info": self._base_info(),
                        },
                    )
                    if response.status_code == 401:
                        self._handle_unauthorized(generation)
                        return
                    response.raise_for_status()
                    payload = response.json()
                    ret = payload.get("ret", 0) if isinstance(payload, dict) else 0
                    errcode = payload.get("errcode", 0) if isinstance(payload, dict) else 0
                    errmsg = payload.get("errmsg", "") if isinstance(payload, dict) else ""
                    expired = ret == -14 or errcode == -14 or (
                        (ret == -2 or errcode == -2)
                        and str(errmsg).lower() == "unknown error"
                    )
                    if expired:
                        self._handle_unauthorized(generation)
                        return
                    if ret not in (None, 0) or errcode not in (None, 0):
                        raise ValueError("iLink API rejected getupdates")
                    buffer = self._handle_updates_response(
                        client, token, payload
                    )
                except httpx.TimeoutException:
                    # 空转长轮询到期是正常节奏：不告警、不退避，立即翻新请求。
                    continue
                except (httpx.HTTPError, TypeError, ValueError) as exc:
                    log.warning("iLink getupdates retry: %s", type(exc).__name__)
                    stop.wait(2)
        finally:
            client.close()

    def _handle_unauthorized(self, generation: int) -> None:
        with self._lock:
            if generation != self._generation:
                return
            self._updates_stop.set()
            self._updates_thread = None
            self._stop_dispatcher_locked()
            self._token_path().unlink(missing_ok=True)
            self._clear_sync_buf()
            self._state.update(
                state="idle",
                qr_uri="",
                error="微信登录态失效，请重新扫码",
                since="",
            )

    def disconnect(self) -> dict:
        """停止当前所有后台任务并删除微信凭据。"""
        with self._lock:
            self._generation += 1
            self._updates_stop.set()
            self._updates_thread = None
            self._stop_dispatcher_locked()
            self._token_path().unlink(missing_ok=True)
            self._clear_sync_buf()
            self._state.update(
                state="idle", qr_uri="", error="", since=""
            )
            return dict(self._state)

    def resume_on_boot(self) -> dict:
        """服务启动时复用保存的 Token，并取得消息轮询所有权。"""
        # Token ownership is fixed to the one active Owner.  Do this check before
        # opening the credential file so an ambiguous account set cannot inspect it.
        try:
            owner = self._owner_getter() if self._owner_getter else None
        except Exception:
            owner = None
        if owner is None:
            return self.status()
        path = self._token_path()
        if not path.exists():
            return self.status()
        token = path.read_text(encoding="utf-8").strip()
        if not token:
            path.unlink(missing_ok=True)
            return self.status()
        with self._lock:
            if self._state["state"] == "connected":
                return dict(self._state)
            self._generation += 1
            generation = self._generation
            self._state.update(
                state="connected", qr_uri="", error="", since=""
            )
            self._start_updates_locked(generation, token)
            return dict(self._state)

    def shutdown(self) -> None:
        """停止线程但保留 Token，供下一次服务启动恢复。"""
        with self._lock:
            self._generation += 1
            self._updates_stop.set()
            self._updates_thread = None
            self._stop_dispatcher_locked()
            self._state.update(
                state="idle", qr_uri="", error="", since=""
            )


_bridge = WeChatBridge()


def init(agent_getter, chunk_text, owner_getter=None, runtime_getter=None) -> None:
    _bridge.configure(agent_getter, chunk_text, owner_getter, runtime_getter)


def status() -> dict:
    return _bridge.status()


def connect() -> dict:
    return _bridge.connect()


def disconnect() -> dict:
    return _bridge.disconnect()


def resume_on_boot() -> dict:
    return _bridge.resume_on_boot()


def shutdown() -> None:
    _bridge.shutdown()


def push_text(text: str) -> bool:
    """主动推送文字给绑定联系人；桥未连接或未绑定时返回 False。"""
    return _bridge.push_text(text)


def push_available() -> bool:
    """推送通道是否就绪（已连接 + 已绑定 + 有凭据）。"""
    return _bridge.push_available()


def push_voice_then_text(text: str) -> bool:
    """主动推送语音条+文字（晨报电台用）；语音失败自动降级纯文字。"""
    return _bridge.push_voice_then_text(text)
