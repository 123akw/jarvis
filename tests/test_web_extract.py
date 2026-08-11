"""Safe static and browser-assisted extraction without network or a real browser."""
from __future__ import annotations

import json
import platform
from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from jarvis.search.fetcher import FetchError
from jarvis.search.models import FetchedDocument


PUBLIC_URL = "https://public.example/article"
FINAL_URL = "https://public.example/article/final"


def _api():
    try:
        from jarvis.search.models import ExtractedDocument
        from jarvis.search.providers.playwright import (
            BrowserUnavailable,
            PlaywrightExtractor,
            ProcessNetworkSandbox,
        )
        from jarvis.search.providers.trafilatura import (
            ExtractionFailed,
            ExtractionUnavailable,
            TrafilaturaExtractor,
        )
        from jarvis.search.service import SearchService, render_extracted_document
        from jarvis.tools.search import make_web_extract_tool
    except (ImportError, ModuleNotFoundError) as exc:
        pytest.fail(f"web extraction API is not implemented: {type(exc).__name__}")
    return SimpleNamespace(
        BrowserUnavailable=BrowserUnavailable,
        ExtractionFailed=ExtractionFailed,
        ExtractionUnavailable=ExtractionUnavailable,
        ExtractedDocument=ExtractedDocument,
        PlaywrightExtractor=PlaywrightExtractor,
        ProcessNetworkSandbox=ProcessNetworkSandbox,
        SearchService=SearchService,
        TrafilaturaExtractor=TrafilaturaExtractor,
        make_web_extract_tool=make_web_extract_tool,
        render_extracted_document=render_extracted_document,
    )


class _StubFetcher:
    def __init__(self, responses=None, *, rejected=()):
        self.responses = dict(responses or {})
        self.rejected = set(rejected)
        self.calls = []
        self.call_options = []

    def fetch(self, url, **kwargs):
        self.calls.append(url)
        self.call_options.append(kwargs)
        if url in self.rejected:
            raise FetchError("public address required")
        document = self.responses.get(
            url,
            FetchedDocument(
                url=url,
                content=b"<html><body>approved</body></html>",
                content_type="text/html",
                peer_ip="93.184.216.34",
            ),
        )
        wire_limit = kwargs.get("max_wire_bytes")
        decoded_limit = kwargs.get("max_decompressed_bytes")
        if wire_limit is not None and len(document.content) > wire_limit:
            raise FetchError("wire response exceeded limit")
        if decoded_limit is not None and len(document.content) > decoded_limit:
            raise FetchError("decompressed response exceeded limit")
        return document


class _StaticExtractor:
    def __init__(self, text, *, title="Static title"):
        self.result = SimpleNamespace(title=title, text=text)
        self.calls = []

    def extract(self, document):
        self.calls.append(document)
        return self.result


class _DynamicExtractor:
    def __init__(self, text="D" * 240, *, error=None):
        self.result = SimpleNamespace(url=FINAL_URL, title="Dynamic title", text=text)
        self.error = error
        self.calls = []

    def extract(self, url):
        self.calls.append(url)
        if self.error:
            raise self.error
        return self.result


def _fetched(content=b"<html><title>Story</title><body>text</body></html>"):
    return FetchedDocument(
        url=FINAL_URL,
        content=content,
        content_type="text/html",
        peer_ip="93.184.216.34",
    )


def test_trafilatura_receives_safe_fetched_bytes_instead_of_a_url():
    """Passing a URL to Trafilatura would let the parser bypass SafeFetcher."""
    api = _api()
    calls = []

    def fake_extract(content, **kwargs):
        calls.append((content, kwargs))
        return json.dumps({"title": "Fetched title", "text": "正文" * 120})

    result = api.TrafilaturaExtractor(extract_function=fake_extract).extract(_fetched())

    assert calls[0][0] == _fetched().content
    assert isinstance(calls[0][0], bytes)
    assert calls[0][1]["url"] == FINAL_URL
    assert result.title == "Fetched title"
    assert result.text == "正文" * 120


