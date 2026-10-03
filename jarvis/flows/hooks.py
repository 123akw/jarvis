"""流程的消息触发与链接触发（第二十轮，归「对话与触发」代理；契约 §4.2 / §4.3）。

- 消息触发：飞书 / 微信收到的消息命中某流程设的关键词（或「收到的全部消息」）时，交给该流程跑，结果回复到原会话；
  渠道在把消息交给对话前调 :func:`handle_message`，返回回复文字表示已由流程处理，None 表示照常对话。
  群聊只在被 @ 时才会走到这里（沿用渠道现有规则）；同一账号同一渠道最多一条流程收「全部消息」。
- 链接触发：``POST /api/hooks/{token}``（公开、按令牌限流、≤256KB、最多等 30 秒否则回 202）用 JSON 输入跑流程；
  令牌只在创建 / 重置时明文给一次，库里只存 sha256；关掉或流程被删后回 410。
- 设置：``GET /api/flows/{id}/hooks``、``PUT /api/flows/{id}/hooks/message``、
  ``POST|DELETE /api/flows/{id}/hooks/webhook``。

存储在 ``tenant_flow_hooks``（schema v8）：每个流程每种触发一行（UNIQUE(owner_id, flow_id, kind)），
``config`` 存设置 JSON；删流程时这里的行不会被一并删掉（引擎的 store 不知道这张表），读取时按「流程不在了」处理。

输入映射（:func:`map_inputs` / :func:`text_inputs` / :func:`webhook_inputs`）与结果转人话（:func:`reply_text`）
也给对话里的 ``flow_run`` 工具（jarvis/tools/flows_tool.py）用。
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
import os
import re
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Any, Callable

from fastapi import Path as PathParam, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.concurrency import run_in_threadpool

from jarvis.flows.compose import RateLimiter
from jarvis.tenancy import TenantMigrationError, TenantStore, tenant_scope

log = logging.getLogger("jarvis")

FlowId = Annotated[str, PathParam(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
NOT_FOUND = "没有找到这条流程"
MIGRATION_FAILED = "个人数据迁移失败"

CHANNELS = ("feishu", "wechat")
CHANNEL_NAMES = {"feishu": "飞书", "wechat": "微信"}
MATCHES = ("keywords", "all")
MAX_KEYWORDS = 10
MAX_KEYWORD_CHARS = 20
TEXT_TYPES = ("paragraph", "text")

WEBHOOK_MAX_BYTES = 256 * 1024
WEBHOOK_RATE = 30            # 每个令牌每分钟最多几次
WEBHOOK_WINDOW = 60.0
WEBHOOK_WAIT_SECONDS = 30.0  # 最多等这么久，没跑完回 202
REPLY_TEXT_CHARS = 2000      # 回到飞书 / 微信的结果正文上限（完整的在结果网页里）
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_FILE_MARK = re.compile(r"file_id\s*[=＝:：]\s*([A-Za-z0-9_-]{8,64})")
_FILE_URL = re.compile(r"/api/files/([A-Za-z0-9_-]{8,64})")
_MARKER = re.compile(r"［附件[：:][^］]*?file_id\s*[=＝:：]\s*[A-Za-z0-9_-]{8,64}\s*］")
_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_NORM = re.compile(r"[\s\W_]+", re.UNICODE)

LINK_NOTE = "（链接要在贾维斯网页里打开，也可以到「我的流程」的运行记录里找）"
RUN_FAILED = "流程运行出了点问题，请稍后再试"

_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="jarvis-flow-hook")
limiter = RateLimiter(WEBHOOK_RATE, WEBHOOK_WINDOW)   # 链接触发：按令牌限流（内存、有界）
_runtime_getter: Callable[[], Any] | None = None


class HookError(ValueError):
    """设置不合法；message 直接给用户看。"""


class HookConflict(HookError):
    """「收到的全部消息」在同一渠道已经被另一条流程占了。"""


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _loads(raw) -> dict:
    try:
        value = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _norm(text) -> str:
    return _NORM.sub("", str(text or "")).lower()


def _current_runtime():
    if _runtime_getter is not None:
        return _runtime_getter()
    from jarvis import flows
    return flows.runtime()


# ---------- 存取 ----------

class HookStore:
    """tenant_flow_hooks 的薄封装：所有读写都带 owner_id，只有按令牌反查（公开链接）不带。"""

    def __init__(self, tenant_factory=TenantStore) -> None:
        self.tenant_factory = tenant_factory

    def _connect(self):
        return self.tenant_factory()._connect()

    @staticmethod
    def _row(row) -> dict | None:
        if row is None:
            return None
        out = {key: row[key] for key in row.keys()}
        out["config"] = _loads(row["config"])
        out["enabled"] = bool(row["enabled"])
        return out

    def get(self, owner_id: str, flow_id: str, kind: str) -> dict | None:
        with self._connect() as c:
            row = c.execute("SELECT * FROM tenant_flow_hooks WHERE owner_id=? AND flow_id=? AND kind=?",
                            (owner_id, flow_id, kind)).fetchone()
        return self._row(row)

    def summary(self, owner_id: str) -> dict[str, dict]:
        """{flow_id: {"message": bool, "webhook": bool}}：流程卡片上的触发方式小标记（只算开着的）。"""
        with self._connect() as c:
            rows = c.execute("SELECT flow_id, kind FROM tenant_flow_hooks WHERE owner_id=? AND enabled=1",
                             (owner_id,)).fetchall()
        out: dict[str, dict] = {}
        for row in rows:
            out.setdefault(row["flow_id"], {"message": False, "webhook": False})[row["kind"]] = True
        return out

    def enabled_messages(self, owner_id: str) -> list[dict]:
        """该账号开着的消息触发（连同流程名；流程已删的 flow_name 为 None）。"""
        with self._connect() as c:
            rows = c.execute("SELECT h.*, f.name AS flow_name FROM tenant_flow_hooks h LEFT JOIN tenant_flows f"
                             " ON f.owner_id=h.owner_id AND f.id=h.flow_id"
                             " WHERE h.owner_id=? AND h.kind='message' AND h.enabled=1"
                             " ORDER BY h.updated_at DESC", (owner_id,)).fetchall()
        return [self._row(r) for r in rows]

    def save_message(self, owner_id: str, flow_id: str, *, enabled: bool, config: dict) -> dict:
        """保存消息触发；开着且收「全部消息」时，同一渠道已有别的流程收全部消息就抛 :class:`HookConflict`。"""
        now = _now()
        exclusive = config["channels"] if enabled and config.get("match") == "all" else []
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                if exclusive:
                    rows = c.execute("SELECT h.config, f.name FROM tenant_flow_hooks h JOIN tenant_flows f"
                                     " ON f.owner_id=h.owner_id AND f.id=h.flow_id"
                                     " WHERE h.owner_id=? AND h.kind='message' AND h.enabled=1 AND h.flow_id<>?",
                                     (owner_id, flow_id)).fetchall()
                    for row in rows:
                        other = _loads(row["config"])
                        if other.get("match") != "all":
                            continue
                        clash = next((ch for ch in exclusive if ch in (other.get("channels") or [])), None)
                        if clash:
                            raise HookConflict(
                                f"「{row['name']}」已经在{CHANNEL_NAMES[clash]}上接收全部消息了：每个渠道只能有一条流程"
                                "收全部消息，先把那条关掉或改成关键词")
                c.execute("INSERT INTO tenant_flow_hooks(id,owner_id,flow_id,kind,config,enabled,created_at,updated_at)"
                          " VALUES(?,?,?,'message',?,?,?,?)"
                          " ON CONFLICT(owner_id, flow_id, kind) DO UPDATE SET config=excluded.config,"
                          " enabled=excluded.enabled, updated_at=excluded.updated_at",
                          (uuid.uuid4().hex[:16], owner_id, flow_id, json.dumps(config, ensure_ascii=False),
                           int(enabled), now, now))
                c.commit()
            except Exception:
                c.rollback()
                raise
        return self.get(owner_id, flow_id, "message")

    def issue_webhook(self, owner_id: str, flow_id: str, *, token_hash: str, hint: str) -> dict:
        """生成 / 重置链接令牌：旧令牌立即失效（只换 hash，不留旧的）。"""
        now = _now()
        config = json.dumps({"hint": hint, "issued_at": now}, ensure_ascii=False)
        with self._connect() as c:
            c.execute("INSERT INTO tenant_flow_hooks(id,owner_id,flow_id,kind,config,token_hash,enabled,created_at,updated_at)"
                      " VALUES(?,?,?,'webhook',?,?,1,?,?)"
                      " ON CONFLICT(owner_id, flow_id, kind) DO UPDATE SET config=excluded.config,"
                      " token_hash=excluded.token_hash, enabled=1, last_status='', updated_at=excluded.updated_at",
                      (uuid.uuid4().hex[:16], owner_id, flow_id, config, token_hash, now, now))
        return self.get(owner_id, flow_id, "webhook")

    def disable_webhook(self, owner_id: str, flow_id: str) -> dict | None:
        """关掉链接：保留令牌 hash，这样再来的调用能明确回「已关掉」（410），而不是「不存在」。"""
        with self._connect() as c:
            c.execute("UPDATE tenant_flow_hooks SET enabled=0, updated_at=? WHERE owner_id=? AND flow_id=? AND kind='webhook'",
                      (_now(), owner_id, flow_id))
        return self.get(owner_id, flow_id, "webhook")

    def by_token(self, token_hash: str) -> dict | None:
        """按令牌 hash 反查（公开链接）：连同流程名（流程删了是 None）与账号是否启用。"""
        with self._connect() as c:
            row = c.execute("SELECT h.*, f.name AS flow_name, u.active AS owner_active FROM tenant_flow_hooks h"
                            " LEFT JOIN tenant_flows f ON f.owner_id=h.owner_id AND f.id=h.flow_id"
                            " LEFT JOIN users u ON u.id=h.owner_id"
                            " WHERE h.token_hash=? AND h.kind='webhook'", (token_hash,)).fetchone()
        return self._row(row)

    def hit(self, hook_id: str, status: str) -> None:
        with self._connect() as c:
            c.execute("UPDATE tenant_flow_hooks SET last_hit_at=?, last_status=? WHERE id=?", (_now(), status, hook_id))

    def set_status(self, hook_id: str, status: str) -> None:
        with self._connect() as c:
            c.execute("UPDATE tenant_flow_hooks SET last_status=? WHERE id=?", (status, hook_id))

    def delete(self, hook_id: str) -> None:
        with self._connect() as c:
            c.execute("DELETE FROM tenant_flow_hooks WHERE id=?", (hook_id,))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ---------- 流程的开始字段与输入映射 ----------

def start_fields(graph: dict | None) -> list[dict]:
    for node in (graph or {}).get("nodes") or []:
        if isinstance(node, dict) and node.get("id") == "start":
            fields = (node.get("data") or {}).get("fields") or []
            return [f for f in fields if isinstance(f, dict) and isinstance(f.get("key"), str)]
    return []


def default_field(fields: list[dict]) -> str:
    """消息文字默认填进哪个输入：第一个长文字输入（消息多是一段话），再是第一个文字输入，都没有就第一个输入。"""
    for kinds in (("paragraph",), TEXT_TYPES):
        for field in fields:
            if field.get("type") in kinds:
                return field["key"]
    return fields[0]["key"] if fields else ""


def file_ref(value) -> str | None:
    """值里认得出的文件空间文件：{file_id}、附件标记 / file_id=XXX、站内下载链接。"""
    if isinstance(value, dict):
        value = value.get("file_id")
        return value if isinstance(value, str) and _FILE_ID.match(value) else None
    if not isinstance(value, str):
        return None
    found = _FILE_MARK.search(value) or _FILE_URL.search(value)
    return found.group(1) if found else None


def file_refs(text: str) -> list[str]:
    out: list[str] = []
    for match in _FILE_MARK.finditer(str(text or "")):
        if match.group(1) not in out:
            out.append(match.group(1))
    return out


def strip_markers(text: str) -> str:
    cleaned = _MARKER.sub(" ", str(text or ""))
    cleaned = _FILE_MARK.sub(" ", cleaned)
    return re.sub(r"[ \t]{2,}", " ", cleaned).strip()


def match_field(fields: list[dict], name) -> dict | None:
    """输入名 → 开始字段：内部名、标签完全一致优先，再按标签互相包含（只认唯一的那个）。"""
    raw = str(name or "").strip()
    if not raw:
        return None
    for field in fields:
        if field["key"] == raw:
            return field
    wanted = _norm(raw)
    if not wanted:
        return None
    for field in fields:
        if _norm(field.get("label")) == wanted or _norm(field["key"]) == wanted:
            return field
    loose = [f for f in fields
             if (label := _norm(f.get("label"))) and len(wanted) >= 2 and (wanted in label or label in wanted)]
    return loose[0] if len(loose) == 1 else None


def _select_value(field: dict, value: str) -> str:
    options = [str(o) for o in field.get("options") or []]
    text = " ".join(value.split())
    if not options or text in options:
        return text
    wanted = _norm(text)
    loose = [o for o in options if _norm(o) and (_norm(o) in wanted or wanted in _norm(o))]
    return loose[0] if len(loose) == 1 else text


def coerce_value(field: dict, value):
    """一个值按字段类型规整：文件字段认文件空间的文件，选项字段宽松对上选项，其他转成文字或数字。"""
    if value is None:
        return None
    if field.get("type") == "file":
        found = file_ref(value)
        if found:
            return {"file_id": found}
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    value = str(value)
    if field.get("type") == "select":
        return _select_value(field, value)
    return value


def text_inputs(fields: list[dict], text: str, *, attachments=(), into: str = "") -> tuple[dict, list[str]]:
    """一段文字 → 开始字段：附件标记 / attachments 依次填文件字段，其余文字填 ``into``（默认第一个文字输入）。"""
    inputs: dict = {}
    notes: list[str] = []
    files = [ref for ref in (file_ref(a) or (a if isinstance(a, str) and _FILE_ID.match(a) else None)
                             for a in attachments or ()) if ref]
    files += [ref for ref in file_refs(text) if ref not in files]
    body = strip_markers(text) if files else str(text or "").strip()
    target = next((f for f in fields if f["key"] == into), None) if into else None
    if target is not None and target.get("type") == "file" and files:
        inputs[target["key"]] = {"file_id": files.pop(0)}
        target = None if not body else next((f for f in fields if f.get("type") in TEXT_TYPES), None)
    for field in fields:
        if not files:
            break
        if field.get("type") == "file" and field["key"] not in inputs:
            inputs[field["key"]] = {"file_id": files.pop(0)}
    if files:
        notes.append("这条流程没有更多的文件输入，多出来的附件没用上")
    if body:
        if target is None or target["key"] in inputs:
            target = (next((f for f in fields if f.get("type") in TEXT_TYPES and f["key"] not in inputs), None)
                      or next((f for f in fields if f.get("type") != "file" and f["key"] not in inputs), None)
                      or next((f for f in fields if f["key"] not in inputs), None))
        if target is None:
            notes.append("这条流程不需要填文字，给的内容没用上")
        else:
            inputs[target["key"]] = coerce_value(target, body)
    return inputs, notes


def map_inputs(fields: list[dict], raw, *, attachments=(), guess: bool = True) -> tuple[dict, list[str], list[str]]:
    """``{字段名或标签: 值}`` 或一段文字 → (inputs, 提示, 对不上的键)。

    ``guess``：只剩一个对不上的键、也只剩一个空着的文字输入时，把它填进去（对话里模型常随口起名）；
    链接触发要按契约「对不上就整段转文字」，不猜。"""
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                parsed = json.loads(stripped)
            except ValueError:
                parsed = None
            if isinstance(parsed, dict):
                raw = parsed
    if raw is None or raw == "" or raw == {}:
        if not attachments:
            return {}, [], []
        inputs, notes = text_inputs(fields, "", attachments=attachments)
        return inputs, notes, []
    if not isinstance(raw, dict):
        inputs, notes = text_inputs(fields, raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False),
                                    attachments=attachments)
        return inputs, notes, []
    inputs: dict = {}
    unmatched: list[tuple[str, Any]] = []
    for key, value in raw.items():
        field = match_field(fields, key)
        if field is None or field["key"] in inputs:
            unmatched.append((str(key), value))
            continue
        coerced = coerce_value(field, value)
        if coerced not in (None, ""):
            inputs[field["key"]] = coerced
    # 只剩一个对不上的键、也只剩一个空着的文字输入：多半就是它（模型常把「内容」「主题」随口起名）
    free = [f for f in fields if f.get("type") in TEXT_TYPES and f["key"] not in inputs]
    if guess and len(unmatched) == 1 and len(free) == 1 and isinstance(unmatched[0][1], (str, int, float)):
        inputs[free[0]["key"]] = coerce_value(free[0], unmatched[0][1])
        unmatched = []
    notes: list[str] = []
    for ref in attachments or ():
        fid = file_ref(ref) or (ref if isinstance(ref, str) and _FILE_ID.match(ref) else None)
        slot = next((f for f in fields if f.get("type") == "file" and f["key"] not in inputs), None)
        if fid and slot is not None:
            inputs[slot["key"]] = {"file_id": fid}
    return inputs, notes, [key for key, _value in unmatched]


def webhook_inputs(fields: list[dict], body) -> dict:
    """链接触发的 JSON → 开始字段：``{inputs: {...}}`` 按字段填；任意 JSON 顶层键能对上字段就按字段填，
    一个都对不上就整段转文字填第一个文字输入。"""
    if body is None or body == {} or body == "":
        return {}
    if isinstance(body, dict) and set(body) == {"inputs"} and isinstance(body["inputs"], dict):
        return map_inputs(fields, body["inputs"], guess=False)[0]
    if isinstance(body, dict):
        inputs, _notes, unmatched = map_inputs(fields, body, guess=False)
        if inputs and len(unmatched) < len(body):
            return inputs
        return text_inputs(fields, json.dumps(body, ensure_ascii=False, indent=2))[0]
    if isinstance(body, str):
        return text_inputs(fields, body)[0]
    return text_inputs(fields, json.dumps(body, ensure_ascii=False, indent=2))[0]


def missing_required(fields: list[dict], inputs: dict) -> list[dict]:
    """开跑前就知道缺的必填项（没填、也没有默认值）。"""
    return [f for f in fields
            if f.get("required") and inputs.get(f["key"]) in (None, "") and f.get("default") in (None, "")]


# ---------- 结果转人话 ----------

def public_base() -> str:
    base = os.getenv("JARVIS_PUBLIC_URL", "").strip().rstrip("/")
    return base if base.startswith(("http://", "https://")) else ""


def absolute(url: str, base: str = "") -> str:
    """站内地址 → 绝对地址（JARVIS_PUBLIC_URL 优先，再用 base）；拼不出来原样返回。"""
    url = str(url or "")
    if not url or url.startswith(("http://", "https://")):
        return url
    root = public_base() or (base.rstrip("/") if base.startswith(("http://", "https://")) else "")
    return f"{root}{url}" if root and url.startswith("/") else url


def result_links(output: dict | None, base: str = "") -> list[dict]:
    """结果里的链接（结果网页、生成的文件、飞书文档…）去重后转成绝对地址（能转的话）。"""
    output = output if isinstance(output, dict) else {}
    links, seen = [], set()
    page = output.get("page_url")
    raw = list(output.get("links") or [])
    if page and not any(isinstance(x, dict) and x.get("url") == page for x in raw):
        raw.insert(0, {"label": "结果网页", "url": page})
    for link in raw:
        if not isinstance(link, dict) or not isinstance(link.get("url"), str) or link["url"] in seen:
            continue
        seen.add(link["url"])
        links.append({"label": str(link.get("label") or "链接")[:40], "url": absolute(link["url"], base)})
    return links


def approval_link(result: dict, base: str = "") -> tuple[str, str]:
    approval = result.get("approval") if isinstance(result.get("approval"), dict) else {}
    url = approval.get("url") or (f"/approve/{approval['id']}" if approval.get("id") else "")
    return absolute(url, base), str(approval.get("expires_at") or "")


def expires_label(value: str) -> str:
    try:
        moment = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return ""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.timezone.utc)
    local = moment.astimezone()
    return f"{local.month}月{local.day}日 {local:%H:%M}"


def reply_text(flow_name: str, result: dict, *, base: str = "") -> str:
    """飞书 / 微信里回给发消息的人：结果 + 链接；等确认、没开跑、没跑成都说人话。"""
    name = flow_name or "流程"
    status = result.get("status")
    error = str(result.get("error") or "").strip()
    if status == "waiting":
        url, expires = approval_link(result, base)
        when = expires_label(expires)
        lines = [f"「{name}」有一步等你确认" + (f"：{url}" if url else "，到贾维斯网页的「我的流程」里确认")]
        lines.append("确认后会接着跑完" + (f"（{when} 前有效）" if when else "") + "。")
        if url.startswith("/"):
            lines.append(LINK_NOTE)
        return "\n".join(lines)
    if status == "quota":
        return error or "今天的流程运行次数到上限了，明天再来，或请管理员调高"
    if status == "busy":
        return f"「{name}」这次没开跑：{error or '你有一条流程正在运行，等它跑完再试'}"
    if status != "ok":
        return f"「{name}」这次没跑成：{error or '流程出错了'}\n打开贾维斯网页的「我的流程」看看是哪一步出了问题。"
    from jarvis.flows.steps import plain_text
    output = result.get("output") if isinstance(result.get("output"), dict) else {}
    body = plain_text(output.get("text") or "").strip()
    links = result_links(output, base)
    if len(body) > REPLY_TEXT_CHARS:
        body = body[: REPLY_TEXT_CHARS - 1] + "…" + ("（完整结果见结果网页）" if output.get("page_url") else "")
    parts = [f"「{name}」跑完了" + ("：" if body else "。")]
    if body:
        parts.append(body)
    if links:
        parts.append("\n".join(f"{link['label']}：{link['url']}" for link in links))
        if any(link["url"].startswith("/") for link in links):
            parts.append(LINK_NOTE)
    return "\n\n".join(parts)


# ---------- 消息触发 ----------

def _keyword_score(config: dict, text: str) -> int:
    """命中的最长关键词长度；「全部消息」记 0；没命中 -1。"""
    if config.get("match") == "all":
        return 0
    lowered = text.lower()
    hits = [len(k) for k in config.get("keywords") or [] if isinstance(k, str) and k and k.lower() in lowered]
    return max(hits) if hits else -1


def pick_hook(hooks: list[dict], channel: str, text: str) -> list[dict]:
    """该渠道命中的消息触发，按优先级排好：关键词（越长越优先）先于「全部消息」，同分取最近改过的。"""
    scored = []
    for hook in hooks:
        config = hook.get("config") or {}
        if not hook.get("enabled") or channel not in (config.get("channels") or []):
            continue
        score = _keyword_score(config, text)
        if score >= 0:
            scored.append((score, hook.get("updated_at") or "", hook))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [hook for _score, _at, hook in scored]


def _run_headless(runtime, user_id: str, flow_id: str, inputs: dict, source: str) -> dict:
    try:
        result = runtime.run_headless(user_id, flow_id, inputs, source=source)
    except Exception as exc:
        log.exception("flow hook run failed: %s", type(exc).__name__)
        return {"status": "error", "run_id": None, "output": None, "error": RUN_FAILED}
    return result if isinstance(result, dict) else {"status": "error", "run_id": None, "output": None,
                                                    "error": RUN_FAILED}


def handle_message(user_id: str, channel: str, text: str, *, attachments=None,
                   on_start: Callable[[str], None] | None = None) -> str | None:
    """渠道消息先问一下这里：命中消息触发就跑流程并返回要回复的文字；没命中返回 None（照常对话）。

    ``attachments``：消息带的文件（附件标记、file_id 或 {file_id}），依次填进流程的文件输入；
    ``on_start(流程名)``：命中、开跑前调一下（渠道借此显示「正在处理」）。"""
    text = str(text or "").strip()
    if channel not in CHANNELS or not user_id or (not text and not attachments):
        return None
    store = HookStore()
    try:
        with tenant_scope(user_id):
            ordered = pick_hook(store.enabled_messages(user_id), channel, text)
            if not ordered:
                return None
            runtime = _current_runtime()
            if runtime is None:
                return None
            flows = runtime.store()
            hook = flow = None
            for candidate in ordered:
                flow = flows.get_flow(user_id, candidate["flow_id"])
                if flow is not None:
                    hook = candidate
                    break
                store.delete(candidate["id"])   # 流程已经删了：这条触发跟着清掉
            if hook is None:
                return None
    except Exception as exc:   # 查不了触发设置就照常对话，绝不吞消息
        log.warning("flow message hook lookup failed: %s", type(exc).__name__)
        return None
    fields = start_fields(flow.get("graph"))
    into = hook["config"].get("input_field") or ""
    if into not in {f["key"] for f in fields}:
        into = default_field(fields)
    inputs, _notes = text_inputs(fields, text, attachments=attachments or (), into=into)
    if on_start is not None:
        try:
            on_start(flow["name"])
        except Exception as exc:
            log.warning("flow message hook on_start failed: %s", type(exc).__name__)
    result = _run_headless(runtime, user_id, flow["id"], inputs, "message")
    try:
        store.hit(hook["id"], str(result.get("status") or "error"))
    except Exception as exc:
        log.warning("flow message hook hit record failed: %s", type(exc).__name__)
    return reply_text(flow["name"], result)


# ---------- 设置接口与链接触发 ----------

def _bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise HookError("开关的值不对，刷新页面后再试")


def _keywords(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = re.split(r"[,，、;；\n]+", raw)
    if not isinstance(raw, list):
        raise HookError("关键词的格式不对，刷新页面后再试")
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, (str, int, float)) or isinstance(item, bool):
            raise HookError("关键词的格式不对，刷新页面后再试")
        word = " ".join(str(item).split())
        if not word:
            continue
        if len(word) > MAX_KEYWORD_CHARS:
            raise HookError(f"每个关键词最多 {MAX_KEYWORD_CHARS} 个字：「{word[:MAX_KEYWORD_CHARS]}…」删短一些")
        if word.lower() not in seen:
            seen.add(word.lower())
            out.append(word)
    if len(out) > MAX_KEYWORDS:
        raise HookError(f"关键词最多 {MAX_KEYWORDS} 个，删掉几个")
    return out


def normalize_message(body: dict, fields: list[dict], previous: dict | None) -> tuple[bool, dict]:
    """PUT 的消息触发设置 → (enabled, config)；没给的项沿用上次的。关掉时不强求渠道与关键词。"""
    prev = (previous or {}).get("config") or {}
    enabled = _bool(body.get("enabled"), bool(previous["enabled"]) if previous else True)
    channels = body.get("channels") if body.get("channels") is not None else prev.get("channels") or []
    if not isinstance(channels, list) or any(c not in CHANNELS for c in channels):
        raise HookError("渠道只能选飞书或微信")
    channels = [c for c in CHANNELS if c in channels]
    match = body.get("match") if body.get("match") is not None else prev.get("match") or "keywords"
    if match not in MATCHES:
        raise HookError("触发条件只能选「收到的全部消息」或「包含关键词」")
    keywords = _keywords(body.get("keywords")) if body.get("keywords") is not None else list(prev.get("keywords") or [])
    keys = {f["key"] for f in fields}
    into = body.get("input_field")
    if into not in (None, ""):
        if not isinstance(into, str) or into not in keys:
            raise HookError("「消息填进哪个输入」要选这条流程开始节点里的一个输入")
    else:
        into = prev.get("input_field") if prev.get("input_field") in keys else default_field(fields)
    if enabled and not channels:
        raise HookError("至少选一个渠道：飞书或微信")
    if enabled and match == "keywords" and not keywords:
        raise HookError("至少填一个关键词，或者改成「收到的全部消息」")
    return enabled, {"channels": channels, "match": match, "keywords": keywords, "input_field": into or ""}


def message_view(row: dict | None) -> dict | None:
    if row is None:
        return None
    config = row.get("config") or {}
    return {"enabled": bool(row["enabled"]), "channels": list(config.get("channels") or []),
            "match": config.get("match") or "keywords", "keywords": list(config.get("keywords") or []),
            "input_field": config.get("input_field") or "", "last_hit_at": row.get("last_hit_at"),
            "last_status": row.get("last_status") or ""}


def webhook_view(row: dict | None) -> dict | None:
    if row is None:
        return None
    config = row.get("config") or {}
    hint = str(config.get("hint") or "")
    return {"enabled": bool(row["enabled"]), "created_at": config.get("issued_at") or row.get("created_at"),
            "last_hit_at": row.get("last_hit_at"), "last_status": row.get("last_status") or "",
            "url_hint": f"/api/hooks/{hint}…" if hint else ""}


def _wechat_connected() -> bool:
    try:
        from jarvis import wechat
        return wechat.status().get("state") == "connected"
    except Exception:
        return False


def channel_status(user_id: str, deps) -> dict:
    """消息触发的渠道状态：飞书看这个账号绑没绑；微信只连着管理员账号，且要连上。"""
    def safe(fn, *args) -> bool:
        try:
            return bool(fn(*args)) if fn is not None else False
        except Exception:
            return False

    feishu = safe(getattr(deps, "feishu_ready", None), user_id)
    owner = safe(getattr(deps, "wechat_owner", None), user_id)
    connected = owner and _wechat_connected()
    wechat_reason = ("" if connected else "微信还没连上，先到设置里扫码连接" if owner
                     else "微信只连着管理员账号，这个账号收不到微信消息")
    return {"feishu": {"ready": feishu, "reason": "" if feishu else "还没绑定飞书，先到设置里绑定"},
            "wechat": {"ready": connected, "reason": wechat_reason}}


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: object = None
    channels: object = None
    match: object = None
    keywords: object = None
    input_field: object = None


def _no_store(payload, status_code: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store", **(headers or {})})


def _running_run_id(owner_id: str, flow_id: str) -> str | None:
    """还在跑的那次运行的 id（同一账号同时只跑一条，最近一条 running 就是它）。"""
    try:
        with TenantStore()._connect() as c:
            row = c.execute("SELECT id FROM tenant_flow_runs WHERE owner_id=? AND flow_id=? AND status='running'"
                            " ORDER BY started_at DESC, rowid DESC LIMIT 1", (owner_id, flow_id)).fetchone()
    except Exception:
        return None
    return row["id"] if row else None


def register(app, *, request_principal, panel_write, deny, runtime) -> None:
    """注册触发设置与公开链接路由（在 /api/flows/{flow_id} 之前注册）。"""
    global _runtime_getter
    _runtime_getter = runtime
    store = HookStore()

    def current():
        found = runtime() if runtime is not None else None
        if found is None:
            raise TenantMigrationError("flow runtime is not ready")
        return found

    def load_flow(user_id: str, flow_id: str) -> dict | None:
        return current().store().get_flow(user_id, flow_id)

    def payload(user_id: str, flow_id: str) -> dict:
        return {"message": message_view(store.get(user_id, flow_id, "message")),
                "webhook": webhook_view(store.get(user_id, flow_id, "webhook")),
                "channels": channel_status(user_id, getattr(current(), "deps", None))}

    @app.get("/api/flows/{flow_id}/hooks")
    def flow_hooks_get(request: Request, flow_id: FlowId):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                if load_flow(principal.user_id, flow_id) is None:
                    return _no_store({"error": NOT_FOUND}, 404)
                return _no_store(payload(principal.user_id, flow_id))
        except TenantMigrationError:
            return _no_store({"error": MIGRATION_FAILED}, 503)

    @app.put("/api/flows/{flow_id}/hooks/message")
    def flow_hooks_message(request: Request, flow_id: FlowId, body: MessageIn):
        principal, err = panel_write(request)
        if err:
            return err
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                flow = load_flow(user_id, flow_id)
                if flow is None:
                    return _no_store({"error": NOT_FOUND}, 404)
                try:
                    enabled, config = normalize_message(body.model_dump(), start_fields(flow.get("graph")),
                                                        store.get(user_id, flow_id, "message"))
                    store.save_message(user_id, flow_id, enabled=enabled, config=config)
                except HookConflict as exc:
                    return _no_store({"error": str(exc)}, 409)
                except HookError as exc:
                    return _no_store({"error": str(exc)}, 400)
                return _no_store(payload(user_id, flow_id))
        except TenantMigrationError:
            return _no_store({"error": MIGRATION_FAILED}, 503)

    @app.post("/api/flows/{flow_id}/hooks/webhook")
    def flow_hooks_webhook_issue(request: Request, flow_id: FlowId):
        principal, err = panel_write(request)
        if err:
            return err
        user_id = principal.user_id
        token = secrets.token_urlsafe(24)
        try:
            with tenant_scope(user_id):
                if load_flow(user_id, flow_id) is None:
                    return _no_store({"error": NOT_FOUND}, 404)
                row = store.issue_webhook(user_id, flow_id, token_hash=token_hash(token), hint=token[:6])
        except TenantMigrationError:
            return _no_store({"error": MIGRATION_FAILED}, 503)
        try:
            from jarvis.platforms import public_base_url
            base = public_base_url(request)
        except Exception:
            base = ""
        return _no_store({"webhook": webhook_view(row), "url": f"{base}/api/hooks/{token}"})

    @app.delete("/api/flows/{flow_id}/hooks/webhook")
    def flow_hooks_webhook_close(request: Request, flow_id: FlowId):
        principal, err = panel_write(request)
        if err:
            return err
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                if load_flow(user_id, flow_id) is None:
                    return _no_store({"error": NOT_FOUND}, 404)
                row = store.disable_webhook(user_id, flow_id)
        except TenantMigrationError:
            return _no_store({"error": MIGRATION_FAILED}, 503)
        return _no_store({"webhook": webhook_view(row)})

    async def read_body(request: Request) -> bytes | None:
        """最多读 WEBHOOK_MAX_BYTES；超了返回 None。"""
        try:
            declared = int(request.headers.get("content-length") or 0)
        except ValueError:
            declared = 0
        if declared > WEBHOOK_MAX_BYTES:
            return None
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > WEBHOOK_MAX_BYTES:
                return None
            chunks.append(chunk)
        return b"".join(chunks)

    def finish_status(hook_id: str):
        def done(future) -> None:
            try:
                result = future.result()
                status = str(result.get("status") or "error") if isinstance(result, dict) else "error"
            except Exception:
                status = "error"
            try:
                store.set_status(hook_id, status)
            except Exception as exc:
                log.warning("flow webhook status record failed: %s", type(exc).__name__)
        return done

    @app.post("/api/hooks/{token}")
    async def flow_webhook_hit(token: str, request: Request):
        missing = _no_store({"error": "这个链接不存在：检查一下地址，或到流程的「触发方式」里重新生成"}, 404)
        if not _TOKEN.match(token):
            return missing
        digest = token_hash(token)
        try:
            hook = await run_in_threadpool(store.by_token, digest)
        except TenantMigrationError:
            return _no_store({"error": "服务暂时不可用，请稍后再试"}, 503)
        if hook is None:
            return missing
        if not hook["enabled"]:
            return _no_store({"error": "这个链接已经关掉了：到流程的「触发方式」里重新生成"}, 410)
        if hook.get("flow_name") is None:
            return _no_store({"error": "这条流程已经删掉了，链接随之失效"}, 410)
        if not hook.get("owner_active"):
            return _no_store({"error": "这个链接所属的账号已停用"}, 410)
        wait = limiter.hit(digest)
        if wait is not None:
            return _no_store({"error": f"调用太频繁了：每个链接每分钟最多 {WEBHOOK_RATE} 次，歇一会儿再试"}, 429,
                             {"Retry-After": str(wait)})
        raw = await read_body(request)
        if raw is None:
            return _no_store({"error": f"内容太大了：最多 {WEBHOOK_MAX_BYTES // 1024}KB"}, 413)
        try:
            body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
        except (UnicodeDecodeError, ValueError):
            return _no_store({"error": '请求内容要是 JSON，比如 {"inputs": {"城市": "上海"}}'}, 400)
        owner_id, flow_id = hook["owner_id"], hook["flow_id"]
        try:
            rt = current()

            def load():
                with tenant_scope(owner_id):
                    return rt.store().get_flow(owner_id, flow_id)
            flow = await run_in_threadpool(load)
        except TenantMigrationError:
            return _no_store({"error": "服务暂时不可用，请稍后再试"}, 503)
        if flow is None:
            return _no_store({"error": "这条流程已经删掉了，链接随之失效"}, 410)
        inputs = webhook_inputs(start_fields(flow.get("graph")), body)
        await run_in_threadpool(store.hit, hook["id"], "running")
        future = _POOL.submit(_run_headless, rt, owner_id, flow_id, inputs, "webhook")
        future.add_done_callback(finish_status(hook["id"]))
        try:
            result = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(future)), WEBHOOK_WAIT_SECONDS)
        except asyncio.TimeoutError:
            run_id = await run_in_threadpool(_running_run_id, owner_id, flow_id)
            return _no_store({"status": "running", "run_id": run_id}, 202)
        try:
            from jarvis.platforms import public_base_url
            base = public_base_url(request)
        except Exception:
            base = ""
        status = result.get("status") or "error"
        output = result.get("output") if isinstance(result.get("output"), dict) else None
        reply: dict = {"status": status, "run_id": result.get("run_id"), "output": None}
        if output is not None:
            links = result_links(output, base)
            reply["output"] = {"text": str(output.get("text") or ""), "links": links,
                               "page_url": absolute(output.get("page_url") or "", base) or None}
        if status != "ok" and result.get("error"):
            reply["error"] = str(result["error"])
        if status == "waiting":
            url, expires = approval_link(result, base)
            approval = result.get("approval") if isinstance(result.get("approval"), dict) else {}
            reply["approval"] = {"id": approval.get("id"), "url": url, "expires_at": expires or None}
        code = {"busy": 409, "quota": 429}.get(status, 200)
        return _no_store(reply, code)
