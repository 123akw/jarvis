"""工具注册处。每个 Agent runtime 获得一套绑定同一搜索服务的工具。

对外导出路径保持 `from jarvis.tools import ...`，与测试和历史代码兼容。
"""
from itertools import count

from langchain_core.tools import BaseTool, tool

from jarvis.tools.calc import calc
from jarvis.tools.clock import now
from jarvis.tools.entertainment import make_entertainment_tools, render_search_failure
from jarvis.tools.location import coding_status, my_location
from jarvis.tools.memo import memo_add, memo_del, memo_list
from jarvis.tools.schedule import schedule_add, schedule_del, schedule_list
from jarvis.tools.search import WebSearchArgs, _validated_request, make_web_extract_tool
from jarvis.tools.system import sys_query
from jarvis.tools.todo import todo_add, todo_done, todo_list
from jarvis.tools.weather import weather, weather_here
from jarvis.search.providers import DDGSProvider, SearXNGProvider, TavilyProvider
from jarvis.search.service import SearchService

_SEARCH_GENERATIONS = count(1)
_LOCAL_TOOLS = [
    now, calc, weather, weather_here, my_location, coding_status,
    memo_add, memo_list, memo_del,
    schedule_add, schedule_list, schedule_del,
    todo_add, todo_list, todo_done,
    sys_query,
]


def build_search_service() -> SearchService:
    """Create one production search runtime with a visible generation identity."""
    service = SearchService([SearXNGProvider(), DDGSProvider(), TavilyProvider()])
    service.generation = next(_SEARCH_GENERATIONS)
    return service


def _make_web_search_tool(service: SearchService) -> BaseTool:
    @tool("web_search", args_schema=WebSearchArgs)
    def bound_web_search(
        query: str,
        topic: str = "general",
        time_range: str = "",
        domains: list[str] | None = None,
        max_results: int = 5,
    ) -> str:
        """检索实时公开网页或新闻。回答近期、新闻、票价、比分、评分等问题时使用。"""
        request = _validated_request(query, topic, time_range, domains, max_results)
        if isinstance(request, str):
            return request
        response = service.search(request)
        if not response.results:
            health = service.health()
            failure = render_search_failure(response, health)
            if failure is not None:
                return failure
        if not response.results and not response.attempted_providers:
            health_by_provider = {item.provider: item for item in health}
            if (
                "tavily" in health_by_provider
                and not health_by_provider["tavily"].configured
            ):
                return "联网搜索未配置 TAVILY_API_KEY，暂时不能查询实时信息。"
        return service.format_response(response)

    return bound_web_search


def _bind_search_service(tool_item: BaseTool, service: SearchService) -> BaseTool:
    generation = getattr(service, "generation", id(service))
    object.__setattr__(tool_item, "search_generation", generation)
    object.__setattr__(tool_item, "search_service", service)
    return tool_item


def build_tools(search_service: SearchService | None = None, *, pandascore_token_getter=None) -> list[BaseTool]:
    """Build exactly one registry whose five web tools share a search service."""
    service = build_search_service() if search_service is None else search_service
    search_tools = [
        _make_web_search_tool(service),
        make_web_extract_tool(service),
        *make_entertainment_tools(service, pandascore_token_getter=pandascore_token_getter),
    ]
    return [*_LOCAL_TOOLS, *(_bind_search_service(item, service) for item in search_tools)]


TOOLS = build_tools()
_COMPATIBILITY_TOOLS = {item.name: item for item in TOOLS}
web_search = _COMPATIBILITY_TOOLS["web_search"]
web_extract = _COMPATIBILITY_TOOLS["web_extract"]
movie_ratings = _COMPATIBILITY_TOOLS["movie_ratings"]
esports_scores = _COMPATIBILITY_TOOLS["esports_scores"]
ticket_search = _COMPATIBILITY_TOOLS["ticket_search"]

__all__ = [
    "TOOLS", "build_search_service", "build_tools",
    "now", "calc", "weather", "weather_here", "my_location", "coding_status",
    "memo_add", "memo_list", "memo_del",
    "schedule_add", "schedule_list", "schedule_del",
    "todo_add", "todo_list", "todo_done",
    "sys_query",
    "web_search", "web_extract", "movie_ratings", "esports_scores", "ticket_search",
]