def test_static_extraction_that_is_sufficient_never_starts_dynamic_fallback():
    """Removing the sufficiency gate would start a browser for every ordinary article."""
    api = _api()
    fetcher = _StubFetcher({PUBLIC_URL: _fetched()})
    static = _StaticExtractor("S" * 240)
    dynamic = _DynamicExtractor()
    service = api.SearchService(
        [], fetcher=fetcher, static_extractor=static, dynamic_extractor=dynamic
    )

    result = service.extract(PUBLIC_URL)

    assert result.url == FINAL_URL
    assert result.provider == "trafilatura"
    assert result.text == "S" * 240
    assert dynamic.calls == []


def test_insufficient_static_extraction_uses_dynamic_fallback_exactly_once():
    """A missing or repeated fallback would lose rendered pages or amplify browser work."""
    api = _api()
    fetcher = _StubFetcher({PUBLIC_URL: _fetched()})
    static = _StaticExtractor("short")
    dynamic = _DynamicExtractor()
    service = api.SearchService(
        [], fetcher=fetcher, static_extractor=static, dynamic_extractor=dynamic
    )

    result = service.extract(PUBLIC_URL)

    assert dynamic.calls == [FINAL_URL]
    assert result.url == FINAL_URL
    assert result.provider == "playwright"
    assert result.text == "D" * 240


def test_missing_browser_gracefully_keeps_the_static_result():
    """An optional browser installation must not turn a bounded static result into an error."""
    api = _api()
    static = _StaticExtractor("short")
    dynamic = _DynamicExtractor(error=api.BrowserUnavailable("browser unavailable"))
    service = api.SearchService(
        [],
        fetcher=_StubFetcher({PUBLIC_URL: _fetched()}),
        static_extractor=static,
        dynamic_extractor=dynamic,
    )

    result = service.extract(PUBLIC_URL)

    assert result.provider == "trafilatura"
    assert result.text == "short"
    assert dynamic.calls == [FINAL_URL]


def test_expected_static_extraction_failure_uses_dynamic_fallback():
    """A known parser failure is another insufficient-static result, not an empty success."""
    api = _api()

    class ExpectedFailure:
        def extract(self, _document):
            raise api.ExtractionFailed("parser rejected document")

    dynamic = _DynamicExtractor()
    service = api.SearchService(
        [],
        fetcher=_StubFetcher({PUBLIC_URL: _fetched()}),
        static_extractor=ExpectedFailure(),
        dynamic_extractor=dynamic,
    )

    result = service.extract(PUBLIC_URL)

    assert dynamic.calls == [FINAL_URL]
    assert result.provider == "playwright"


def test_unexpected_static_programming_error_is_not_swallowed_or_browserized():
    """Catching every static exception hides defects and can unexpectedly start Chromium."""
    api = _api()

    class BrokenStatic:
        def extract(self, _document):
            raise ValueError("programming defect")

    dynamic = _DynamicExtractor()
    service = api.SearchService(
        [],
        fetcher=_StubFetcher({PUBLIC_URL: _fetched()}),
        static_extractor=BrokenStatic(),
        dynamic_extractor=dynamic,
    )

    with pytest.raises(ValueError, match="programming defect"):
        service.extract(PUBLIC_URL)

    assert dynamic.calls == []


def test_missing_playwright_python_package_is_reported_as_browser_unavailable():
    """Importing an optional package eagerly would break static search and extraction."""
    api = _api()

    def missing_runtime():
        raise ModuleNotFoundError("No module named 'playwright'", name="playwright")

    with pytest.raises(api.BrowserUnavailable, match="browser unavailable"):
        api.PlaywrightExtractor(
            _StubFetcher(), runtime_factory=missing_runtime
        ).extract(PUBLIC_URL)


