"""Search provider contract tests with every external boundary injected."""
from __future__ import annotations

import json

import httpx
import pytest

from jarvis.search.models import SearchRequest
from jarvis.search.providers.base import ProviderResponseError
from jarvis.search.providers.ddgs import DDGSProvider
from jarvis.search.providers.searxng import SearXNGProvider
from jarvis.search.providers.tavily import TavilyProvider


def test_searxng_maps_request_and_drops_malformed_rows():
    """A wrong SearXNG mapping or permissive row parser would fail this boundary contract."""
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "query": "latest films",
                "number_of_results": 3,
                "results": [
                    {
                        "title": "Film release",
                        "url": "https://news.example/story",
                        "content": "Official release notes",
                        "publishedDate": "2026-08-11",
                        "engine": "bing",
                        "score": 1.0,
                    },
                    {"title": "unsafe", "url": "file:///etc/passwd", "content": "x"},
                    "not-a-row",
                ],
                "answers": [],
                "corrections": [],
                "infoboxes": [],
                "suggestions": [],
                "unresponsive_engines": [],
            },
        )

    provider = SearXNGProvider(
        endpoint_getter=lambda: "https://search.example/",
        transport=httpx.MockTransport(handler),
    )
    results = provider.search(
        SearchRequest(
            " latest   films ",
            topic="news",
            time_range="day",
            domains=("news.example",),
            max_results=3,
        )
    )

    assert str(seen[0].url) == (
        "https://search.example/search?q=latest+films+site%3Anews.example"
        "&format=json&categories=news&time_range=day&safesearch=1"
    )
    assert [(item.title, item.snippet, item.published_at, item.provider) for item in results] == [
        ("Film release", "Official release notes", "2026-08-11", "searxng")
    ]


class _DDGSTransport:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def text(self, **kwargs):
        self.calls.append(("text", kwargs))
        return self.rows

    def news(self, **kwargs):
        self.calls.append(("news", kwargs))
        return self.rows


def test_ddgs_maps_news_request_and_normalizes_rows():
    """Wrong DDGS method, timelimit, or row field mapping would fail this test."""
    transport = _DDGSTransport(
        [
            {
                "date": "2026-08-11T01:00:00+00:00",
                "title": "Tournament result",
                "body": "The final score was published.",
                "url": "https://sport.example/final",
                "image": "https://sport.example/image.jpg",
                "source": "Sport Example",
            },
            {"title": "missing URL", "body": "ignored"},
        ]
    )
    provider = DDGSProvider(transport=transport)

    results = provider.search(
        SearchRequest(
            "world final",
            topic="news",
            time_range="week",
            domains=("sport.example",),
            max_results=2,
        )
    )

    assert transport.calls == [
        (
            "news",
            {
                "keywords": "world final site:sport.example",
                "region": "wt-wt",
                "safesearch": "moderate",
                "timelimit": "w",
                "max_results": 2,
            },
        )
    ]
    assert [(item.url, item.snippet, item.provider) for item in results] == [
        ("https://sport.example/final", "The final score was published.", "ddgs")
    ]


def test_tavily_maps_exact_request_and_empty_results():
    """A Tavily payload drift or treating a valid empty response as malformed would fail."""
    seen = []

    def handler(request):
        seen.append((str(request.url), request.headers, json.loads(request.content)))
        return httpx.Response(
            200,
            json={
                "query": "film",
                "answer": None,
                "images": [],
                "results": [],
                "response_time": "0.1",
                "request_id": "req-1",
            },
        )

    provider = TavilyProvider(
        api_key_getter=lambda: "tvly-secret",
        transport=httpx.MockTransport(handler),
    )

    assert provider.search(
        SearchRequest(
            "film",
            topic="general",
            time_range="month",
            domains=("example.com",),
            max_results=4,
        )
    ) == ()
    url, headers, body = seen[0]
    assert url == "https://api.tavily.com/search"
    assert headers["authorization"] == "Bearer tvly-secret"
    assert body == {
        "query": "film",
        "search_depth": "basic",
        "max_results": 4,
        "topic": "general",
        "time_range": "month",
        "include_answer": False,
        "include_raw_content": False,
        "include_images": False,
        "include_domains": ["example.com"],
        "safe_search": True,
    }


@pytest.mark.parametrize(
    ("provider"),
    [
        SearXNGProvider(
            endpoint_getter=lambda: "https://search.example",
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(200, json={"unexpected": []})
            ),
        ),
        TavilyProvider(
            api_key_getter=lambda: "tvly-test",
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(200, json={"unexpected": []})
            ),
        ),
    ],
    ids=["searxng", "tavily"],
)
def test_http_providers_reject_malformed_payloads(provider):
    """Missing result arrays must remain protocol failures, not valid empty searches."""
    with pytest.raises(ProviderResponseError):
        provider.search(SearchRequest("film"))


def test_provider_snippets_are_capped_at_300_characters():
    """An upstream provider cannot inject an unbounded snippet into later rendering."""
    provider = DDGSProvider(
        transport=_DDGSTransport(
            [{"title": "Long", "href": "https://example.com", "body": "x" * 301}]
        )
    )

    result = provider.search(SearchRequest("film"))[0]

    assert len(result.snippet) == 300
