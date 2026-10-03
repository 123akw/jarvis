"""第十九轮：核心工具的「这次没办成」能被流程识别并停下；流程里的联网工具按账号自己的搜索设置跑。"""
from contextlib import contextmanager

import httpx
import jarvis.server as server_mod
from langchain_core.tools import StructuredTool

from jarvis.flows import engine, nodes
import importlib

from jarvis.tools import TOOLS
from jarvis.tools.failure import ToolFailure, fail, is_failure, public_text
from tests.test_flow_graph_engine import Deps, _by, _e, _node, _run, _start, _tool_graph, fake_weather, owner_id  # noqa: F401


weather_mod = importlib.import_module("jarvis.tools.weather")   # jarvis.tools.weather 这个名字被同名工具占了


# ---------- 标记本身 ----------

def test_failure_is_still_plain_text_for_chat_but_has_public_words():
    text = "翻旧账暂时不可用（OperationalError），请如实告诉领导没能查到。"
    marked = fail(text)
    assert isinstance(marked, str) and marked == text and is_failure(marked)   # 对话里模型照常读到原话
    assert public_text(marked) == "翻旧账暂时不可用。"                          # 流程用户看不到给模型的话与异常名
    assert fail("搜不到", "联网搜索还没配好").public == "联网搜索还没配好"
    assert not is_failure("正常结果") and public_text("正常结果") == "正常结果"


def test_weather_service_down_returns_marked_failure(monkeypatch):
    def boom(*_a, **_k):
        raise httpx.ConnectError("down")
    monkeypatch.setattr(weather_mod, "_get_json_retrying", boom)
    result = weather_mod.weather.invoke({"city": "深圳"})
    assert isinstance(result, ToolFailure) and "请如实告诉领导" in result
    assert public_text(result) == "天气服务暂时连不上，这次查不到，请稍后再试"


def test_marker_survives_plugin_guard():
    from jarvis.plugins.loader import guard_tool
    raw = StructuredTool.from_function(func=lambda city: fail("天气服务暂时连不上（ConnectError），这次查不到。请如实告诉领导，稍后再问。"),
                                       name="weather", description="查天气")
    guarded = guard_tool(raw, plugin_name="查天气", timeout=5)
    assert is_failure(guarded.invoke({"city": "深圳"}))


# ---------- 流程停下 ----------

def test_core_tool_failure_stops_the_flow(owner_id):
    down = fail("天气服务暂时连不上（ConnectError），这次查不到。请如实告诉领导，稍后再问或先看手机天气。",
                "天气服务暂时连不上，这次查不到，请稍后再试")
    graph = _tool_graph(city="{{start.city}}")
    graph["nodes"].insert(2, _node("ai", "llm", title="写建议", prompt="根据 {{w.text}} 写出门建议"))
    graph["nodes"][-1]["data"]["output"] = "{{ai.text}}"
    graph["edges"] = [_e("start", "w"), _e("w", "ai"), _e("ai", "end")]
    deps = Deps(tools={"weather": fake_weather([], reply=down)})
    events, result = _run(owner_id, graph, deps, {"city": "深圳"})
    error = _by(events, "node_error")["w"]["message"]
    assert error == "「查天气」：天气服务暂时连不上，这次查不到，请稍后再试"
    assert "ai" not in _by(events, "node_start") and deps.prompts == []   # 不把失败说明喂给 AI
    assert result["status"] == "error"


# ---------- 按账号的搜索设置 ----------

def test_find_tool_passes_running_account_to_hook():
    seen = []
    base = TOOLS[0]
    deps = engine.FlowDeps(tenant_store=None, find_tool=lambda name: base,
                           user_tool=lambda uid, name, tool: seen.append((uid, name, tool)) or "换过的")
    assert nodes.find_tool(base.name, deps) is base            # 目录 / 运行前检查：不换
    assert nodes.find_tool(base.name, deps, user_id="u1") == "换过的"
    assert seen == [("u1", base.name, base)]
    broken = engine.FlowDeps(tenant_store=None, find_tool=lambda name: base, user_tool=lambda *a: 1 / 0)
    assert nodes.find_tool(base.name, broken, user_id="u1") is base   # 钩子坏了照样用全局那份


def test_flow_web_search_uses_the_accounts_own_search_service(monkeypatch):
    used = []

    class Service:
        """账号自己的搜索服务替身：只记一下被谁用了。"""

    class Bundle:
        search_service = Service()

    @contextmanager
    def bundle_for(uid):
        used.append(uid)
        yield Bundle()

    def build_tools(search_service=None, **_):
        return [StructuredTool.from_function(func=lambda query="", **_k: f"用账号的服务搜：{query}", name="web_search",
                                             description="搜", args_schema=base.args_schema)]

    base = next(t for t in TOOLS if t.name == "web_search")
    monkeypatch.setattr(server_mod, "_runtime_manager", object())
    monkeypatch.setattr(server_mod, "_bundle_for", bundle_for)
    monkeypatch.setattr("jarvis.tools.build_tools", build_tools)
    tool = server_mod._flow_user_tool("u42", "web_search", base)
    assert tool is not base and tool.invoke({"query": "今日新闻"}) == "用账号的服务搜：今日新闻"
    assert used == ["u42"]
    calc = next(t for t in TOOLS if t.name == "calc")
    assert server_mod._flow_user_tool("u42", "calc", calc) is calc      # 非联网工具不换
    monkeypatch.setattr(server_mod, "_runtime_manager", None)
    assert server_mod._flow_user_tool("u42", "web_search", base) is base  # 测试 / 旧式运行时不换
