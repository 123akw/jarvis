"""Immutable contracts for the web-research provider chain."""

from .models import (
    DEFAULT_CACHE_POLICY,
    REALTIME_CACHE_POLICY,
    CachePolicy,
    ExtractedDocument,
    ProviderCapabilities,
    ProviderHealth,
    SearchRequest,
    SearchResponse,
    SearchResult,
)

__all__ = [
    "DEFAULT_CACHE_POLICY",
    "REALTIME_CACHE_POLICY",
    "CachePolicy",
    "ExtractedDocument",
    "ProviderCapabilities",
    "ProviderHealth",
    "SearchRequest",
    "SearchResponse",
    "SearchResult",
]
