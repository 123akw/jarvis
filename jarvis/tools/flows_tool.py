"""对话里跑流程（第二十轮，契约 §4.1）：``flow_list`` 列出我的流程，``flow_run`` 按名字跑一条。

- 只看当前账号（tenant scope）的流程；智能体账号也有这两个工具（在 BASE_TOOLS 里）；
- 名字模糊匹配：完全一致 > 互相包含 > 相似度；几条一样像就让模型先问清，不替领导挑；
- 输入可以是 ``{输入名或标签: 值}`` 或一段文字（填第一个文字输入）；文件输入认对话里的附件标记
  「［附件：文件名 · file_id=XXX］」（引擎按 file_id 从文件空间取，不重复存）；
- 运行走 ``FlowRuntime.run_headless(..., source="chat")``，最多等 CHAT_WAIT_SECONDS，再久就告诉领导去运行记录里看；
- 结果给人话 + 结果网页 / 生成文件链接：配了 JARVIS_PUBLIC_URL 用绝对地址；没配时网页里相对地址照样能点，
  飞书 / 微信里的对话（会话别名 fs- / wx-）注明「要在贾维斯网页里打开」；
- 没跑成（找不到、正忙、到配额、出错）用 :func:`jarvis.tools.failure.fail` 标记。
"""
from __future__ import annotations

import difflib
import logging
import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from jarvis.tenancy import TenantStore, current_owner_id
from jarvis.tools.failure import fail

log = logging.getLogger(__name__)

MAX_LIST = 20
CHAT_WAIT_SECONDS = 120.0
RESULT_CHARS = 3000
BUSY = "你有一条流程正在运行，等它跑完再试"
UNAVAILABLE = "流程功能暂时不可用，请稍后再试"
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="jarvis-flow-chat")
_QUOTES = re.compile(r"[「」『』“”\"'《》【】]")
_NORM = re.compile(r"[\s\W_]+", re.UNICODE)
_TYPE_HINTS = {"file": "文件", "number": "数字", "paragraph": "长文字", "text": "文字"}
# 对话里工具芯片的中文名（server._tool_label 带给前端；飞书进度提示见 channels/feishu/bridge.TOOL_LABELS）
TOOL_LABELS = {"flow_run": {"icon": "▶️", "name": "运行流程"}, "flow_list": {"icon": "🔀", "name": "我的流程"}}


def _runtime():
    try:
        from jarvis import flows
    except Exception as exc:   # 流程模块不在（拆分部署）：工具照样能回人话
        log.warning("flow runtime import failed: %s", type(exc).__name__)
        return None
    return flows.runtime()


def _hooks():
    from jarvis.flows import hooks
    return hooks


# ---------- 名字匹配 ----------

def _clean_name(name) -> str:
    text = _QUOTES.sub("", str(name or "")).strip()
    plain = _NORM.sub("", text).lower()
    trimmed = re.sub(r"^我的", "", plain)
    trimmed = re.sub(r"(这个|这条)?流程$", "", trimmed)
    return trimmed or plain


def find_flows(flows: list[dict], name: str) -> tuple[dict | None, list[dict]]:
    """(选中的流程, 候选)：选中为 None 且候选不止一条时要先问清；都为空是没找到。"""
    wanted = _clean_name(name)
    if not wanted or not flows:
        return None, []
    names = [(flow, _clean_name(flow["name"])) for flow in flows]
    exact = [flow for flow, clean in names if clean == wanted]
    if exact:
        return (exact[0] if len(exact) == 1 else None), exact
    contains = [flow for flow, clean in names if clean and (wanted in clean or (len(clean) >= 2 and clean in wanted))]
    if contains:
        return (contains[0] if len(contains) == 1 else None), contains
    scored = sorted(((difflib.SequenceMatcher(None, wanted, clean).ratio(), index, flow)
                     for index, (flow, clean) in enumerate(names) if clean), key=lambda x: (-x[0], x[1]))
    close = [(ratio, flow) for ratio, _index, flow in scored if ratio >= 0.5]
    if not close:
        return None, []
    if len(close) == 1 or close[0][0] - close[1][0] >= 0.2:
        return close[0][1], [close[0][1]]
    return None, [flow for _ratio, flow in close]


def _names(flows: list[dict], limit: int = 8) -> str:
    shown = "、".join(f"「{flow['name']}」" for flow in flows[:limit])
    return shown + (f" 等 {len(flows)} 条" if len(flows) > limit else "")


# ---------- 输入说明 ----------

def _field_desc(field: dict) -> str:
    label = field.get("label") or field["key"]
    kind = field.get("type")
    if kind == "select":
        hint = "选：" + "/".join(str(o) for o in (field.get("options") or [])[:8])
    else:
        hint = _TYPE_HINTS.get(kind, "文字")
    extra = "，必填" if field.get("required") else ""
    if field.get("default") not in (None, ""):
        extra += f"，默认 {field['default']}"
    return f"{label}（{hint}{extra}）"