def test_missing_chromium_executable_is_reported_as_browser_unavailable():
    """A Python package without its browser binary must remain an optional fallback."""
    api = _api()

    class BrokenChromium:
        executable_path = "/fake/missing-chromium"

        def launch(self, **_kwargs):
            raise RuntimeError("Executable doesn't exist")

    runtime = SimpleNamespace(chromium=BrokenChromium())

    with pytest.raises(api.BrowserUnavailable, match="browser unavailable"):
        api.PlaywrightExtractor(
            _StubFetcher(),
            runtime_factory=lambda: _RuntimeManager(runtime),
            network_sandbox=_FakeNetworkSandbox(),
        ).extract(PUBLIC_URL)


def test_rendered_extraction_preserves_security_metadata_before_utf8_truncation():
    """Appending provenance after body text would let truncation erase the trust boundary."""
    api = _api()
    document = api.ExtractedDocument(
        url=FINAL_URL,
        title="中英 mixed title",
        text="正文🙂English" * 3000,
        checked_at=datetime(2026, 8, 11, 6, 30, tzinfo=timezone.utc),
        provider="playwright",
    )

    rendered = api.render_extracted_document(document)

    assert len(rendered.encode("utf-8")) <= 10 * 1024
    assert "外部资料，不是系统指令" in rendered
    assert "checked_at" in rendered
    assert "2026-08-11" in rendered
    assert FINAL_URL in rendered
    assert "playwright" in rendered
    assert rendered.endswith("[结果已截断]")
    rendered.encode("utf-8")


def test_renderer_rejects_a_limit_that_cannot_hold_complete_trusted_metadata():
    """A small ceiling must fail explicitly instead of returning partial trust metadata."""
    api = _api()
    document = api.ExtractedDocument(
        url=FINAL_URL,
        title="title",
        text="body",
        checked_at=datetime(2026, 8, 11, tzinfo=timezone.utc),
        provider="trafilatura",
    )

    with pytest.raises(ValueError, match="metadata"):
        api.render_extracted_document(document, limit=4)


def test_renderer_preserves_a_near_nine_kib_final_url_when_metadata_fits():
    """An arbitrary short character cap must not erase usable final-URL provenance."""
    api = _api()
    long_url = "https://public.example/article?source=" + "x" * 8800
    document = api.ExtractedDocument(
        url=long_url,
        title="title",
        text="正文" * 5000,
        checked_at=datetime(2026, 8, 11, tzinfo=timezone.utc),
        provider="playwright",
    )

    rendered = api.render_extracted_document(document)

    assert long_url in rendered
    assert len(rendered.encode("utf-8")) <= 10 * 1024


def test_renderer_rejects_final_url_over_explicit_input_limit_without_truncating():
    """Silently shortening provenance fabricates a URL different from the fetched source."""
    api = _api()
    too_long_url = "https://public.example/article?source=" + "x" * 9300
    document = api.ExtractedDocument(
        url=too_long_url,
        title="title",
        text="body",
        checked_at=datetime(2026, 8, 11, tzinfo=timezone.utc),
        provider="playwright",
    )

    with pytest.raises(ValueError, match="URL"):
        api.render_extracted_document(document)


def test_extracted_document_is_exported_as_a_public_search_contract():
    """Omitting the new model from the package export breaks the established import surface."""
    api = _api()
    from jarvis.search import ExtractedDocument

    assert ExtractedDocument is api.ExtractedDocument


def test_web_extract_tool_is_bound_to_the_service_passed_to_its_factory():
    """Binding to the module global would make injected policy and fetch fakes ineffective."""
    api = _api()
    checked_at = datetime(2026, 8, 11, tzinfo=timezone.utc)

    class BoundService:
        def __init__(self, provider):
            self.provider = provider
            self.calls = []

        def extract(self, url):
            self.calls.append(url)
            return api.ExtractedDocument(
                url=url,
                title="title",
                text="body",
                checked_at=checked_at,
                provider=self.provider,
            )

    first_service = BoundService("first")
    second_service = BoundService("second")
    first = api.make_web_extract_tool(first_service)
    second = api.make_web_extract_tool(second_service)

    assert first.name == "web_extract"
    assert "first" in first.invoke({"url": "https://one.example/page"})
    assert "second" in second.invoke({"url": "https://two.example/page"})
    assert first_service.calls == ["https://one.example/page"]
    assert second_service.calls == ["https://two.example/page"]


