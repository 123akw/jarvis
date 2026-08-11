"""Agent tool construction stays runtime-bound to one search generation."""
from __future__ import annotations

from types import SimpleNamespace

import jarvis.graph as graph_mod
import jarvis.tools as tools_mod
from jarvis.prompts import SYSTEM_PROMPT


EXPECTED_TOOL_NAMES = {
    "now",
    "calc",
    "weather",
    "weather_here",
    "my_location",
    "coding_status",
    "memo_add",
    "memo_list",
    "memo_del",
    "schedule_add",
    "schedule_list",
    "schedule_del",
    "todo_add",
    "todo_list",
    "todo_done",
    "sys_query",
    "web_search",
    "web_extract",
    "movie_ratings",
    "esports_scores",
    "ticket_search",
}
SEARCH_TOOL_NAMES = {
    "web_search",
    "web_extract",
    "movie_ratings",
    "esports_scores",
    "ticket_search",
}


class FakeSearchService:
    def __init__(self, generation: int):
        self.generation = generation


def _build_tools():
    assert hasattr(tools_mod, "build_tools"), "build_tools factory is missing"
    return tools_mod.build_tools


def test_build_tools_registers_exactly_twenty_one_unique_tools():
    """Dropping, duplicating, or renaming a tool breaks the Agent's public capability set."""
    tools = _build_tools()(FakeSearchService(generation=7))
    names = [item.name for item in tools]

    assert len(names) == 21
    assert len(set(names)) == 21
    assert set(names) == EXPECTED_TOOL_NAMES


def test_build_tools_binds_one_search_generation():
    """Constructing each search tool separately would split cache and provider health state."""
    tools = _build_tools()(FakeSearchService(generation=7))
    bound = [item for item in tools if item.name in SEARCH_TOOL_NAMES]

    assert len(bound) == 5
    assert {item.search_generation for item in bound} == {7}


def test_build_tools_does_not_replace_an_explicit_falsey_search_service(monkeypatch):
    """Truthiness checks would silently discard valid caller-owned service implementations."""
    class FalseySearchService(FakeSearchService):
        def __init__(self, generation):
            super().__init__(generation)
            self.requests = []

        def __bool__(self):
            return False

        def search(self, request):
            self.requests.append(request)
            return SimpleNamespace(results=(), attempted_providers=("fake",))

        def format_response(self, response):
            return "bound-service-response"

    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    service = FalseySearchService(generation=23)
    tools = _build_tools()(service)
    bound = [item for item in tools if item.name in SEARCH_TOOL_NAMES]
    movie = next(item for item in tools if item.name == "movie_ratings")

    assert {item.search_generation for item in bound} == {23}
    assert "bound-service-response" in movie.invoke({"title": "哪吒"})
    assert len(service.requests) == 1


def test_build_tools_keeps_no_argument_compatibility():
    """Legacy callers must still be able to construct the complete registry without arguments."""
    tools = _build_tools()()

    assert {item.name for item in tools} == EXPECTED_TOOL_NAMES


def test_no_argument_build_agent_constructs_runtime_tools_instead_of_using_module_tools(
    monkeypatch,
):
    """Production construction must not reuse the compatibility TOOLS service snapshot."""
    runtime_service = FakeSearchService(generation=41)
    received_services = []
    runtime_tools = [SimpleNamespace(name="runtime-bound")]
    compatibility_tools = [SimpleNamespace(name="compatibility-snapshot")]

    monkeypatch.setattr(graph_mod, "build_search_service", lambda: runtime_service, raising=False)

    def fake_build_tools(service):
        received_services.append(service)
        return runtime_tools

    monkeypatch.setattr(graph_mod, "build_tools", fake_build_tools, raising=False)
    monkeypatch.setattr(graph_mod, "TOOLS", compatibility_tools, raising=False)
    monkeypatch.setattr(graph_mod.config, "load_env", lambda: None)
    monkeypatch.setattr(graph_mod.config, "model_name", lambda: "fake-model")
    monkeypatch.setattr(graph_mod.config, "base_url", lambda: "https://model.invalid")
    monkeypatch.setattr(graph_mod.config, "api_key", lambda: "fake-key")
    monkeypatch.setattr(graph_mod.config, "db_path", lambda: ":memory:")
    monkeypatch.setattr(graph_mod, "ChatOpenAI", lambda **kwargs: ("model", kwargs))
    monkeypatch.setattr(graph_mod.sqlite3, "connect", lambda *args, **kwargs: "connection")
    monkeypatch.setattr(graph_mod, "SqliteSaver", lambda connection: ("checkpointer", connection))
    monkeypatch.setattr(
        graph_mod,
        "create_react_agent",
        lambda model, tools, **kwargs: {
            "model": model,
            "tools": tools,
            "checkpointer": kwargs["checkpointer"],
        },
    )

    result = graph_mod.build_agent()

    assert received_services == [runtime_service]
    assert result["tools"] is runtime_tools
    assert result["tools"] is not compatibility_tools
    assert result["checkpointer"] == ("checkpointer", "connection")


def test_system_prompt_has_provider_neutral_search_and_extract_budgets():
    """Provider-specific or unbounded instructions can amplify searches and extractions."""
    assert "最多执行 2 次联网搜索" in SYSTEM_PROMPT
    assert "最多对 3 个不同 HTTP(S) URL 调用 web_extract" in SYSTEM_PROMPT
    assert "Tavily 搜索" not in SYSTEM_PROMPT
