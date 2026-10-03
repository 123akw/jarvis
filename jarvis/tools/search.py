"""贾维斯的通用实时搜索入口。"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime

import httpx
from langchain_core.tools import BaseTool, tool
from pydantic import BaseModel, Field

from jarvis.search.fetcher import FetchError
from jarvis.search.models import SearchRequest
from jarvis.search.providers import DDGSProvider, SearXNGProvider, TavilyProvider
from jarvis.search.service import (
    SearchService,
    cache_policy_for_query,
    render_extracted_document,
)
from jarvis.tools.failure import SEARCH_NOT_CONFIGURED, fail


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
        return fail("查询内容不能为空。")
    if len(query) > 300:
        return fail("查询内容过长，请压缩到 300 字以内。")
    if topic not in {"general", "news"}:
        return fail("搜索主题只接受 general 或 news。")
    if time_range not in {"", "day", "week", "month", "year", "d", "w", "m", "y"}:
        return fail("搜索时间范围不合法。")
    if isinstance(max_results, bool) or not isinstance(max_results, int) or not 1 <= max_results <= 5:
        return fail("搜索结果数量必须在 1 到 5 之间。")
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
            return fail("联网搜索未配置 TAVILY_API_KEY，暂时不能查询实时信息。", SEARCH_NOT_CONFIGURED)
        if not response.results:
            if health.state == "auth_open":
                return fail("联网搜索认证失败，请检查 TAVILY_API_KEY。", "联网搜索的密钥不对，请管理员检查搜索服务设置")
            if health.state == "rate_open":
                return fail("联网搜索触发额度或频率限制，请稍后再试或检查 Tavily 配额。", "联网搜索额度用完或太频繁了，请稍后再试")
            if health.last_error == "timeout":
                return fail("联网搜索请求超时，请稍后再试。")
            if health.last_error == "network":
                return fail("联网搜索暂时不可用（RequestError）。", "联网搜索暂时不可用，请稍后再试")
            if health.last_error == "response":
                return fail("联网搜索响应异常，请稍后再试。")
        return self._service.format_response(response)

    def close(self) -> None:
        self._service.close()


class WebSearchArgs(BaseModel):
    query: str = Field(description="关键词组合，最多 300 字，带上时间、地点、专有名词，如「杭州亚运会 闭幕式 时间」")
    topic: str = Field(
        default="general",
        description="general 查一般网页；news 查近期新闻（最近几天的事件用 news）",
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
    url: str = Field(description="要提取正文的公开 HTTP(S) 网页 URL，通常取自 web_search 结果里的「来源」")


_default_service = SearchService(
    [SearXNGProvider(), DDGSProvider(), TavilyProvider()]
)


def make_web_extract_tool(service: SearchService) -> BaseTool:
    """Bind webpage extraction to the caller's fetch and browser policy service."""

    @tool("web_extract", args_schema=WebExtractArgs)
    def bound_web_extract(url: str) -> str:
        """读取一个公开网页的正文（带来源、时间与不可信资料边界）。
        搜索摘要不够回答、需要看原文细节时，对搜索结果里最相关的链接使用；一个问题最多读 3 个不同网页。"""
        # 提取失败必须回失败文本而不是抛异常：异常会穿透 agent.invoke，
        # 让微信/网页整轮回复直接失败（FetchError 事故，2026-08-12）。
        try:
            return render_extracted_document(service.extract(url))
        except FetchError as exc:
            return fail(f"网页提取失败（{exc}）：该来源暂不可达，请换其他来源链接或稍后重试。", "这个网页打不开，换个链接或稍后再试")
        except ValueError:
            return fail("网页提取失败：目标地址不是可安全提取的公开 HTTP(S) 网页，请换其他来源链接。", "这个地址不是能读取的公开网页，换个链接试试")

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
    """检索实时公开网页或新闻。领导问「最近／最新／今天」的事、新闻动态、你不确定的事实时使用；
    闲聊、常识、改写类问题不要搜。一个问题最多搜 2 次，别把同一问题换个措辞反复搜。"""
    request = _validated_request(query, topic, time_range, domains, max_results)
    if isinstance(request, str):
        return request
    response = _default_service.search(request)
    if not response.results and not response.attempted_providers:
        health = {item.provider: item for item in _default_service.health()}
        if "tavily" in health and not health["tavily"].configured:
            return fail("联网搜索未配置 TAVILY_API_KEY，暂时不能查询实时信息。", SEARCH_NOT_CONFIGURED)
    return _default_service.format_response(response)