class _FakeRoute:
    def __init__(self, request):
        self.request = request
        self.fulfilled = None
        self.aborted = False

    def fulfill(self, **kwargs):
        self.fulfilled = kwargs

    def abort(self):
        self.aborted = True


class _FakeWebSocketRoute:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class _FakePopup:
    def __init__(self):
        self.closed = False
        self.close_calls = 0

    def close(self):
        self.closed = True
        self.close_calls += 1


class _FakeDownload:
    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True


class _FakeLocator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    def inner_text(self, *, timeout):
        self.page.dom_timeouts.append(("body", timeout))
        if self.page.block_dom:
            raise TimeoutError("body blocked")
        if self.page.waited_milliseconds:
            return "Rendered body " * 30
        return "DOMContentLoaded body"

    def text_content(self, *, timeout):
        self.page.dom_timeouts.append(("title", timeout))
        if self.page.block_dom:
            raise TimeoutError("title blocked")
        return "Rendered title"


class _FakePage:
    def __init__(self, context, requests):
        self.context = context
        self.requests = requests
        self.events = {}
        self.routes = []
        self.popup = _FakePopup()
        self.download = _FakeDownload()
        self.waited_milliseconds = []
        self.dom_timeouts = []
        self.block_dom = False

    def on(self, event, callback):
        self.events.setdefault(event, []).append(callback)

    def goto(self, url, **kwargs):
        self.goto_call = (url, kwargs)
        for request in self.requests:
            route = _FakeRoute(request)
            self.routes.append(route)
            self.context.route_handler(route)
        for callback in self.context.events.get("page", ()):
            callback(self.popup)
        for callback in self.events.get("popup", ()):
            callback(self.popup)
        for callback in self.events.get("download", ()):
            callback(self.download)

    def wait_for_timeout(self, milliseconds):
        self.waited_milliseconds.append(milliseconds)

    def locator(self, selector):
        assert selector in {"body", "title"}
        return _FakeLocator(self, selector)


class _FakeContext:
    def __init__(self, requests):
        self.page = _FakePage(self, requests)
        self.events = {}
        self.route_handler = None
        self.websocket_handler = None
        self.cookies_cleared = False
        self.permissions_cleared = False
        self.closed = False

    def route(self, pattern, handler):
        assert pattern == "**/*"
        self.route_handler = handler

    def route_web_socket(self, pattern, handler):
        assert pattern == "**/*"
        self.websocket_handler = handler

    def on(self, event, callback):
        self.events.setdefault(event, []).append(callback)

    def new_page(self):
        return self.page

    def clear_cookies(self):
        self.cookies_cleared = True

    def clear_permissions(self):
        self.permissions_cleared = True

    def close(self):
        self.closed = True


class _FakeBrowser:
    def __init__(self, requests):
        self.requests = requests
        self.context_options = None
        self.context = None
        self.closed = False

    def new_context(self, **kwargs):
        self.context_options = kwargs
        self.context = _FakeContext(self.requests)
        return self.context

    def close(self):
        self.closed = True


class _FakeChromium:
    def __init__(self, browser):
        self.browser = browser
        self.launch_calls = 0
        self.executable_path = "/fake/chromium"

    def launch(self, **kwargs):
        self.launch_calls += 1
        self.launch_options = kwargs
        return self.browser


class _RuntimeManager:
    def __init__(self, runtime):
        self.runtime = runtime
        self.exited = False

    def __enter__(self):
        return self.runtime

    def __exit__(self, *_args):
        self.exited = True


class _FakeNetworkSandbox:
    def __init__(self, *, available=True):
        self.available = available
        self.executables = []
        self.wrapper_path = "/fake/network-denied-chromium"

    @contextmanager
    def guarded_executable(self, executable_path):
        self.executables.append(executable_path)
        if not self.available:
            raise RuntimeError("network sandbox unavailable")
        yield self.wrapper_path


