"""贾维斯的通用实时搜索入口。"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime

import httpx
from langchain_core.tools import BaseTool, tool
from pydantic import BaseModel, Field

from jarvis.search.models import SearchRequest
from jarvis.search.providers import DDGSProvider, SearXNGProvider, TavilyProvider
from jarvis.search.service import (
    SearchService,
    cache_policy_for_query,
    render_extracted_document,
)


def _domain_values(domains: str | Sequence[str] | None) -> tuple[str, ...]:
    if domains is None or domains == "":
        return ()
    if isinstance(domains, str):
        return tuple(part.strip() for part in domains.split(",") if part.strip())
    return tuple(domains)


def _validated_request(
    query: str,
    topic: str,
    time_range: str,
    domains: str | Sequence[str] | None,
    max_results: int,
) -> SearchRequest | str:
    if not isinstance(query, str) or not query.strip():
        return "查询内容不能为空。"
    if len(query) > 300:
        return "查询内容过长，请压缩到 300 字以内。"
    if topic not in {"general", "news"}:
        return "搜索主题只接受 general 或 news。"
    if time_range not in {"", "day", "week", "month", "year", "d", "w", "m", "y"}:
        return "搜索时间范围不合法。"
    if isinstance(max_results, bool) or not isinstance(max_results, int) or not 1 <= max_results <= 5:
        return "搜索结果数量必须在 1 到 5 之间。"
    try:
        return SearchRequest(
            query=query.strip(),
            topic=topic,
            time_range=time_range,
            domains=_domain_values(domains),
            max_results=max_results,
            cache_policy=cache_policy_for_query(query),
        )
    except ValueError:
        return "搜索域名不合法。"


class TavilySearch:
    """兼容旧导入/构造/文本输出，只把搜索委派给 Tavily 适配器。"""

    def __init__(
        self,
        api_key_getter: Callable[[], str] | None = None,
        transport: httpx.BaseTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ):
        self._service = SearchService(
            [TavilyProvider(api_key_getter=api_key_getter, transport=transport)],
            now=now,
        )

    def search(
        self,
        query,
        topic="general",
        time_range="",
        domains="",
        max_results=5,
    ) -> str:
        request = _validated_request(query, topic, time_range, domains, max_results)
        if isinstance(request, str):
            return request
        response = self._service.search(request)
        health = self._service.health()[0]
        if not health.configured:
            return "联网搜索未配置 TAVILY_API_KEY，暂时不能查询实时信息。"
        if not response.results:
            if health.state == "auth_open":
                return "联网搜索认证失败，请检查 TAVILY_API_KEY。"
            if health.state == "rate_open":
                return "联网搜索触发额度或频率限制，请稍后再试或检查 Tavily 配额。"
            if health.last_error == "timeout":
                return "联网搜索请求超时，请稍后再试。"
            if health.last_error == "network":
                return "联网搜索暂时不可用（RequestError）。"
            if health.last_error == "response":
                return "联网搜索响应异常，请稍后再试。"
        return self._service.format_response(response)

    def close(self) -> None:
        self._service.close()


class WebSearchArgs(BaseModel):
    query: str = Field(description="要联网检索的问题或关键词，最多 300 字")
    topic: str = Field(
        default="general",
        description="general 查一般网页；news 查近期新闻",
    )
    time_range: str = Field(
        default="",
        description="可留空，或填 day/week/month/year 限定更新时间",
    )
    domains: list[str] = Field(
        default_factory=list,
        description="可选域名白名单，例如 ['damai.cn', 'douban.com']",
    )
    max_results: int = Field(
        default=5,
        ge=1,
        le=5,
        description="返回 1 到 5 条结果",
    )


class WebExtractArgs(BaseModel):
    url: str = Field(description="要提取正文的公开 HTTP(S) 网页 URL")


_default_service = SearchService(
    [SearXNGProvider(), DDGSProvider(), TavilyProvider()]
)


def make_web_extract_tool(service: SearchService) -> BaseTool:
    """Bind webpage extraction to the caller's fetch and browser policy service."""

    @tool("web_extract", args_schema=WebExtractArgs)
    def bound_web_extract(url: str) -> str:
        """安全提取公开网页正文；返回带来源、时间与不可信资料边界的文本。"""
        return render_extracted_document(service.extract(url))

    return bound_web_extract


web_extract = make_web_extract_tool(_default_service)


@tool(args_schema=WebSearchArgs)
def web_search(
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
    response = _default_service.search(request)
    if not response.results and not response.attempted_providers:
        health = {item.provider: item for item in _default_service.health()}
        if "tavily" in health and not health["tavily"].configured:
            return "联网搜索未配置 TAVILY_API_KEY，暂时不能查询实时信息。"
    return _default_service.format_response(response)
