"""Free-first SearchService behavior without live provider calls."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

from jarvis.search.models import (
    DEFAULT_CACHE_POLICY,
    REALTIME_CACHE_POLICY,
    ProviderCapabilities,
    SearchRequest,
    SearchResult,
)
from jarvis.search.providers.base import (
    ProviderAuthError,
    ProviderNetworkError,
    ProviderRateLimitError,
)
from jarvis.search.service import SECURITY_POLICY_VERSION, SearchService


def _result(provider, index, *, url=None, snippet="snippet"):
    return SearchResult(
        title=f"result {index}",
        url=url or f"https://{provider}.example/{index}",
        snippet=snippet,
        published_at="2026-08-11",
        provider=provider,
    )


class _StubProvider:
    def __init__(self, name, results=(), *, time_ranges=None, errors=(), configured=True):
        self.name = name
        self.capabilities = ProviderCapabilities(
            topics=frozenset(("general", "news")),
            time_ranges=frozenset(time_ranges or ("", "day", "week", "month", "year")),
        )
        self.results = tuple(results)
        self.errors = list(errors)
        self.is_configured = configured
        self.requests = []
        self.closed = False
        self.revision = "v1"

    def configured(self):
        return self.is_configured

    def configuration_token(self):
        return self.revision

    def search(self, request):
        self.requests.append(request)
        if self.errors:
            raise self.errors.pop(0)
        return self.results

    def close(self):
        self.closed = True


def test_week_skips_searxng_and_fills_from_ddgs():
    """SearXNG must never receive an unsupported week request or precede eligible DDGS."""
    searxng = _StubProvider("searxng", time_ranges=("", "day", "month", "year"))
    ddgs = _StubProvider("ddgs", [_result("ddgs", i) for i in range(3)])
    tavily = _StubProvider("tavily", [_result("tavily", 1)])
    service = SearchService([tavily, ddgs, searxng])

    response = service.search(SearchRequest("比赛", time_range="week", max_results=2))

    assert response.attempted_providers == ("ddgs",)
    assert [item.provider for item in response.results] == ["ddgs", "ddgs"]
    assert searxng.requests == []
    assert tavily.requests == []


def test_partial_results_fill_in_fixed_order_and_deduplicate_normalized_urls():
    """A short or duplicate free result set must be filled by the next provider, not returned early."""
    searxng = _StubProvider(
        "searxng",
        [
            _result("searxng", 1, url="https://Example.com/story?utm_source=feed#top"),
            _result("searxng", 2),
        ],
    )
    ddgs = _StubProvider(
        "ddgs",
        [
            _result("ddgs", 1, url="https://example.com/story"),
            _result("ddgs", 2),
        ],
    )
    tavily = _StubProvider("tavily", [_result("tavily", 1)])
    response = SearchService([tavily, ddgs, searxng]).search(
        SearchRequest("film", max_results=3)
    )

    assert response.attempted_providers == ("searxng", "ddgs")
    assert [(item.provider, item.title) for item in response.results] == [
        ("searxng", "result 1"),
        ("searxng", "result 2"),
        ("ddgs", "result 2"),
    ]


def test_unconfigured_tavily_is_skipped_and_domains_are_filtered_by_final_hostname():
    """Optional paid search and provider-side domain filtering must not weaken final enforcement."""
    searxng = _StubProvider(
        "searxng",
        [
            _result("searxng", 1, url="https://news.example.com/ok"),
            _result("searxng", 2, url="https://news.example.com.evil.test/no"),
        ],
    )
    ddgs = _StubProvider("ddgs", [])
    tavily = _StubProvider("tavily", [_result("tavily", 1)], configured=False)

    response = SearchService([tavily, ddgs, searxng]).search(
        SearchRequest("film", domains=("example.com",), max_results=2)
    )

    assert [item.url for item in response.results] == ["https://news.example.com/ok"]
    assert response.attempted_providers == ("searxng", "ddgs")
    assert tavily.requests == []


class _Clock:
    def __init__(self):
        self.value = datetime(2026, 8, 11, tzinfo=timezone.utc)

    def now(self):
        return self.value

    def advance(self, seconds):
        self.value += timedelta(seconds=seconds)


def test_cache_key_has_provider_normalized_request_and_both_policy_versions():
    """Changing provider or either policy version must never reuse a semantically stale entry."""
    provider = _StubProvider("ddgs", [_result("ddgs", 1)])
    service = SearchService([provider])

    service.search(SearchRequest("  Latest   FILMS  ", domains=("EXAMPLE.COM",), max_results=2))

    key = next(iter(service.cache_keys()))
    assert key == (
        "ddgs",
        ("latest films", "general", "", ("example.com",), 2),
        DEFAULT_CACHE_POLICY.policy_version,
        SECURITY_POLICY_VERSION,
    )


def test_default_cache_is_300_seconds_and_cache_hit_keeps_original_checked_at():
    """A cache hit must retain source freshness and expire at the exact default boundary."""
    clock = _Clock()
    provider = _StubProvider("ddgs", [_result("ddgs", 1)])
    service = SearchService([provider], now=clock.now)
    request = SearchRequest("movie")

    first = service.search(request)
    clock.advance(299)
    cached = service.search(request)
    clock.advance(1)
    service.search(request)

    assert cached.checked_at == first.checked_at
    assert len(provider.requests) == 2


def test_realtime_cache_is_60_seconds_for_scores_and_ticket_quotes():
    """Live score and ticket quote requests must expire faster than general/movie lookups."""
    for query in ("今晚比赛实时比分", "演唱会门票报价"):
        clock = _Clock()
        provider = _StubProvider("ddgs", [_result("ddgs", 1)])
        service = SearchService([provider], now=clock.now)
        request = SearchRequest(query, cache_policy=REALTIME_CACHE_POLICY)

        service.search(request)
        clock.advance(59)
        service.search(request)
        clock.advance(1)
        service.search(request)

        assert len(provider.requests) == 2


def test_network_failure_retries_once_then_opens_short_circuit():
    """Transient failures get one bounded retry and repeated failures do not hammer a provider."""
    sleeps = []
    first = _StubProvider(
        "searxng",
        errors=(ProviderNetworkError("host secret"), ProviderNetworkError("host secret")),
    )
    fallback = _StubProvider("ddgs", [_result("ddgs", 1)])
    service = SearchService([first, fallback], sleep=sleeps.append)

    one = service.search(SearchRequest("film"))
    two = service.search(SearchRequest("different film"))

    assert sleeps == [0.25]
    assert one.attempted_providers == ("searxng", "ddgs")
    assert two.attempted_providers == ("ddgs",)
    assert len(first.requests) == 2


def test_rate_limit_honors_bounded_retry_after():
    """Retry-After is honored but an upstream value cannot stall the service beyond its bound."""
    sleeps = []
    provider = _StubProvider(
        "ddgs",
        errors=(ProviderRateLimitError(retry_after=999),),
        results=(_result("ddgs", 1),),
    )
    response = SearchService([provider], sleep=sleeps.append).search(SearchRequest("film"))

    assert sleeps == [2.0]
    assert [item.provider for item in response.results] == ["ddgs"]
    assert len(provider.requests) == 2


def test_auth_failure_remains_open_until_configuration_refresh_and_health_is_redacted():
    """Bad credentials must stay suppressed, recover after refresh, and never appear in diagnostics."""
    provider = _StubProvider(
        "tavily",
        errors=(ProviderAuthError("secret-key-123"),),
        results=(_result("tavily", 1),),
    )
    service = SearchService([provider])

    service.search(SearchRequest("film"))
    service.search(SearchRequest("another film"))
    provider.revision = "v2"
    recovered = service.search(SearchRequest("third film"))

    health_text = repr(service.health())
    assert len(provider.requests) == 2
    assert [item.provider for item in recovered.results] == ["tavily"]
    assert "secret-key-123" not in health_text
    assert service.health()[0].state == "healthy"


def test_cache_hit_does_not_change_unhealthy_provider_health():
    """Serving prior data must never make a newly failing provider look healthy."""
    provider = _StubProvider("ddgs", [_result("ddgs", 1)])
    service = SearchService([provider])
    request = SearchRequest("film")
    service.search(request)
    provider.errors[:] = [ProviderAuthError("secret")]
    service.search(replace(request, query="other film"))

    service.search(request)

    assert service.health()[0].state == "auth_open"


def test_service_caps_results_snippets_rendering_and_closes_all_providers():
    """The service owns all output/resource bounds even if an adapter misbehaves."""
    providers = [
        _StubProvider(
            "ddgs",
            [_result("ddgs", i, snippet="影" * 5000) for i in range(10)],
        )
    ]
    service = SearchService(providers)

    response = service.search(SearchRequest("film", max_results=5))
    rendered = service.format_response(response)
    service.close()

    assert len(response.results) == 5
    assert all(len(item.snippet) <= 300 for item in response.results)
    assert len(rendered.encode("utf-8")) <= 10 * 1024
    assert providers[0].closed is True
