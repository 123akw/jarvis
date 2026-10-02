"""LangGraph 底座：ReAct agent + SQLite 持久记忆。"""
from contextlib import contextmanager
import logging
import os
import sqlite3
import threading

import httpx
from langchain_core.messages import RemoveMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver as _LangGraphSqliteSaver
from langgraph.prebuilt import ToolNode, create_react_agent
from langgraph.prebuilt.tool_node import ToolInvocationError

from jarvis import config
from jarvis.prompts import STEP_WRAP_UP_NOTE, compose_system_prompt, forget_digest, runtime_context
from jarvis.search.service import SearchService
from jarvis.tools import build_search_service, build_tools

# 模型请求超时：此前 ChatOpenAI 未显式给 timeout，openai SDK 收到 None 后整条请求
# 「永不超时」——上游挂起或复用到被 NAT 静默掐断的长连接时，聊天线程会无限卡死。
# read 是「字节间隔」而非总时长：流式回答只要在出字就不会触发；120s 也覆盖非流式
# invoke（微信/服务线程）生成长回答的整段等待。
LLM_TIMEOUT = httpx.Timeout(120.0, connect=10.0, pool=30.0)
LLM_MAX_RETRIES = 1   # 超时后最多重试一次：最坏约 4 分钟给出报错，而不是无限等待

# 送给模型的对话历史上限（字符，约 2 万 token）。checkpoint 里照旧保存全量历史
# （网页回放/蒸馏不受影响），只裁剪每次请求的模型输入；0 表示不裁剪。
HISTORY_CHAR_BUDGET = 30_000
# 窗口起点按 8 轮一档跳动：前缀在多轮之间保持不变，服务端前缀缓存（DeepSeek
# context caching）才能持续命中；逐轮滑动会让每一轮都变成冷请求。
HISTORY_TURN_STEP = 8
# 最近 2 轮（本轮 + 上一轮）的工具结果原样保留，便于「第二条展开说说」类追问；
# 更早的搜索/网页正文已被当轮回答消化，只留开头一段。
FULL_TOOL_TURNS = 2
OLD_TOOL_RESULT_CHARS = 800
_TRUNCATED_NOTE = "\n[较早的工具结果已截断]"


log = logging.getLogger(__name__)


def tool_error_text(error: Exception) -> str:
    """工具抛出的任何异常都转成一条 status=error 的 ToolMessage 交还模型。

    LangGraph 默认只兜参数校验错（ToolInvocationError），其余异常会穿透 agent.invoke：
    本轮失败、checkpoint 停在「已声明 tool_calls、结果未写回」，线程随之中毒（历史事故）。
    这里只给模型类名级信息——异常正文可能带上游 URL 或凭据，不进上下文。"""
    if isinstance(error, ToolInvocationError):
        return (f"{error.message}\n参数不符合要求：对照工具说明里的格式和示例改正参数后再调用一次；"
                "缺的信息无法推断时，直接问领导。")
    log.warning("tool failed: %s", type(error).__name__)
    if isinstance(error, (TimeoutError, httpx.TimeoutException)):
        reason = "请求超时，多半是网络或上游服务慢"
    elif isinstance(error, httpx.HTTPError):
        reason = "网络或上游服务出错"
    else:
        reason = "内部错误"
    return (f"工具执行失败：{reason}（{type(error).__name__}）。不要用相同参数重试；"
            "请用人话告诉领导这一步没成功，并给出替代办法（稍后再试、换个说法或手动处理）。")


