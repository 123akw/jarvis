"""Agent 工具健壮性（2026-10-02 QA 轮）：工具失败必须变成返回文本，不能把线程毒死。

历史事故：工具抛异常穿透 agent.invoke，checkpoint 留下悬空 tool_calls，之后该线程每轮
都被模型 API 拒绝。本文件每条用例都对应一次实测复现。
"""
import subprocess
import threading
import time

import httpx
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver

import jarvis.graph as graph_mod
from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantStore, tenant_scope


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


class ScriptedModel(BaseChatModel):
    """第一轮发出脚本里的 tool_calls；看到工具结果后用一句话收尾。不发真实请求。"""

    script: list = []

    @property
    def _llm_type(self):
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if messages[-1].type == "tool":
            message = AIMessage(content="收到：" + str(messages[-1].content)[:80])
        elif self.script:
            message = AIMessage(content="", tool_calls=self.script)
        else:
            message = AIMessage(content="好的")
        return ChatResult(generations=[ChatGeneration(message=message)])


class _Search:
    generation = 1

    def extract(self, url):  # pragma: no cover - 本文件不触发
        raise AssertionError("unexpected extract")


def _call(name, args, i=1):
    return {"name": name, "args": args, "id": f"call_{name}_{i}", "type": "tool_call"}


def _agent(script, saver=None):
    return graph_mod.build_agent(search_service=_Search(), model=ScriptedModel(script=script),
                                 checkpointer=saver or InMemorySaver())


def test_tool_exception_becomes_error_tool_message(monkeypatch):
    """任何工具内部异常（这里模拟存储层故障）此前都直接穿透 agent.invoke。"""
    def broken(*_args, **_kwargs):
        raise RuntimeError("disk I/O error at /secret/path")

    monkeypatch.setattr(TenantStore, "add_memo", broken)
    agent = _agent([_call("memo_add", {"content": "交电费"})])
    result = agent.invoke({"messages": [HumanMessage(content="记一下交电费")]},
                          config={"configurable": {"thread_id": "t1"}})
    tools = [m for m in result["messages"] if m.type == "tool"]
    assert len(tools) == 1 and tools[0].status == "error"
    assert "失败" in tools[0].content and "/secret/path" not in tools[0].content
    assert result["messages"][-1].type == "ai"


def test_parallel_batch_with_one_crashing_tool_keeps_thread_healthy(monkeypatch):
    """实测：memo_add 与 sys_query 并行，后者抛异常 → 本轮崩、heal 删不掉 pending 里的
    ToolMessage（ValueError 被吞）→ 之后每轮 ValueError，线程永久坏掉。"""
    def slow(*args, **kwargs):
        time.sleep(0.2)
        raise subprocess.TimeoutExpired(args[0], 10)

    monkeypatch.setattr(subprocess, "run", slow)
    saver = InMemorySaver()
    config = {"configurable": {"thread_id": "t-par"}}
    agent = _agent([_call("memo_add", {"content": "并行备忘"}, 1),
                    _call("sys_query", {"command": "uptime"}, 2)], saver)
    agent.invoke({"messages": [HumanMessage(content="记一下并看看运行时长")]}, config=config)
    follow = _agent([], saver)
    graph_mod.heal_dangling_tool_calls(follow, "t-par")
    out = follow.invoke({"messages": [HumanMessage(content="下一轮")]}, config=config)
    assert out["messages"][-1].content == "好的"


def test_heal_repairs_crash_with_pending_tool_writes(monkeypatch):
    """即便本轮真的崩在工具节点（错误处理之外的 BaseException 场景），heal 也要能修好：
    只删 checkpoint 里真实存在的消息，pending writes 随新 checkpoint 丢弃。"""
    saver = InMemorySaver()
    config = {"configurable": {"thread_id": "t-heal"}}
    agent = _agent([_call("memo_add", {"content": "w"}, 41), _call("sys_query", {"command": "uptime"}, 42)], saver)

    def explode(*args, **kwargs):
        time.sleep(0.2)
        raise KeyboardInterrupt  # 不属于 Exception，错误处理器兜不住，模拟进程级中断

    monkeypatch.setattr(subprocess, "run", explode)
    with pytest.raises(KeyboardInterrupt):
        agent.invoke({"messages": [HumanMessage(content="hi")]}, config=config)
    follow = _agent([], saver)
    graph_mod.heal_dangling_tool_calls(follow, "t-heal")
    out = follow.invoke({"messages": [HumanMessage(content="下一轮")]}, config=config)
    assert out["messages"][-1].content == "好的"


