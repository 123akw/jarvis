"""One-shot browser extraction whose every network request is SafeFetcher-backed."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import time
from urllib.parse import urlsplit

from jarvis.search.fetcher import SafeFetcher
from jarvis.search.providers.base import clean_text


MAX_BROWSER_REQUESTS = 32
MAX_BROWSER_RESPONSE_BYTES = 8 * 1024 * 1024
BROWSER_TIMEOUT_SECONDS = 15.0
RENDER_SETTLE_MILLISECONDS = 200


class BrowserUnavailable(RuntimeError):
    """The optional Playwright package or Chromium executable is unavailable."""


@dataclass(frozen=True)
class BrowserExtraction:
    url: str
    title: str
    text: str


def _sync_playwright():
    from playwright.sync_api import sync_playwright

    return sync_playwright()


class PlaywrightExtractor:
    """Render once in an isolated context with no Chromium-native HTTP access."""

    def __init__(
        self,
        fetcher: SafeFetcher,
        *,
        runtime_factory: Callable | None = None,
        max_requests: int = MAX_BROWSER_REQUESTS,
        max_response_bytes: int = MAX_BROWSER_RESPONSE_BYTES,
        timeout_seconds: float = BROWSER_TIMEOUT_SECONDS,
        settle_milliseconds: int = RENDER_SETTLE_MILLISECONDS,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._runtime_factory = runtime_factory or _sync_playwright
        self._max_requests = max(1, int(max_requests))
        self._max_response_bytes = max(1, int(max_response_bytes))
        self._timeout_seconds = max(0.001, float(timeout_seconds))
        self._settle_milliseconds = max(0, int(settle_milliseconds))
        self._monotonic = monotonic or time.monotonic

    def extract(self, url: str) -> BrowserExtraction:
        deadline = self._monotonic() + self._timeout_seconds
        try:
            manager = self._runtime_factory()
        except (ImportError, ModuleNotFoundError) as exc:
            raise BrowserUnavailable("browser unavailable") from None

        with manager as runtime:
            try:
                browser = runtime.chromium.launch(
                    timeout=max(1, int(self._remaining(deadline) * 1000))
                )
            except Exception:
                raise BrowserUnavailable("browser unavailable") from None

            context = None
            try:
                context = browser.new_context(
                    service_workers="block",
                    accept_downloads=False,
                    permissions=[],
                )
                resolved_url = url
                main_document_seen = False
                request_count = 0
                response_bytes = 0
                budget_exhausted = False

                def route_request(route) -> None:
                    nonlocal budget_exhausted
                    nonlocal main_document_seen, request_count, resolved_url, response_bytes
                    request = route.request
                    try:
                        parsed = urlsplit(request.url)
                    except (TypeError, ValueError):
                        route.abort()
                        return
                    if (
                        parsed.scheme.lower() not in {"http", "https"}
                        or request.method not in {"GET", "HEAD"}
                    ):
                        route.abort()
                        return
                    if (
                        budget_exhausted
                        or request_count >= self._max_requests
                        or self._monotonic() >= deadline
                    ):
                        budget_exhausted = True
                        route.abort()
                        return
                    request_count += 1
                    try:
                        fetched = self._fetcher.fetch(request.url)
                    except Exception:
                        route.abort()
                        return
                    next_response_bytes = response_bytes + len(fetched.content)
                    if (
                        self._monotonic() >= deadline
                        or next_response_bytes > self._max_response_bytes
                    ):
                        budget_exhausted = True
                        route.abort()
                        return
                    response_bytes = next_response_bytes
                    if request.resource_type == "document" and not main_document_seen:
                        resolved_url = fetched.url
                        main_document_seen = True
                    route.fulfill(
                        status=200,
                        headers={
                            "content-type": fetched.content_type,
                            "cache-control": "no-store",
                        },
                        body=b"" if request.method == "HEAD" else fetched.content,
                    )

                context.route("**/*", route_request)
                context.route_web_socket("**/*", lambda route: route.close())
                page = context.new_page()
                context.on(
                    "page",
                    lambda opened_page: opened_page.close() if opened_page is not page else None,
                )
                page.on("download", lambda download: download.cancel())
                page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=max(1, int(self._remaining(deadline) * 1000)),
                )
                settle_for = min(
                    self._settle_milliseconds,
                    max(0, int(self._remaining(deadline) * 1000)),
                )
                if settle_for:
                    page.wait_for_timeout(settle_for)
                return BrowserExtraction(
                    url=resolved_url,
                    title=clean_text(page.title()),
                    text=clean_text(page.locator("body").inner_text()),
                )
            finally:
                if context is not None:
                    try:
                        context.clear_cookies()
                    except Exception:
                        pass
                    try:
                        context.clear_permissions()
                    except Exception:
                        pass
                    try:
                        context.close()
                    except Exception:
                        pass
                try:
                    browser.close()
                except Exception:
                    pass

    def _remaining(self, deadline: float) -> float:
        return max(0.0, deadline - self._monotonic())