# 每个用户问题的联网预算（与系统提示词「联网与来源」一致）。提示词约束模型、这里兜底：
# 模型偶尔会换个措辞把同一问题再搜一遍，预算耗尽后工具直接回一句说明，不再真的发请求。
SEARCH_BUDGET = 2
EXTRACT_BUDGET = 3
# 改动日程/待办的工具：执行后作废「此刻」里的今日概况缓存
_DIGEST_WRITERS = frozenset({"schedule_add", "schedule_del", "todo_add", "todo_done"})
# 每轮步数上限（一次「模型 → 工具」往返占 2 步，约 12 次模型调用）。LangGraph 1.x 的
# 默认递归上限是 10007：模型若陷入「调工具 → 再调工具」的死循环，要烧掉几千次模型调用才停
# （实测脚本模型 40 次调用仍不收手），所以在编译后的图上显式设上限，所有入口一并生效。
# 必须是偶数：模型节点看到的剩余步数是 23、21…1，LangGraph 在剩 1 步时用兜底消息体面收尾；
# 取奇数（如 25）时模型节点落在剩 0 步，兜底消息写完照样抛 GraphRecursionError，前端只见报错。
RECURSION_LIMIT = 24
# 剩余步数不多时提醒模型收尾：LangGraph 在最后一步仍要调工具时会硬塞一句英文
# 「Sorry, need more steps…」，要赶在那之前让模型自己用人话交代进度（剩 5、3、1 步各提醒一次）。
STEP_WRAP_UP_AT = 6


def _current_turn(messages) -> list:
    """本轮消息：最后一条人类消息之后的部分（不含人类消息本身）。"""
    for index in range(len(messages) - 1, -1, -1):
        if messages[index].type == "human":
            return list(messages[index + 1:])
    return list(messages)


def _turn_calls(messages, name: str) -> list[dict]:
    """本轮模型发起的某个工具的全部调用，按发起顺序。"""
    return [call for message in _current_turn(messages) if message.type == "ai"
            for call in (getattr(message, "tool_calls", None) or []) if call.get("name") == name]


def _normalized(value) -> str:
    return " ".join(str(value or "").split()).casefold()


def _budget_refusal(name: str, call: dict, messages) -> str:
    """超出本轮联网预算或重复搜索时的回执；在预算内返回空串（照常执行）。"""
    calls = _turn_calls(messages, name)
    ids = [item.get("id") for item in calls]
    position = ids.index(call.get("id")) if call.get("id") in ids else len(calls)
    earlier = calls[:position]
    if name == "web_search":
        searched: list[str] = []          # 按顺序重放：被拦下的重复/超额调用不占预算
        for item in earlier:
            text = _normalized((item.get("args") or {}).get("query"))
            if text not in searched and len(searched) < SEARCH_BUDGET:
                searched.append(text)
        query = _normalized((call.get("args") or {}).get("query"))
        if query in searched:
            return "这个问题本轮已经搜过了，结果就在上面：直接基于已有结果回答，不要重复搜索。"
        if len(searched) >= SEARCH_BUDGET:
            return (f"本轮已联网搜索 {SEARCH_BUDGET} 次，达到上限，这次没有执行。请基于已有结果回答；"
                    "仍不确定的部分如实说「未查到」，并告诉领导可以换个更具体的问法再查。")
    if name == "web_extract":
        url = _normalized((call.get("args") or {}).get("url"))
        seen = {_normalized((item.get("args") or {}).get("url")) for item in earlier}
        if url not in seen and len(seen) >= EXTRACT_BUDGET:
            return (f"本轮已读取 {EXTRACT_BUDGET} 个网页，达到上限，这次没有执行。"
                    "请基于已有资料回答，来源不足就如实说明。")
    return ""


def guard_tool_call(request, execute):
    """ToolNode 拦截器：联网预算兜底 + 日程/待办改动后作废今日概况缓存。"""
    call = request.tool_call
    name = call.get("name", "")
    state = request.state
    messages = state.get("messages") if isinstance(state, dict) else getattr(state, "messages", None)
    if messages and name in ("web_search", "web_extract"):
        refusal = _budget_refusal(name, call, messages)
        if refusal:
            log.info("tool budget refused: %s", name)
            return ToolMessage(content=refusal, name=name, tool_call_id=call.get("id", ""))
    result = execute(request)
    if name in _DIGEST_WRITERS:
        forget_digest()
    return result


