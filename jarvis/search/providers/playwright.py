"""One-shot browser extraction with SafeFetcher routing and OS-denied egress."""
from __future__ import annotations

import os
import platform
import shlex
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from jarvis.search.fetcher import SafeFetcher
from jarvis.search.providers.base import clean_text


MAX_BROWSER_REQUESTS = 32
MAX_BROWSER_RESPONSE_BYTES = 8 * 1024 * 1024
BROWSER_TIMEOUT_SECONDS = 15.0
RENDER_SETTLE_MILLISECONDS = 200
_MACOS_PROFILE = "(version 1)\n(allow default)\n(deny network*)\n"
_PROBE_MARKER = "JARVIS_NETWORK_DENIED_V1"
_PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "DBUS_SESSION_BUS_ADDRESS",
)
CHROMIUM_NETWORK_DEFENSE_FLAGS = (
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-client-side-phishing-detection",
    "--disable-extensions",
    "--disable-quic",
    "--disable-webrtc",
    "--disable-features=WebTransport,MediaRouter,OptimizationHints",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=",
    "--no-pings",
    "--no-first-run",
    "--no-default-browser-check",
    "--metrics-recording-only",
)


class BrowserUnavailable(RuntimeError):
    """The optional browser or its mandatory network sandbox is unavailable."""


@dataclass(frozen=True)
class BrowserExtraction:
    url: str
    title: str
    text: str


def _sync_playwright():
    from playwright.sync_api import sync_playwright

    return sync_playwright()


def _clean_environment() -> dict[str, str]:
    environment = dict(os.environ)
    for key in _PROXY_ENV_KEYS:
        environment.pop(key, None)
    return environment


def _trusted_executable(path: str) -> str | None:
    candidate = Path(path)
    if not candidate.is_absolute():
        return None
    try:
        metadata = candidate.lstat()
    except OSError:
        return None
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_mode & 0o022
        or not os.access(candidate, os.X_OK)
    ):
        return None
    return str(candidate.resolve())


def _real_browser_executable(path: str) -> str:
    candidate = Path(path)
    if not candidate.is_absolute():
        raise RuntimeError("browser executable unavailable")
    try:
        metadata = candidate.lstat()
    except OSError:
        raise RuntimeError("browser executable unavailable") from None
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or metadata.st_mode & 0o022
        or not os.access(candidate, os.X_OK)
    ):
        raise RuntimeError("browser executable unavailable")
    return str(candidate.resolve())


_MACOS_PROBE = f"""
import errno
import socket
results = []
for family, address in ((socket.AF_INET, ('127.0.0.1', 0)), (socket.AF_INET6, ('::1', 0))):
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.bind(address)
    except OSError as exc:
        results.append(exc.errno in (errno.EPERM, errno.EACCES))
    else:
        results.append(False)
    finally:
        sock.close()
if results == [True, True]:
    print('{_PROBE_MARKER}')
    raise SystemExit(0)
raise SystemExit(9)
"""


_LINUX_PROBE = f"""
import os
import sys
parent_namespace = sys.argv[1]
current_namespace = os.readlink('/proc/self/ns/net')
routes = open('/proc/net/route', encoding='ascii').read().splitlines()[1:]
has_default = any(line.split()[1] == '00000000' for line in routes if len(line.split()) > 1)
if current_namespace != parent_namespace and not has_default:
    print('{_PROBE_MARKER}')
    raise SystemExit(0)
raise SystemExit(9)
"""


