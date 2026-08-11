"""Provider contract for the free-first web-research chain."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from jarvis.search.models import ProviderCapabilities, SearchRequest, SearchResult


class SearchProvider(Protocol):
    name: str
    capabilities: ProviderCapabilities

    def configured(self) -> bool: ...

    def search(self, request: SearchRequest) -> Sequence[SearchResult]: ...

    def close(self) -> None: ...