def with_runtime_context(history: list, *, context: str, remaining_steps=None) -> list:
    """把「此刻」插在本轮用户消息（连同紧挨的 system 风格指令）之前；步数将尽时在末尾加收尾提醒。

    位置按前缀缓存（DeepSeek context caching）实测取舍：放进系统提示词，每轮都变，其后全部
    历史失去缓存；接在输入末尾，本轮第 2 次起的每次模型调用都要为「此刻」再付一次未命中
    （21 条评估实测未命中 token 2.5 万 → 3.5 万）。插在本轮用户消息前，本轮内各次调用前缀
    一致，代价只是上一轮的问答片段在下一轮首次调用时未命中一次；且「最后一条是用户消息 /
    工具结果」的输入形状不变。「此刻」只进模型输入，不写 checkpoint。"""
    starts = _turn_starts(history)
    at = starts[-1] if starts else len(history)
    shaped = history[:at] + [SystemMessage(content=context)] + history[at:]
    if remaining_steps is not None and remaining_steps <= STEP_WRAP_UP_AT:
        shaped.append(SystemMessage(content=STEP_WRAP_UP_NOTE))
    return shaped


def history_char_budget() -> int:
    raw = os.getenv("JARVIS_HISTORY_CHAR_BUDGET", "").strip()
    try:
        value = int(raw) if raw else HISTORY_CHAR_BUDGET
    except ValueError:
        value = HISTORY_CHAR_BUDGET
    return max(0, value)


def _message_chars(message) -> int:
    content = message.content
    size = len(content) if isinstance(content, str) else len(str(content))
    for call in getattr(message, "tool_calls", None) or []:
        size += len(str(call.get("args", "")))
    return size


def _compact_tool_result(message):
    content = message.content
    if message.type != "tool" or not isinstance(content, str) or len(content) <= OLD_TOOL_RESULT_CHARS:
        return message
    return message.model_copy(update={"content": content[:OLD_TOOL_RESULT_CHARS] + _TRUNCATED_NOTE})


def _turn_starts(messages) -> list[int]:
    """每轮起点 = 人类消息下标（连同紧挨在前的 system 消息，如语音风格指令）。"""
    starts = []
    for index, message in enumerate(messages):
        if message.type != "human":
            continue
        start = index
        while start > 0 and messages[start - 1].type == "system":
            start -= 1
        if not starts or start > starts[-1]:
            starts.append(start)
    return starts


