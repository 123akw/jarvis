"""LangGraph 底座：ReAct agent + SQLite 持久记忆。"""
import sqlite3

from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.prebuilt import create_react_agent

from jarvis import config
from jarvis.prompts import SYSTEM_PROMPT
from jarvis.tools import TOOLS


def build_agent():
    config.load_env()
    model = ChatOpenAI(
        model=config.model_name(),
        base_url=config.base_url(),
        api_key=config.api_key(),
        temperature=0,
    )
    checkpointer = SqliteSaver(
        sqlite3.connect(str(config.db_path()), check_same_thread=False)
    )
    return create_react_agent(model, TOOLS, prompt=SYSTEM_PROMPT, checkpointer=checkpointer)