class ProcessNetworkSandbox:
    """Verify and build a private OS-level deny-egress Chromium wrapper."""

    def __init__(
        self,
        *,
        runner: Callable[..., subprocess.CompletedProcess] | None = None,
        system: Callable[[], str] | None = None,
        python_executable: str | None = None,
    ) -> None:
        self._runner = runner or subprocess.run
        self._system = system or platform.system
        self._python_executable = str(Path(python_executable or sys.executable).resolve())
        self._verified_prefix: tuple[str, ...] | None = None
        self._checked = False

    def verified(self) -> bool:
        if self._checked:
            return self._verified_prefix is not None
        self._checked = True
        candidate = self._candidate()
        if candidate is None:
            return False
        prefix, probe = candidate
        try:
            result = self._runner(
                [*prefix, self._python_executable, *probe],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
                env=_clean_environment(),
            )
        except Exception:
            return False
        if result.returncode != 0 or result.stdout.strip() != _PROBE_MARKER:
            return False
        self._verified_prefix = tuple(prefix)
        return True

    @contextmanager
    def guarded_executable(self, executable_path: str) -> Iterator[str]:
        if not self.verified() or self._verified_prefix is None:
            raise RuntimeError("network sandbox unavailable")
        browser = _real_browser_executable(executable_path)
        old_umask = os.umask(0o077)
        try:
            with tempfile.TemporaryDirectory(prefix="jarvis-browser-") as directory:
                root = Path(directory)
                root.chmod(0o700)
                profile = root / "network.sb"
                if self._system() == "Darwin":
                    _write_private_file(profile, _MACOS_PROFILE, 0o400)
                    tool = self._verified_prefix[0]
                    command = (tool, "-f", str(profile), browser)
                else:
                    command = (*self._verified_prefix, browser)
                wrapper = root / "chromium-network-denied"
                unset = " ".join(_PROXY_ENV_KEYS)
                script = (
                    "#!/bin/sh\n"
                    f"unset {unset}\n"
                    f"exec {shlex.join(command)} \"$@\"\n"
                )
                _write_private_file(wrapper, script, 0o500)
                yield str(wrapper)
        finally:
            os.umask(old_umask)

    def _candidate(self) -> tuple[tuple[str, ...], tuple[str, ...]] | None:
        system = self._system()
        if system == "Darwin":
            sandbox_exec = _trusted_executable("/usr/bin/sandbox-exec")
            if sandbox_exec is None:
                return None
            return (
                (sandbox_exec, "-p", _MACOS_PROFILE),
                ("-c", _MACOS_PROBE),
            )
        if system != "Linux":
            return None
        try:
            parent_namespace = os.readlink("/proc/self/ns/net")
        except OSError:
            return None
        for path in ("/usr/bin/bwrap", "/bin/bwrap"):
            bwrap = _trusted_executable(path)
            if bwrap is not None:
                return (
                    (
                        bwrap,
                        "--unshare-net",
                        "--die-with-parent",
                        "--new-session",
                        "--bind",
                        "/",
                        "/",
                        "--",
                    ),
                    ("-c", _LINUX_PROBE, parent_namespace),
                )
        for path in ("/usr/bin/unshare", "/bin/unshare"):
            unshare = _trusted_executable(path)
            if unshare is not None:
                return (
                    (
                        unshare,
                        "--user",
                        "--map-root-user",
                        "--net",
                        "--fork",
                        "--kill-child",
                        "--",
                    ),
                    ("-c", _LINUX_PROBE, parent_namespace),
                )
        return None


def _write_private_file(path: Path, content: str, mode: int) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, mode)
    try:
        encoded = content.encode("utf-8")
        os.write(descriptor, encoded)
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_nlink != 1
        ):
            raise RuntimeError("private wrapper creation failed")
    finally:
        os.close(descriptor)
    path.chmod(mode)
    if stat.S_IMODE(path.lstat().st_mode) != mode:
        raise RuntimeError("private wrapper permissions failed")