def bounded_history(messages, budget: int | None = None) -> list:
    """裁剪送给模型的历史：只在轮次边界切（工具调用/结果成对保留），本轮永远完整。"""
    messages = list(messages)
    budget = history_char_budget() if budget is None else budget
    starts = _turn_starts(messages)
    if budget <= 0 or len(starts) <= 1:
        return messages
    full_from = starts[max(0, len(starts) - FULL_TOOL_TURNS)]
    shaped = [_compact_tool_result(m) for m in messages[:full_from]] + messages[full_from:]
    sizes = [_message_chars(m) for m in shaped]
    keep = len(starts) - 1                        # 至少保留本轮
    total = sum(sizes[starts[keep]:])
    while keep > 0:
        extra = sum(sizes[starts[keep - 1]:starts[keep]])
        if total + extra > budget:
            break
        total += extra
        keep -= 1
    if keep == 0:
        return shaped
    # 向上取整到档位：只多丢不多留（不超预算），且起点在一档内保持不变；
    # 但取整不能把放得下的上一轮也丢掉（单轮很大时宁可逐轮滑动，保住追问上下文）
    stepped = -(-keep // HISTORY_TURN_STEP) * HISTORY_TURN_STEP
    if stepped <= len(starts) - FULL_TOOL_TURNS:
        keep = stepped
    return shaped[starts[keep]:]


class SqliteSaver(_LangGraphSqliteSaver):
    """只保留每个线程最近两个 checkpoint 的 SqliteSaver。

    LangGraph 每个超步都把「完整消息列表」整份写成一个新 checkpoint（一轮带工具
    调用约 5 个），旧 checkpoint 永不删除：线程越长，每轮写入越大、库按 O(n²) 膨胀
    （实测 150 轮单线程 469MB）。本项目不用时间旅行/历史回溯，续聊只读最新
    checkpoint，所以写入新 checkpoint 时顺手删掉父节点之前的旧版本及其 writes。
    父节点保留：异步落盘时它的 pending writes 可能还在途。
    """

    def put(self, config, checkpoint, metadata, new_versions):
        saved = super().put(config, checkpoint, metadata, new_versions)
        parent = (config.get("configurable") or {}).get("checkpoint_id")
        if parent:
            target = saved["configurable"]
            key = (target["thread_id"], target.get("checkpoint_ns", ""), parent)
            try:
                with self.cursor() as cur:
                    cur.execute("DELETE FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id<?", key)
                    cur.execute("DELETE FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id<?", key)
            except sqlite3.Error:
                pass  # 清理失败只是少省空间，绝不影响本轮对话
        return saved


def build_agent(
    *,
    search_service: SearchService | None = None,
    model=None,
    checkpointer=None,
    pandascore_token_getter=None,
    tool_names=None,
):
    service = build_search_service() if search_service is None else search_service
    tools = (
        build_tools(service)
        if pandascore_token_getter is None
        else build_tools(service, pandascore_token_getter=pandascore_token_getter)
    )
    if tool_names is not None:
        # 智能平台账号只绑定平台插件对应的工具（jarvis/platforms.py 的 agent_tool_names）
        tools = [item for item in tools if item.name in tool_names]
    if model is None:
        config.load_env()
        model = ChatOpenAI(
            model=config.model_name(),
            base_url=config.base_url(),
            api_key=config.api_key(),
            temperature=0,
            timeout=LLM_TIMEOUT,
            max_retries=LLM_MAX_RETRIES,
        )
    if checkpointer is None:
        checkpointer = SqliteSaver(
            sqlite3.connect(str(config.db_path()), check_same_thread=False)
        )
    def dynamic_prompt(state):
        # 每轮组装（在 tenant_scope 内求值）：系统提示词（基础人设 + 人设偏好 + 长期画像 + 技能）
        # + 有界历史，本轮用户消息前插入「此刻」。历史预算扣掉「此刻」的长度，总量仍不超预算。
        context = runtime_context()
        budget = history_char_budget()
        history = bounded_history(state["messages"], max(1, budget - len(context)) if budget else 0)
        return [SystemMessage(content=compose_system_prompt())] + with_runtime_context(
            history, context=context, remaining_steps=state.get("remaining_steps"))

    agent = create_react_agent(
        model,
        ToolNode(tools, handle_tool_errors=tool_error_text, wrap_tool_call=guard_tool_call),
        prompt=dynamic_prompt,
        checkpointer=checkpointer,
    )
    # with_config 返回的仍是编译图（get_state/update_state/checkpointer 照常可用）；
    # 调用方显式传 recursion_limit 时以调用方为准
    return agent.with_config(recursion_limit=RECURSION_LIMIT) if hasattr(agent, "with_config") else agent


class ThreadBusyError(RuntimeError):
    """同一会话线程上一轮还没结束，等待超时。"""


# 每个 checkpoint 线程一把回合锁（引用计数，用完即从表里摘掉，表不会无界增长）。
_TURN_LOCKS: dict[str, list] = {}   # thread_id -> [Lock, 等待/持有者计数]
_TURN_LOCKS_GUARD = threading.Lock()


def _turn_lock_count() -> int:
    with _TURN_LOCKS_GUARD:
        return len(_TURN_LOCKS)


@contextmanager
def thread_turn(thread_id: str, timeout: float = 90.0):
    """同一 checkpoint 线程的回合串行化（自愈 + 整轮流式都要在锁内）。

    实测：同一线程同时发两条消息，两轮从同一个 checkpoint 起跑、各自落盘，后写的
    覆盖先写的——历史里丢一条回答；更糟的是后到的一轮开头的 heal_dangling_tool_calls
    会把前一轮「在途」的 tool_calls 当成悬空调用删掉。不同线程互不影响。
    等待超过 timeout 秒抛 ThreadBusyError，由调用方转成人话。
    """
    with _TURN_LOCKS_GUARD:
        entry = _TURN_LOCKS.get(thread_id)
        if entry is None:
            entry = _TURN_LOCKS[thread_id] = [threading.Lock(), 0]
        entry[1] += 1
    acquired = False
    try:
        acquired = entry[0].acquire(timeout=max(0.0, timeout))
        if not acquired:
            raise ThreadBusyError(thread_id)
        yield
    finally:
        if acquired:
            entry[0].release()
        with _TURN_LOCKS_GUARD:
            entry[1] -= 1
            if entry[1] <= 0 and _TURN_LOCKS.get(thread_id) is entry:
                del _TURN_LOCKS[thread_id]


def heal_dangling_tool_calls(agent, thread_id: str) -> None:
    """清除中途崩溃遗留的悬空工具调用，否则该线程之后每轮请求都会被模型 API 拒绝。

    崩溃（异常、重启、断电）可能把 checkpoint 停在「AI 已声明 tool_calls、
    工具结果尚未写回」的状态；后续任何消息都会带着这段非法历史请求模型。
    修复方式：删除悬空的 AI 消息及其已写回的部分工具结果，保持序列合法。
    调用失败只记为不修复，绝不阻断本轮对话。
    """
    config = {"configurable": {"thread_id": thread_id}}
    try:
        state = agent.get_state(config)
        messages = state.values.get("messages") or []
        answered = {
            getattr(message, "tool_call_id", None)
            for message in messages
            if message.type == "tool"
        }
        removals = []
        for message in messages:
            calls = getattr(message, "tool_calls", None)
            if message.type != "ai" or not calls:
                continue
            call_ids = {call.get("id") for call in calls}
            if call_ids <= answered:
                continue
            removals.append(RemoveMessage(id=message.id))
            removals.extend(
                RemoveMessage(id=message_item.id)
                for message_item in messages
                if message_item.type == "tool"
                and getattr(message_item, "tool_call_id", None) in call_ids
            )
        if not removals:
            return
        # 崩在工具节点时，已完成的工具结果只在 pending writes 里（get_state 视图可见，
        # checkpoint 本体没有）：对它们发 RemoveMessage 会抛「ID doesn't exist」，此前被
        # 静默吞掉，线程从此每轮报错。只删本体里真实存在的消息；pending writes 随新
        # checkpoint 一起作废。
        persisted = _persisted_message_ids(agent, config)
        if persisted is not None:
            removals = [item for item in removals if item.id in persisted]
        if removals:
            agent.update_state(config, {"messages": removals})
            log.info("healed %d dangling message(s) on thread %s", len(removals), thread_id)
    except Exception as exc:
        log.warning("heal dangling tool calls failed: %s", type(exc).__name__)


def _persisted_message_ids(agent, config) -> set | None:
    """checkpoint 本体（不含 pending writes）里的消息 id；读不到返回 None（按旧逻辑全删）。"""
    checkpointer = getattr(agent, "checkpointer", None)
    get_tuple = getattr(checkpointer, "get_tuple", None)
    if not callable(get_tuple):
        return None
    saved = get_tuple(config)
    if saved is None:
        return set()
    messages = (saved.checkpoint.get("channel_values") or {}).get("messages") or []
    return {getattr(message, "id", None) for message in messages}
