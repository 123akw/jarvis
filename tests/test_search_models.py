from dataclasses import FrozenInstanceError

import pytest

from jarvis.search.models import (
    DEFAULT_CACHE_POLICY,
    REALTIME_CACHE_POLICY,
    SearchRequest,
    SearchResult,
)


def test_search_request_expands_short_time_aliases():
    """Would fail if aliases reached a provider instead of canonical time ranges."""
    assert SearchRequest(query="latest", time_range="d").time_range == "day"
    assert SearchRequest(query="latest", time_range="w").time_range == "week"
    assert SearchRequest(query="latest", time_range="m").time_range == "month"
    assert SearchRequest(query="latest", time_range="y").time_range == "year"


def test_search_request_canonicalizes_domains():
    """Would fail if equivalent domain spellings produced distinct provider queries."""
    request = SearchRequest(
        query="example",
        domains=("HTTPS://Example.COM/path", "example.com.", "EXAMPLE.com"),
    )

    assert request.domains == ("example.com",)


@pytest.mark.parametrize("max_results", [0, 6])
def test_search_request_rejects_result_counts_outside_provider_bounds(max_results):
    """Would fail if requests outside the five-result provider contract were sent."""
    with pytest.raises(ValueError, match="max_results"):
        SearchRequest(query="example", max_results=max_results)


def test_search_models_are_immutable():
    """Would fail if callers could mutate a request or result after cache-key creation."""
    request = SearchRequest(query="example")
    result = SearchResult(
        title="Example",
        url="https://example.com",
        snippet="A result",
        published_at="2026-08-11T00:00:00Z",
        provider="ddgs",
    )

    with pytest.raises(FrozenInstanceError):
        request.query = "changed"
    with pytest.raises(FrozenInstanceError):
        result.title = "changed"


def test_cache_policies_distinguish_general_and_realtime_queries():
    """Would fail if scores and tickets inherited the stale five-minute cache."""
    assert (DEFAULT_CACHE_POLICY.ttl_seconds, DEFAULT_CACHE_POLICY.policy_version) == (300, "web-v1")
    assert (REALTIME_CACHE_POLICY.ttl_seconds, REALTIME_CACHE_POLICY.policy_version) == (60, "realtime-v1")
