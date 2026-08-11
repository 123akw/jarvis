"""Provider contract for the free-first web-research chain."""
from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Protocol
import unicodedata
from urllib.parse import urlparse

from jarvis.search.models import ProviderCapabilities, SearchRequest, SearchResult


class ProviderError(RuntimeError):
    """Base failure at a search-provider boundary."""


class ProviderAuthError(ProviderError):
    """Credentials were rejected and need configuration refresh."""


class ProviderRateLimitError(ProviderError):
    """The provider requested bounded retry throttling."""

    def __init__(self, message: str = "rate limited", *, retry_after: float = 0.0):
        super().__init__(message)
        self.retry_after = retry_after


class ProviderTimeoutError(ProviderError):
    """A provider request exceeded its timeout."""


class ProviderNetworkError(ProviderError):
    """A provider could not be reached."""


class ProviderResponseError(ProviderError):
    """A provider returned an invalid protocol response."""


class ProviderConfigurationError(ProviderError):
    """A provider has no usable local configuration."""


def clean_text(value: object, *, limit: int | None = None) -> str:
    """Collapse controls and whitespace in untrusted provider text."""
    if not isinstance(value, str):
        return ""
    cleaned = "".join(
        character
        for character in value
        if not unicodedata.category(character).startswith("C")
    )
    cleaned = " ".join(cleaned.split())
    return cleaned if limit is None else cleaned[:limit]


def safe_http_url(value: object) -> str:
    """Accept only absolute, credential-free HTTP(S) URLs."""
    cleaned = clean_text(value)
    try:
        parsed = urlparse(cleaned)
        port = parsed.port
    except ValueError:
        return ""
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port is not None and not 1 <= port <= 65535
    ):
        return ""
    return cleaned


def provider_query(request: SearchRequest) -> str:
    """Map the canonical domain filter into providers that lack a domain field."""
    query = clean_text(request.query)
    if not request.domains:
        return query
    clauses = [f"site:{domain}" for domain in request.domains]
    suffix = clauses[0] if len(clauses) == 1 else f"({' OR '.join(clauses)})"
    return f"{query} {suffix}"


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float:
    """Parse Retry-After delta-seconds or HTTP-date into non-negative seconds."""
    if not value:
        return 0.0
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return max(0.0, (retry_at - current).total_seconds())


class SearchProvider(Protocol):
    name: str
    capabilities: ProviderCapabilities

    def configured(self) -> bool: ...

    def configuration_token(self) -> str: ...

    def search(self, request: SearchRequest) -> Sequence[SearchResult]: ...

    def close(self) -> None: ...