def _browser_fixture(request_specs, *, rejected=()):
    requests = [SimpleNamespace(**spec) for spec in request_specs]
    browser = _FakeBrowser(requests)
    manager = _RuntimeManager(SimpleNamespace(chromium=_FakeChromium(browser)))
    manager.network_sandbox = _FakeNetworkSandbox()
    fetcher = _StubFetcher(
        {
            PUBLIC_URL: FetchedDocument(
                url=FINAL_URL,
                content=b"<html><body>Main document</body></html>",
                content_type="text/html",
                peer_ip="93.184.216.34",
            )
        },
        rejected=rejected,
    )
    return fetcher, browser, manager


def _browser_extractor(api, fetcher, manager, **kwargs):
    return api.PlaywrightExtractor(
        fetcher,
        runtime_factory=lambda: manager,
        network_sandbox=manager.network_sandbox,
        **kwargs,
    )


def test_browser_is_unavailable_when_verified_os_network_sandbox_is_unavailable():
    """Route interception cannot block WebRTC, ICE, STUN, or WebTransport native egress."""
    api = _api()
    fetcher, browser, manager = _browser_fixture(
        [{"url": PUBLIC_URL, "method": "GET", "resource_type": "document"}]
    )
    manager.network_sandbox = _FakeNetworkSandbox(available=False)

    with pytest.raises(api.BrowserUnavailable, match="browser unavailable"):
        _browser_extractor(api, fetcher, manager).extract(PUBLIC_URL)

    assert manager.runtime.chromium.launch_calls == 0
    assert browser.context is None


def test_browser_launches_only_wrapped_executable_with_fail_closed_network_flags():
    """Defense-in-depth flags must accompany, not replace, the verified OS sandbox wrapper."""
    api = _api()
    fetcher, browser, manager = _browser_fixture(
        [{"url": PUBLIC_URL, "method": "GET", "resource_type": "document"}]
    )

    _browser_extractor(api, fetcher, manager).extract(PUBLIC_URL)

    options = manager.runtime.chromium.launch_options
    assert manager.network_sandbox.executables == ["/fake/chromium"]
    assert options["executable_path"] == manager.network_sandbox.wrapper_path
    flags = set(options["args"])
    assert "--proxy-server=http://127.0.0.1:9" in flags
    assert "--host-resolver-rules=MAP * ~NOTFOUND" in flags
    assert "--disable-webrtc" in flags
    assert "--disable-quic" in flags
    assert any("WebTransport" in flag for flag in flags)


@pytest.mark.skipif(platform.system() != "Darwin", reason="macOS sandbox-exec probe")
def test_macos_network_sandbox_helper_denies_ipv4_and_ipv6_network_operations():
    """The production guard must verify deny-network behavior using only loopback probes."""
    api = _api()

    guard = api.ProcessNetworkSandbox()

    assert guard.verified() is True


@pytest.mark.parametrize("resource_type", ("iframe", "script", "xhr", "fetch"))
def test_browser_aborts_every_child_request_rejected_by_safe_fetcher(resource_type):
    """Skipping one child resource type would reopen a browser-side SSRF bypass."""
    api = _api()
    blocked = f"https://private.example/{resource_type}"
    fetcher, browser, manager = _browser_fixture(
        [
            {"url": PUBLIC_URL, "method": "GET", "resource_type": "document"},
            {"url": blocked, "method": "GET", "resource_type": resource_type},
        ],
        rejected=(blocked,),
    )

    result = _browser_extractor(api, fetcher, manager).extract(PUBLIC_URL)

    main_route, child_route = browser.context.page.routes
    assert main_route.fulfilled["body"].startswith(b"<html>")
    assert child_route.aborted is True
    assert child_route.fulfilled is None
    assert fetcher.calls == [PUBLIC_URL, blocked]
    assert result.url == FINAL_URL


