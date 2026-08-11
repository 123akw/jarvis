"""Thin SearXNG JSON adapter with an injectable HTTP transport."""
from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import datetime, timezone
from urllib.parse import urljoin

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
    parse_retry_after,
    provider_query,
    safe_http_url,
)


class SearXNGProvider:
    name = "searxng"
    capabilities = ProviderCapabilities(
        topics=frozenset(("general", "news")),
        time_ranges=frozenset(("", "day", "month", "year")),
    )

    def __init__(
        self,
        endpoint_getter: Callable[[], str] | None = None,
        transport: httpx.BaseTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ):
        self._endpoint_getter = endpoint_getter or (
            lambda: config.load_search_settings().endpoint_for("searxng")
        )
        self._transport = transport
        self._now = now or (lambda: datetime.now(timezone.utc))

    def _endpoint(self) -> str:
        return clean_text(self._endpoint_getter()).rstrip("/")

    def configured(self) -> bool:
        endpoint = self._endpoint()
        return endpoint.startswith("http://") or endpoint.startswith("https://")

    def configuration_token(self) -> str:
        return hashlib.sha256(self._endpoint().encode("utf-8")).hexdigest()

    def search(self, request: SearchRequest) -> tuple[SearchResult, ...]:
        endpoint = self._endpoint()
        if not self.configured():
            raise ProviderConfigurationError("SearXNG endpoint is not configured")
        params = {
            "q": provider_query(request),
            "format": "json",
            "categories": request.topic,
        }
        if request.time_range:
            params["time_range"] = request.time_range
        params["safesearch"] = 1
        try:
            with httpx.Client(timeout=12, trust_env=False, transport=self._transport) as client:
                response = client.get(urljoin(endpoint + "/", "search"), params=params)
            if response.status_code in {401, 403}:
                raise ProviderAuthError("SearXNG authentication rejected")
            if response.status_code == 429:
                raise ProviderRateLimitError(
                    retry_after=parse_retry_after(
                        response.headers.get("Retry-After"), now=self._now()
                    )
                )
            response.raise_for_status()
            payload = response.json()
        except (ProviderAuthError, ProviderRateLimitError):
            raise
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError("SearXNG request timed out") from exc
        except httpx.RequestError as exc:
            raise ProviderNetworkError("SearXNG network request failed") from exc
        except (TypeError, ValueError, httpx.HTTPStatusError) as exc:
            raise ProviderResponseError("SearXNG response was invalid") from exc
        return _parse_results(payload, request.max_results)

    def close(self) -> None:
        return None


def _parse_results(payload: object, max_results: int) -> tuple[SearchResult, ...]:
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ProviderResponseError("SearXNG response was invalid")
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
                published_at=clean_text(
                    row.get("publishedDate") or row.get("published_date")
                ),
                provider="searxng",
            )
        )
        if len(results) >= max_results:
            break
    return tuple(results)
