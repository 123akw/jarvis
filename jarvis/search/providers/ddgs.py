"""Thin DuckDuckGo Search adapter with an injectable client transport."""
from __future__ import annotations

import hashlib
import importlib.util

from jarvis.search.models import ProviderCapabilities, SearchRequest, SearchResult
from jarvis.search.providers.base import (
    ProviderNetworkError,
    ProviderRateLimitError,
    ProviderResponseError,
    ProviderTimeoutError,
    clean_text,
    provider_query,
    safe_http_url,
)


_TIME_LIMITS = {"": None, "day": "d", "week": "w", "month": "m", "year": "y"}


class DDGSProvider:
    name = "ddgs"
    capabilities = ProviderCapabilities(
        topics=frozenset(("general", "news")),
        time_ranges=frozenset(("", "day", "week", "month", "year")),
    )

    def __init__(self, transport=None):
        self._transport = transport

    def configured(self) -> bool:
        return self._transport is not None or importlib.util.find_spec("ddgs") is not None

    def configuration_token(self) -> str:
        state = "injected" if self._transport is not None else str(self.configured())
        return hashlib.sha256(state.encode("ascii")).hexdigest()

    def _client(self):
        if self._transport is not None:
            return self._transport
        from ddgs import DDGS

        return DDGS()

    def search(self, request: SearchRequest) -> tuple[SearchResult, ...]:
        kwargs = {
            "keywords": provider_query(request),
            "region": "wt-wt",
            "safesearch": "moderate",
            "timelimit": _TIME_LIMITS[request.time_range],
            "max_results": request.max_results,
        }
        if kwargs["timelimit"] is None:
            kwargs.pop("timelimit")
        try:
            method = self._client().news if request.topic == "news" else self._client().text
            rows = method(**kwargs)
            if not isinstance(rows, (list, tuple)):
                rows = list(rows)
        except TimeoutError as exc:
            raise ProviderTimeoutError("DDGS request timed out") from exc
        except Exception as exc:
            name = type(exc).__name__.lower()
            message = str(exc).lower()
            if "rate" in name or "ratelimit" in message or "429" in message:
                raise ProviderRateLimitError() from exc
            raise ProviderNetworkError("DDGS network request failed") from exc
        if not isinstance(rows, (list, tuple)):
            raise ProviderResponseError("DDGS response was invalid")

        results = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            title = clean_text(row.get("title"))
            url = safe_http_url(row.get("url") or row.get("href"))
            if not title or not url:
                continue
            results.append(
                SearchResult(
                    title=title,
                    url=url,
                    snippet=clean_text(row.get("body") or row.get("snippet"), limit=300),
                    published_at=clean_text(row.get("date")),
                    provider="ddgs",
                )
            )
            if len(results) >= request.max_results:
                break
        return tuple(results)

    def close(self) -> None:
        close = getattr(self._transport, "close", None)
        if callable(close):
            close()
