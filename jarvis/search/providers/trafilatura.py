"""Offline Trafilatura extraction from bytes already approved by SafeFetcher."""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass

from jarvis.search.models import FetchedDocument
from jarvis.search.providers.base import clean_text


@dataclass(frozen=True)
class StaticExtraction:
    title: str
    text: str


class ExtractionUnavailable(RuntimeError):
    """The required static extraction dependency is unavailable."""


class ExtractionFailed(RuntimeError):
    """Trafilatura could not parse a fetched document."""


def _trafilatura_extract(content: bytes, **kwargs):
    try:
        from trafilatura import extract
    except (ImportError, ModuleNotFoundError):
        raise ExtractionUnavailable("static extractor unavailable") from None

    try:
        return extract(content, **kwargs)
    except Exception:
        raise ExtractionFailed("static extraction failed") from None


class TrafilaturaExtractor:
    """Extract article fields without granting Trafilatura a network-capable URL input."""

    def __init__(self, *, extract_function: Callable | None = None) -> None:
        self._extract = extract_function or _trafilatura_extract

    def extract(self, document: FetchedDocument) -> StaticExtraction:
        payload = self._extract(
            document.content,
            url=document.url,
            output_format="json",
            include_comments=False,
            include_tables=False,
        )
        if not payload:
            return StaticExtraction(title="", text="")
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8", errors="replace")
        try:
            parsed = json.loads(payload)
        except (TypeError, json.JSONDecodeError):
            return StaticExtraction(title="", text=clean_text(payload))
        if not isinstance(parsed, dict):
            return StaticExtraction(title="", text="")
        return StaticExtraction(
            title=clean_text(parsed.get("title")),
            text=clean_text(parsed.get("text")),
        )
