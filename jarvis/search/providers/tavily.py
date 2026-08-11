"""Thin Tavily JSON adapter with optional credentials and injected transport."""
from __future__ import annotations

import hashlib
from collections.abc import Callable

import httpx

from jarvis import config
from jarvis.search.models import ProviderCapabilities, SearchRequest, SearchResult
from jarvis.search.providers.base import (
    ProviderAuthError,
    ProviderConfigurationError,
    ProviderNetworkError,
    ProviderRateLimitError,
    ProviderResponseError,
    ProviderTimeoutError,
    clean_text,
    safe_http_url,
)


TAVILY_SEARCH_URL = "https://api.tavily.com/search"


class TavilyProvider:
    name = "tavily"
    capabilities = ProviderCapabilities(
        topics=frozenset(("general", "news")),
        time_ranges=frozenset(("", "day", "week", "month", "year")),
    )

    def __init__(
        self,
        api_key_getter: Callable[[], str] | None = None,
        transport: httpx.BaseTransport | None = None,
    ):
        self._api_key_getter = api_key_getter or config.tavily_api_key
        self._transport = transport

    def _api_key(self) -> str:
        return clean_text(self._api_key_getter())

    def configured(self) -> bool:
        return bool(self._api_key())

    def configuration_token(self) -> str:
        return hashlib.sha256(self._api_key().encode("utf-8")).hexdigest()

    def search(self, request: SearchRequest) -> tuple[SearchResult, ...]:
        api_key = self._api_key()
        if not api_key:
            raise ProviderConfigurationError("Tavily API key is not configured")
        body = {
            "query": clean_text(request.query),
            "search_depth": "basic",
            "max_results": request.max_results,
            "topic": request.topic,
            "time_range": request.time_range,
            "include_answer": False,
            "include_raw_content": False,
            "include_images": False,
            "include_domains": list(request.domains),
            "safe_search": True,
        }
        if not request.time_range:
            body.pop("time_range")
        if not request.domains:
            body.pop("include_domains")
        try:
            with httpx.Client(timeout=12, trust_env=False, transport=self._transport) as client:
                response = client.post(
                    TAVILY_SEARCH_URL,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
            if response.status_code in {401, 403}:
                raise ProviderAuthError("Tavily authentication rejected")
            if response.status_code in {429, 432, 433}:
                raise ProviderRateLimitError(
                    retry_after=_retry_after(response.headers.get("Retry-After"))
                )
            response.raise_for_status()
            payload = response.json()
        except (ProviderAuthError, ProviderRateLimitError):
            raise
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError("Tavily request timed out") from exc
        except httpx.RequestError as exc:
            raise ProviderNetworkError("Tavily network request failed") from exc
        except (TypeError, ValueError, httpx.HTTPStatusError) as exc:
            raise ProviderResponseError("Tavily response was invalid") from exc
        return _parse_results(payload, request.max_results)

    def close(self) -> None:
        return None


def _retry_after(value: str | None) -> float:
    try:
        return max(0.0, float(value or 0.0))
    except ValueError:
        return 0.0


def _parse_results(payload: object, max_results: int) -> tuple[SearchResult, ...]:
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ProviderResponseError("Tavily response was invalid")
    results = []
    for row in payload["results"]:
        if not isinstance(row, dict):
            continue
        title = clean_text(row.get("title"))
        url = safe_http_url(row.get("url"))
        if not title or not url:
            continue
        results.append(
            SearchResult(
                title=title,
                url=url,
                snippet=clean_text(row.get("content"), limit=300),
                published_at=clean_text(row.get("published_date")),
                provider="tavily",
            )
        )
        if len(results) >= max_results:
            break
    return tuple(results)