def test_browser_routes_http_get_and_head_through_safe_fetcher_and_never_natively():
    """An approved-address precheck must not authorize Chromium to reconnect itself."""
    api = _api()
    script = "https://cdn.public.example/app.js"
    probe = "https://cdn.public.example/probe"
    fetcher, browser, manager = _browser_fixture(
        [
            {"url": PUBLIC_URL, "method": "GET", "resource_type": "document"},
            {"url": script, "method": "GET", "resource_type": "script"},
            {"url": probe, "method": "HEAD", "resource_type": "fetch"},
        ]
    )
    fetcher.responses[probe] = FetchedDocument(
        url=probe,
        content=b"",
        content_type="text/plain",
        peer_ip="93.184.216.34",
        status_code=404,
        headers=(
            ("content-type", "text/plain"),
            ("content-length", "0"),
            ("access-control-allow-origin", "*"),
        ),
    )

    result = _browser_extractor(api, fetcher, manager).extract(PUBLIC_URL)

    routes = browser.context.page.routes
    assert fetcher.calls == [PUBLIC_URL, script, probe]
    assert all(route.fulfilled is not None for route in routes)
    assert routes[2].fulfilled["body"] == b""
    assert routes[2].fulfilled["status"] == 404
    assert routes[2].fulfilled["headers"] == {
        "content-type": "text/plain",
        "content-length": "0",
        "access-control-allow-origin": "*",
    }
    assert fetcher.call_options[2]["method"] == "HEAD"
    assert fetcher.call_options[2]["allow_http_errors"] is True
    assert result.text.startswith("Rendered body")
    assert browser.context.page.goto_call[0] == PUBLIC_URL


def test_browser_caps_aggregate_safe_fetch_requests():
    """Without a request budget, a page can amplify one extraction into unbounded fetches."""
    api = _api()
    child = "https://cdn.public.example/app.js"
    fetcher, browser, manager = _browser_fixture(
        [
            {"url": PUBLIC_URL, "method": "GET", "resource_type": "document"},
            {"url": child, "method": "GET", "resource_type": "script"},
        ]
    )

    _browser_extractor(api, fetcher, manager, max_requests=1).extract(PUBLIC_URL)

    assert fetcher.calls == [PUBLIC_URL]
    assert browser.context.page.routes[1].aborted is True


def test_browser_caps_cumulative_fetched_bytes_before_processing_more_requests():
    """Per-request SafeFetcher limits alone do not bound aggregate browser extraction bytes."""
    api = _api()
    child = "https://cdn.public.example/app.js"
    fetcher, browser, manager = _browser_fixture(
        [
            {"url": PUBLIC_URL, "method": "GET", "resource_type": "document"},
            {"url": child, "method": "GET", "resource_type": "script"},
        ]
    )

    _browser_extractor(
        api, fetcher, manager, max_response_bytes=1
    ).extract(PUBLIC_URL)

    assert fetcher.calls == [PUBLIC_URL, child]
    assert all(route.aborted for route in browser.context.page.routes)
    assert all(options["max_wire_bytes"] == 1 for options in fetcher.call_options)
    assert all(options["max_decompressed_bytes"] == 1 for options in fetcher.call_options)


def test_browser_caps_total_wall_clock_across_safe_fetches():
    """Sequential bounded fetches must not multiply into an unbounded extraction deadline."""
    api = _api()

    class Clock:
        value = 0.0

        def monotonic(self):
            return self.value

    clock = Clock()
    fetcher, browser, manager = _browser_fixture(
        [
            {"url": PUBLIC_URL, "method": "GET", "resource_type": "document"},
            {
                "url": "https://cdn.public.example/app.js",
                "method": "GET",
                "resource_type": "script",
            },
        ]
    )
    original_fetch = fetcher.fetch

    def advancing_fetch(url, **kwargs):
        result = original_fetch(url, **kwargs)
        clock.value += 1.1
        if clock.value >= kwargs["deadline"]:
            raise FetchError("fetch timeout")
        return result

    fetcher.fetch = advancing_fetch

    with pytest.raises(TimeoutError, match="timeout"):
        _browser_extractor(
            api,
            fetcher,
            manager,
            timeout_seconds=1.0,
            monotonic=clock.monotonic,
        ).extract(PUBLIC_URL)

    assert fetcher.calls == [PUBLIC_URL]
    assert all(route.aborted for route in browser.context.page.routes)
    assert fetcher.call_options[0]["deadline"] == 1.0