class PlaywrightExtractor:
    """Render once while both OS egress and Chromium-native networking are denied."""

    def __init__(
        self,
        fetcher: SafeFetcher,
        *,
        runtime_factory: Callable | None = None,
        network_sandbox: ProcessNetworkSandbox | None = None,
        max_requests: int = MAX_BROWSER_REQUESTS,
        max_response_bytes: int = MAX_BROWSER_RESPONSE_BYTES,
        timeout_seconds: float = BROWSER_TIMEOUT_SECONDS,
        settle_milliseconds: int = RENDER_SETTLE_MILLISECONDS,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._runtime_factory = runtime_factory or _sync_playwright
        self._network_sandbox = network_sandbox or ProcessNetworkSandbox()
        self._max_requests = max(1, int(max_requests))
        self._max_response_bytes = max(1, int(max_response_bytes))
        self._timeout_seconds = max(0.001, float(timeout_seconds))
        self._settle_milliseconds = max(0, int(settle_milliseconds))
        self._monotonic = monotonic or time.monotonic

    def extract(self, url: str) -> BrowserExtraction:
        deadline = self._monotonic() + self._timeout_seconds
        try:
            manager = self._runtime_factory()
        except (ImportError, ModuleNotFoundError):
            raise BrowserUnavailable("browser unavailable") from None

        with manager as runtime:
            executable_path = getattr(runtime.chromium, "executable_path", "")
            try:
                guard = self._network_sandbox.guarded_executable(executable_path)
                wrapper = guard.__enter__()
            except Exception:
                raise BrowserUnavailable("browser unavailable") from None
            browser = None
            context = None
            caught: tuple | None = None
            try:
                try:
                    browser = runtime.chromium.launch(
                        executable_path=wrapper,
                        args=list(CHROMIUM_NETWORK_DEFENSE_FLAGS),
                        timeout=self._remaining_milliseconds(deadline),
                    )
                except Exception:
                    raise BrowserUnavailable("browser unavailable") from None
                context = browser.new_context(
                    service_workers="block",
                    accept_downloads=False,
                    permissions=[],
                )
                return self._extract_page(context, url, deadline)
            except BaseException:
                caught = sys.exc_info()
                raise
            finally:
                if context is not None:
                    for cleanup in (
                        context.clear_cookies,
                        context.clear_permissions,
                        context.close,
                    ):
                        try:
                            cleanup()
                        except Exception:
                            pass
                if browser is not None:
                    try:
                        browser.close()
                    except Exception:
                        pass
                try:
                    guard.__exit__(*(caught or (None, None, None)))
                except Exception:
                    if caught is None:
                        raise BrowserUnavailable("browser unavailable") from None

    def _extract_page(self, context, url: str, deadline: float) -> BrowserExtraction:
        resolved_url = url
        main_document_seen = False
        request_count = 0
        response_bytes = 0
        budget_exhausted = False

        def route_request(route) -> None:
            nonlocal budget_exhausted, main_document_seen
            nonlocal request_count, resolved_url, response_bytes
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
            remaining_bytes = self._max_response_bytes - response_bytes
            if (
                budget_exhausted
                or request_count >= self._max_requests
                or remaining_bytes <= 0
                or self._monotonic() >= deadline
            ):
                budget_exhausted = True
                route.abort()
                return
            request_count += 1
            try:
                fetched = self._fetcher.fetch(
                    request.url,
                    method=request.method,
                    deadline=deadline,
                    max_wire_bytes=remaining_bytes,
                    max_decompressed_bytes=remaining_bytes,
                    allow_http_errors=True,
                )
            except Exception:
                route.abort()
                return
            response_bytes += len(fetched.content)
            if request.resource_type == "document" and not main_document_seen:
                resolved_url = fetched.url
                main_document_seen = True
            headers = dict(fetched.headers)
            headers.setdefault("content-type", fetched.content_type)
            route.fulfill(
                status=fetched.status_code,
                headers=headers,
                body=fetched.content,
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
            timeout=self._remaining_milliseconds(deadline),
        )
        settle_for = min(
            self._settle_milliseconds,
            self._remaining_milliseconds(deadline),
        )
        if settle_for:
            page.wait_for_timeout(settle_for)
        title = page.locator("title").text_content(
            timeout=self._remaining_milliseconds(deadline)
        )
        text = page.locator("body").inner_text(
            timeout=self._remaining_milliseconds(deadline)
        )
        return BrowserExtraction(
            url=resolved_url,
            title=clean_text(title),
            text=clean_text(text),
        )

    def _remaining_milliseconds(self, deadline: float) -> int:
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            raise TimeoutError("browser extraction timeout")
        return max(1, int(remaining * 1000))
