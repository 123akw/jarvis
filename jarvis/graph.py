"""LangGraph 底座：ReAct agent + SQLite 持久记忆。"""
import os
import sqlite3

import httpx
from langchain_core.messages import RemoveMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver as _LangGraphSqliteSaver
from langgraph.prebuilt import create_react_agent

from jarvis import config
from jarvis.prompts import compose_system_prompt
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
):
    service = build_search_service() if search_service is None else search_service
    tools = (
        build_tools(service)
        if pandascore_token_getter is None
        else build_tools(service, pandascore_token_getter=pandascore_token_getter)
    )
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
        # 每轮组装：基础人设 + 当前租户的长期画像（在 tenant_scope 内求值）+ 有界历史
        return [SystemMessage(content=compose_system_prompt())] + bounded_history(state["messages"])

    return create_react_agent(
        model,
        tools,
        prompt=dynamic_prompt,
        checkpointer=checkpointer,
    )


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
        if removals:
            agent.update_state(config, {"messages": removals})
    except Exception:
        return