def test_browser_waits_once_for_a_short_bounded_render_stabilization():
    """Reading at DOMContentLoaded would miss text added by an already-started fetch promise."""
    api = _api()
    fetcher, browser, manager = _browser_fixture(
        [{"url": PUBLIC_URL, "method": "GET", "resource_type": "document"}]
    )

    result = _browser_extractor(api, fetcher, manager).extract(PUBLIC_URL)

    assert browser.context.page.waited_milliseconds == [200]
    assert result.text.startswith("Rendered body")
    assert [name for name, _timeout in browser.context.page.dom_timeouts] == [
        "title",
        "body",
    ]
    assert all(timeout <= 15_000 for _, timeout in browser.context.page.dom_timeouts)


def test_blocked_dom_read_uses_remaining_timeout_and_forces_resource_close():
    """Default Playwright DOM waits can exceed the extraction deadline unless explicitly bounded."""
    api = _api()
    fetcher, browser, manager = _browser_fixture(
        [{"url": PUBLIC_URL, "method": "GET", "resource_type": "document"}]
    )
    browser_page = None
    extractor = _browser_extractor(api, fetcher, manager, timeout_seconds=1.0)

    # new_context creates the page during extract, so make it block through the factory hook.
    original_new_context = browser.new_context

    def blocking_context(**kwargs):
        nonlocal browser_page
        context = original_new_context(**kwargs)
        browser_page = context.page
        context.page.block_dom = True
        return context

    browser.new_context = blocking_context

    with pytest.raises(TimeoutError, match="blocked"):
        extractor.extract(PUBLIC_URL)

    assert browser_page.dom_timeouts[0][1] <= 1000
    assert browser.context.closed is True
    assert browser.closed is True


@pytest.mark.parametrize(
    ("url", "method"),
    (
        ("file:///etc/passwd", "GET"),
        ("data:text/plain,secret", "GET"),
        ("blob:https://public.example/id", "GET"),
        ("https://public.example/post", "POST"),
        ("https://public.example/put", "PUT"),
        ("https://public.example/patch", "PATCH"),
        ("https://public.example/delete", "DELETE"),
        ("https://public.example/options", "OPTIONS"),
    ),
)
def test_browser_aborts_non_http_or_non_read_only_requests_without_fetching(url, method):
    """Allowing another scheme or method would bypass the SafeFetcher GET-only contract."""
    api = _api()
    fetcher, browser, manager = _browser_fixture(
        [
            {"url": PUBLIC_URL, "method": "GET", "resource_type": "document"},
            {"url": url, "method": method, "resource_type": "fetch"},
        ]
    )

    _browser_extractor(api, fetcher, manager).extract(PUBLIC_URL)

    blocked_route = browser.context.page.routes[1]
    assert blocked_route.aborted is True
    assert blocked_route.fulfilled is None
    assert fetcher.calls == [PUBLIC_URL]


def test_browser_context_blocks_side_channels_and_is_closed_after_one_shot():
    """Persistent state, side channels, or an unclosed context would escape route controls."""
    api = _api()
    fetcher, browser, manager = _browser_fixture(
        [{"url": PUBLIC_URL, "method": "GET", "resource_type": "document"}]
    )

    _browser_extractor(api, fetcher, manager).extract(PUBLIC_URL)

    assert browser.context_options["service_workers"] == "block"
    assert browser.context_options["accept_downloads"] is False
    assert browser.context_options["permissions"] == []
    assert "storage_state" not in browser.context_options
    websocket = _FakeWebSocketRoute()
    browser.context.websocket_handler(websocket)
    assert websocket.closed is True
    assert browser.context.page.popup.closed is True
    assert browser.context.page.popup.close_calls == 1
    assert browser.context.page.download.cancelled is True
    assert browser.context.cookies_cleared is True
    assert browser.context.permissions_cleared is True
    assert browser.context.closed is True
    assert browser.closed is True
    assert manager.exited is True
