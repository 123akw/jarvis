"""LangGraph 底座：ReAct agent + SQLite 持久记忆。"""
import sqlite3

from langchain_core.messages import RemoveMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.prebuilt import create_react_agent

from jarvis import config
from jarvis.prompts import SYSTEM_PROMPT
from jarvis.search.service import SearchService
from jarvis.tools import build_search_service, build_tools


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
        )
    if checkpointer is None:
        checkpointer = SqliteSaver(
            sqlite3.connect(str(config.db_path()), check_same_thread=False)
        )
    return create_react_agent(
        model,
        tools,
        prompt=SYSTEM_PROMPT,
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
