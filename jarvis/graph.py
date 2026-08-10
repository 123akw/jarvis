"""LangGraph 底座：ReAct agent + SQLite 持久记忆。"""
import os
import sqlite3
from pathlib import Path

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.prebuilt import create_react_agent

from jarvis.tools import TOOLS

_ROOT = Path(__file__).resolve().parent.parent

SYSTEM_PROMPT = (
    "你是贾维斯，领导的私人管家。永远用简体中文回答，语气干练、周到。"
    "涉及时间就调 now；记事、待办用 memo_add／memo_list／memo_del；"
    "查本机状态用 sys_query（只有 date、uptime、df -h、ls 可用）。"
    "工具能回答的不要凭空猜，回复保持简短。"
)


def build_agent():
    load_dotenv(_ROOT / ".env")
    # SOCKS 代理需要额外的 socksio 包（不在依赖白名单里）；
    # 摘掉 all_proxy 后 httpx 自动走 https_proxy 的 HTTP 代理。
    for var in ("all_proxy", "ALL_PROXY"):
        os.environ.pop(var, None)
    model = ChatOpenAI(
        model=os.getenv("JARVIS_MODEL", "deepseek-chat"),
        base_url=os.getenv("JARVIS_BASE_URL", "https://api.deepseek.com"),
        api_key=os.environ["DEEPSEEK_API_KEY"],
        temperature=0,
    )
    db = _ROOT / "data" / "jarvis.db"
    db.parent.mkdir(exist_ok=True)
    checkpointer = SqliteSaver(sqlite3.connect(str(db), check_same_thread=False))
    return create_react_agent(model, TOOLS, prompt=SYSTEM_PROMPT, checkpointer=checkpointer)
