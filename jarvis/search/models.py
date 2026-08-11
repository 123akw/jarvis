"""Value objects shared by all public-web search providers."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from urllib.parse import urlparse


TimeRange = Literal["", "day", "week", "month", "year"]
SearchTopic = Literal["general", "news"]
_TIME_RANGE_ALIASES = {"d": "day", "w": "week", "m": "month", "y": "year"}
_TIME_RANGES = frozenset(("", "day", "week", "month", "year"))
_TOPICS = frozenset(("general", "news"))
_MAX_RESULTS = 5


def normalize_time_range(value: str) -> TimeRange:
    """Return the provider-neutral spelling for a supported time range."""
    normalized = value.strip().lower() if isinstance(value, str) else value
    normalized = _TIME_RANGE_ALIASES.get(normalized, normalized)
    if normalized not in _TIME_RANGES:
        raise ValueError("time_range must be one of '', day, week, month, or year")
    return normalized


def canonicalize_domain(value: str) -> str:
    """Normalize a host or HTTP(S) URL into a lower-case hostname."""
    if not isinstance(value, str):
        raise ValueError("domains must contain strings")
    candidate = value.strip()
    if not candidate:
        raise ValueError("domains must not contain empty values")

    parsed = urlparse(candidate if "://" in candidate else f"//{candidate}")
    if parsed.scheme and parsed.scheme not in {"http", "https"}:
        raise ValueError("domains must be hostnames or HTTP(S) URLs")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("domains must contain valid hostnames")
    try:
        return hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise ValueError("domains must contain valid hostnames") from exc


def normalize_domains(values: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """Canonicalize domains while retaining the caller's fallback order."""
    canonical = tuple(canonicalize_domain(value) for value in values)
    return tuple(dict.fromkeys(canonical))


def validate_max_results(value: int) -> int:
    """Ensure every provider receives its common one-to-five result bound."""
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= _MAX_RESULTS:
        raise ValueError("max_results must be between 1 and 5")
    return value


@dataclass(frozen=True)
class CachePolicy:
    ttl_seconds: int
    policy_version: str


DEFAULT_CACHE_POLICY = CachePolicy(ttl_seconds=300, policy_version="web-v1")
REALTIME_CACHE_POLICY = CachePolicy(ttl_seconds=60, policy_version="realtime-v1")


@dataclass(frozen=True)
class SearchRequest:
    query: str
    topic: SearchTopic = "general"
    time_range: TimeRange = ""
    domains: tuple[str, ...] = ()
    max_results: int = 5
    cache_policy: CachePolicy = DEFAULT_CACHE_POLICY

    def __post_init__(self) -> None:
        if not isinstance(self.query, str) or not self.query.strip():
            raise ValueError("query must not be empty")
        if self.topic not in _TOPICS:
            raise ValueError("topic must be general or news")
        object.__setattr__(self, "time_range", normalize_time_range(self.time_range))
        object.__setattr__(self, "domains", normalize_domains(tuple(self.domains)))
        object.__setattr__(self, "max_results", validate_max_results(self.max_results))


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    published_at: str
    provider: str


@dataclass(frozen=True)
class FetchedDocument:
    """A bounded public response whose network peer passed address policy."""

    url: str
    content: bytes
    content_type: str
    peer_ip: str
    status_code: int = 200
    headers: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "headers", tuple(self.headers))


@dataclass(frozen=True)
class ExtractedDocument:
    """Sanitized article text plus the provenance needed at the trust boundary."""

    url: str
    title: str
    text: str
    checked_at: datetime
    provider: str


@dataclass(frozen=True)
class SearchResponse:
    results: tuple[SearchResult, ...]
    checked_at: datetime
    attempted_providers: tuple[str, ...]
    stale: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "results", tuple(self.results))
        object.__setattr__(self, "attempted_providers", tuple(self.attempted_providers))


@dataclass(frozen=True)
class ProviderCapabilities:
    topics: frozenset[str]
    time_ranges: frozenset[str]

    def __post_init__(self) -> None:
        object.__setattr__(self, "topics", frozenset(self.topics))
        object.__setattr__(self, "time_ranges", frozenset(self.time_ranges))


@dataclass(frozen=True)
class ProviderHealth:
    """A credential-free provider status snapshot safe for diagnostics."""

    provider: str
    configured: bool
    state: str
    consecutive_failures: int = 0
    last_error: str = ""
