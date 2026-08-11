"""LangGraph 底座：ReAct agent + SQLite 持久记忆。"""
import sqlite3

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
):
    service = build_search_service() if search_service is None else search_service
    tools = build_tools(service)
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