def test_heal_failure_is_logged(caplog):
    class Broken:
        def get_state(self, _config):
            raise RuntimeError("db locked")

    with caplog.at_level("WARNING"):
        graph_mod.heal_dangling_tool_calls(Broken(), "t")
    assert any("heal" in r.getMessage() for r in caplog.records)


# ---------- calc ----------

@pytest.mark.parametrize("expression", ["9**9**9", "10**10**8", "2**99999999", "(10**999)**(10**3)"])
def test_calc_refuses_huge_power_quickly(expression):
    """实测：9**9**9 占住 GIL 超过 60 秒，整个服务（所有用户）冻住。"""
    from jarvis.tools.calc import calc
    done = {}

    def run():
        done["out"] = calc.invoke({"expression": expression})

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(2)
    assert not worker.is_alive(), "calc 必须在 2 秒内返回"
    assert "太大" in done["out"]


@pytest.mark.parametrize("expression", ["1e308*10", "2.0**10000", "10**5000", "+".join(["1"] * 1200),
                                         "(10**999)*(10**999)*(10**999)*(10**999)*(10**999)"])
def test_calc_overflow_returns_text(expression):
    from jarvis.tools.calc import calc
    out = calc.invoke({"expression": expression})
    assert isinstance(out, str) and "inf" not in out


def test_calc_still_handles_normal_math():
    from jarvis.tools.calc import calc
    assert "= 1024" in calc.invoke({"expression": "2**10"})
    assert "= 0.5" in calc.invoke({"expression": "2**-1"})
    assert "= 27600" in calc.invoke({"expression": "2300*12"})


# ---------- 其他工具 ----------

def test_profile_remember_blank_fact_returns_text():
    from jarvis.tools.profile import profile_remember
    assert "不能为空" in profile_remember.invoke({"fact": "   "})


@pytest.mark.parametrize("tool_name", ["memo_add", "todo_add"])
def test_blank_content_is_rejected_with_text(tool_name):
    from jarvis import tools
    out = getattr(tools, tool_name).invoke({"content": "  "})
    assert "不能为空" in out
    assert TenantStore().list_memos() == [] and TenantStore().list_todos() == []


def test_weather_non_json_and_missing_fields_return_text(monkeypatch):
    import importlib
    weather_mod = importlib.import_module("jarvis.tools.weather")

    def bad_json(*_a, **_k):
        raise ValueError("Expecting value")

    monkeypatch.setattr(weather_mod, "_get_json", bad_json)
    assert "天气服务" in weather_mod.weather.invoke({"city": "北京"})

    monkeypatch.setattr(weather_mod, "_get_json", lambda *_a, **_k: {"results": [{"latitude": 1}]})
    assert "天气服务" in weather_mod.weather.invoke({"city": "北京"})


def test_sys_query_timeout_returns_text(monkeypatch):
    from jarvis.tools.system import sys_query

    def slow(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 10)

    monkeypatch.setattr(subprocess, "run", slow)
    assert "超时" in sys_query.invoke({"command": "uptime"})


@pytest.mark.parametrize("tool_name,arg", [("memo_del", "memo_id"), ("todo_done", "todo_id"),
                                           ("schedule_del", "schedule_id"), ("profile_forget", "profile_id")])
def test_huge_ids_in_tools_do_not_overflow(tool_name, arg):
    """实测：id=10**20 在存储层 OverflowError。参数上限让它变成可读的参数错误。"""
    from pydantic import ValidationError
    from jarvis import tools
    with pytest.raises(ValidationError):   # 而不是钻进 SQLite 再 OverflowError
        getattr(tools, tool_name).invoke({arg: 10 ** 20})


def test_coding_status_tolerates_malformed_desktop_payload():
    from jarvis.tools.location import coding_status
    TenantStore().set_local_status(["not-a-dict", {"files": "a.py", "project": 1}])
    out = coding_status.invoke({})
    assert isinstance(out, str)