# ---------- 链接 ----------

def _channel(owner_id: str, config: RunnableConfig | None) -> str:
    """这轮对话来自哪个渠道：飞书（fs-*）/ 微信（wx-*）/ 其他（网页、桌面、语音）。"""
    checkpoint = ((config or {}).get("configurable") or {}).get("thread_id")
    if not checkpoint:
        return ""
    try:
        with TenantStore()._connect() as c:
            row = c.execute("SELECT alias FROM tenant_threads WHERE owner_id=? AND checkpoint_thread_id=?",
                            (owner_id, str(checkpoint))).fetchone()
    except Exception:
        return ""
    alias = row["alias"] if row else ""
    return "feishu" if alias.startswith("fs-") else "wechat" if alias.startswith("wx-") else ""


def _result_text(flow_name: str, result: dict, *, external: bool) -> str:
    hooks = _hooks()
    status = result.get("status")
    error = str(result.get("error") or "").strip()
    if status == "waiting":
        url, expires = hooks.approval_link(result)
        when = hooks.expires_label(expires)
        text = (f"流程「{flow_name}」停在「发送前确认」这一步，已经发给领导确认了"
                + (f"：[去确认]({url})" if url else "，在「我的流程」顶部的「等你确认」里")
                + (f"（{when} 前有效）" if when else "") + "。告诉领导确认后会接着跑完，链接原样给出。")
        if url.startswith("/") and external:
            text += "这个链接要在贾维斯网页里打开，照实说。"
        return text
    if status == "quota":
        message = error or "今天的流程运行次数到上限了，明天再来，或请管理员调高"
        return fail(f"流程「{flow_name}」没开跑：{message}。如实告诉领导，不要重试。", message)
    if status == "busy":
        return fail(f"流程「{flow_name}」没开跑：{error or BUSY}。告诉领导等那条跑完再说，不要马上重试。", error or BUSY)
    if status != "ok":
        message = error or "流程出错了"
        return fail(f"流程「{flow_name}」没跑成：{message}。用人话告诉领导是哪一步、怎么了、怎么改；不要用同样的输入马上重试。",
                    f"「{flow_name}」没跑成：{message}")
    output = result.get("output") if isinstance(result.get("output"), dict) else {}
    body = str(output.get("text") or "").strip()
    if len(body) > RESULT_CHARS:
        body = body[: RESULT_CHARS - 1] + "…（后面还有，完整的在结果网页里）"
    links = hooks.result_links(output)
    lines = [f"流程「{flow_name}」跑完了。"]
    lines.append(f"结果：\n{body}" if body else "这条流程没有文字结果。")
    if links:
        lines.append("链接（原样给领导，不要改地址）：\n" + "\n".join(f"- [{x['label']}]({x['url']})" for x in links))
        if external and any(x["url"].startswith("/") for x in links):
            lines.append("这些链接要在贾维斯网页里打开（也能在「我的流程」的运行记录里找到），转告时说清楚。")
    lines.append("把结果消化成人话转告领导，别贴原始格式。")
    return "\n\n".join(lines)


# ---------- 工具 ----------

class FlowRunArgs(BaseModel):
    name: str = Field(description="要跑的流程名字，按领导的原话，如「早报」「周报整理」；不用一字不差")
    inputs: dict[str, Any] | str | None = Field(
        default=None,
        description="流程要填的输入：{输入名: 值}（输入名用 flow_list 里列出的），或直接一段文字（填进第一个文字输入）；"
                    "文件输入把消息里的「［附件：文件名 · file_id=…］」原样放进去；不用填就不传")


@tool
def flow_list() -> str:
    """列出领导自己的流程（名字、做什么、要填什么、有没有定时），最多 20 条。
    领导问「我有哪些流程」，或要跑流程但拿不准名字、不知道要填什么时用它。"""
    runtime = _runtime()
    if runtime is None:
        return fail(f"{UNAVAILABLE}。", UNAVAILABLE)
    try:
        owner = current_owner_id()
        store = runtime.store()
        flows = store.list_flows(owner)
        triggers = store.triggers(owner)
    except Exception as exc:   # 工具不能抛异常：失败转成一句话交给模型如实转告
        log.warning("flow_list failed: %s", type(exc).__name__)
        return fail("流程列表暂时读不出来，请如实告诉领导稍后再试。", "流程列表暂时读不出来，请稍后再试")
    if not flows:
        return "领导还没有流程。可以告诉领导到「我的流程」里从模板挑一条，或者用一句话描述自动生成。"
    hooks = _hooks()
    head = f"领导共有 {len(flows)} 条流程" + (f"（下面是最近改过的 {MAX_LIST} 条）" if len(flows) > MAX_LIST else "") + "："
    lines = [head]
    for index, flow in enumerate(flows[:MAX_LIST], 1):
        fields = hooks.start_fields(flow.get("graph"))
        need = "、".join(_field_desc(f) for f in fields) or "不用填"
        trigger = triggers.get(flow["id"])
        if trigger and trigger.get("enabled"):
            when = f"定时：{trigger.get('label') or '已开'}"
        elif trigger:
            when = "定时已暂停"
        else:
            when = "没有定时"
        summary = f"：{flow['summary']}" if flow.get("summary") else ""
        lines.append(f"{index}. 「{flow['name']}」{summary}｜要填：{need}｜{when}")
    lines.append("跑某一条用 flow_run；回答时用人话，不要报内部字段名。")
    return "\n".join(lines)


@tool(args_schema=FlowRunArgs)
def flow_run(name: str, inputs: dict[str, Any] | str | None = None, config: RunnableConfig = None) -> str:
    """运行领导自己的一条流程。领导说「跑一下／执行／用我的 xx 流程」「把这个交给 xx 流程」时用。
    按名字找（不用一字不差），有几条一样像会让你先问清；缺必填的输入会告诉你缺什么，问到再跑。
    跑完返回结果与链接（结果网页、生成的文件），链接原样给领导；停在「发送前确认」时给出确认链接。"""
    runtime = _runtime()
    if runtime is None:
        return fail(f"{UNAVAILABLE}。", UNAVAILABLE)
    hooks = _hooks()
    try:
        owner = current_owner_id()
        flows = runtime.store().list_flows(owner)
    except Exception as exc:
        log.warning("flow_run lookup failed: %s", type(exc).__name__)
        return fail("流程列表暂时读不出来，请如实告诉领导稍后再试。", "流程列表暂时读不出来，请稍后再试")
    if not flows:
        return fail("领导还没有任何流程，没法跑。告诉领导可以到「我的流程」里从模板挑一条或一句话生成。",
                    "还没有流程，先到「我的流程」里建一条")
    flow, candidates = find_flows(flows, name)
    if flow is None and candidates:
        return (f"有几条流程都像「{name}」：{_names(candidates)}。先问领导要跑哪一条（只问这一句），"
                "拿到确切的名字再调 flow_run，不要自己挑。")
    if flow is None:
        return fail(f"没找到叫「{name}」的流程。领导现有的流程：{_names(flows)}。问领导是哪一条，或者是不是还没建。",
                    f"没找到叫「{name}」的流程")
    fields = hooks.start_fields(flow.get("graph"))
    mapped, notes, unmatched = hooks.map_inputs(fields, inputs)
    if unmatched:
        wanted = "、".join(_field_desc(f) for f in fields) or "不用填输入"
        return (f"「{flow['name']}」的输入是：{wanted}。你给的「{'」「'.join(unmatched)}」对不上，还没开跑。"
                "按这些输入名重新调 flow_run；拿不准领导的意思就先问一句。")
    missing = hooks.missing_required(fields, mapped)
    if missing:
        need = "、".join(_field_desc(f) for f in missing)
        files = any(f.get("type") == "file" for f in missing)
        return (f"「{flow['name']}」开跑前还要填：{need}，还没开跑。问领导要这些"
                + ("（文件让领导在对话里用 📎 上传）" if files else "") + "，拿到再调 flow_run。")
    future = _POOL.submit(runtime.run_headless, owner, flow["id"], mapped, source="chat")
    try:
        result = future.result(timeout=CHAT_WAIT_SECONDS)
    except FutureTimeout:
        return (f"流程「{flow['name']}」已经开跑了，但比一般的久，还没跑完。告诉领导跑完的结果会出现在「我的流程」"
                "的运行记录里，稍后去那里看；不要再调一次。")
    except Exception as exc:
        log.warning("flow_run failed: %s", type(exc).__name__)
        return fail(f"流程「{flow['name']}」这次没跑成（{type(exc).__name__}），请如实告诉领导稍后再试。",
                    f"「{flow['name']}」这次没跑成，请稍后再试")
    if not isinstance(result, dict):
        return fail(f"流程「{flow['name']}」这次没跑成，请如实告诉领导稍后再试。", f"「{flow['name']}」这次没跑成，请稍后再试")
    text = _result_text(flow["name"], result, external=bool(_channel(owner, config)))
    if notes and result.get("status") == "ok":
        text += "\n\n另外：" + "；".join(notes) + "。"
    return text


__all__ = ["CHAT_WAIT_SECONDS", "TOOL_LABELS", "find_flows", "flow_list", "flow_run"]
