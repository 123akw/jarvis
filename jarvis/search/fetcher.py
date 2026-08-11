"""A fail-closed, IP-pinned fetch boundary for public HTTP(S) documents."""
from __future__ import annotations

import http.client
import ipaddress
import queue
import socket
import ssl
import threading
import time
import unicodedata
import zlib
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

from jarvis.search.models import FetchedDocument


_REDIRECT_STATUSES = frozenset((301, 302, 303, 307, 308))
_METADATA_HOSTS = frozenset(("metadata.google.internal",))
_READ_SIZE = 64 * 1024


class FetchError(RuntimeError):
    """A redacted public-fetch failure safe to surface in diagnostics."""


@dataclass(frozen=True)
class FetchPolicy:
    max_redirects: int = 3
    max_compressed_bytes: int = 2 * 1024 * 1024
    max_decompressed_bytes: int = 8 * 1024 * 1024
    total_timeout_seconds: float = 15.0

    def __post_init__(self) -> None:
        if (
            isinstance(self.max_redirects, bool)
            or not isinstance(self.max_redirects, int)
            or self.max_redirects < 0
        ):
            raise ValueError("max_redirects must be a non-negative integer")
        for name in ("max_compressed_bytes", "max_decompressed_bytes"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if (
            isinstance(self.total_timeout_seconds, bool)
            or not isinstance(self.total_timeout_seconds, (int, float))
            or self.total_timeout_seconds <= 0
        ):
            raise ValueError("total_timeout_seconds must be positive")


def _noop() -> None:
    pass


@dataclass(frozen=True)
class TransportResponse:
    """Streaming response contract used by the pinned transport and test doubles."""

    status_code: int
    headers: Mapping[str, str]
    chunks: Iterable[bytes]
    peer_ip: str
    close: Callable[[], None] = _noop


class Resolver(Protocol):
    def resolve(self, host: str, port: int, timeout: float) -> Sequence[str]: ...


class Transport(Protocol):
    trust_env: bool

    def request(
        self,
        *,
        scheme: str,
        connect_ip: str,
        port: int,
        request_target: str,
        host_header: str,
        server_hostname: str | None,
        timeout: float,
    ) -> TransportResponse: ...


@dataclass(frozen=True)
class _CanonicalURL:
    url: str
    scheme: str
    host: str
    port: int
    request_target: str
    host_header: str


class SafeFetcher:
    """Fetch public text while pinning every connection to a validated DNS answer."""

    def __init__(
        self,
        *,
        policy: FetchPolicy | None = None,
        resolver: Resolver | None = None,
        transport: Transport | None = None,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self._policy = policy or FetchPolicy()
        self._resolver = resolver or _SystemResolver()
        self._transport = transport or _SocketTransport(trust_env=False)
        self._monotonic = monotonic or time.monotonic
        if getattr(self._transport, "trust_env", None) is not False:
            raise ValueError("SafeFetcher transport must set trust_env=False")

    def fetch(self, url: str) -> FetchedDocument:
        """Return a bounded public response or a query-redacted FetchError."""
        try:
            return self._fetch(url)
        except FetchError:
            raise
        except (TimeoutError, socket.timeout):
            raise FetchError("fetch timeout") from None
        except Exception:
            raise FetchError("public fetch failed") from None

    def _fetch(self, url: str) -> FetchedDocument:
        deadline = self._monotonic() + self._policy.total_timeout_seconds
        current = _canonicalize_url(url)
        visited: set[str] = set()
        redirects = 0

        while True:
            self._remaining(deadline)
            if current.url in visited:
                raise FetchError("redirect loop rejected")
            visited.add(current.url)

            approved_ip = self._resolve_approved_ip(current, deadline)
            response = self._transport.request(
                scheme=current.scheme,
                connect_ip=approved_ip,
                port=current.port,
                request_target=current.request_target,
                host_header=current.host_header,
                server_hostname=current.host if current.scheme == "https" else None,
                timeout=self._remaining(deadline),
            )
            try:
                self._remaining(deadline)
                if not _same_ip(response.peer_ip, approved_ip):
                    raise FetchError("connected peer did not match approved address")
                headers = {
                    str(name).strip().lower(): str(value).strip()
                    for name, value in response.headers.items()
                }

                if response.status_code in _REDIRECT_STATUSES:
                    if redirects >= self._policy.max_redirects:
                        raise FetchError("too many redirects")
                    location = headers.get("location", "")
                    if not location:
                        raise FetchError("redirect response missing location")
                    next_url = _canonicalize_url(urljoin(current.url, location))
                    if next_url.url in visited:
                        raise FetchError("redirect loop rejected")
                    redirects += 1
                    current = next_url
                    continue

                if not 200 <= response.status_code < 300:
                    raise FetchError("upstream response status rejected")
                content_type = _accepted_content_type(headers.get("content-type", ""))
                content = self._read_body(
                    response.chunks,
                    headers.get("content-encoding", ""),
                    deadline,
                )
                return FetchedDocument(
                    url=current.url,
                    content=content,
                    content_type=content_type,
                    peer_ip=_normalize_ip(response.peer_ip),
                )
            finally:
                try:
                    response.close()
                except Exception:
                    pass

    def _remaining(self, deadline: float) -> float:
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            raise FetchError("fetch timeout")
        return remaining

    def _resolve_approved_ip(self, target: _CanonicalURL, deadline: float) -> str:
        try:
            literal = ipaddress.ip_address(target.host)
        except ValueError:
            try:
                raw_answers = tuple(
                    self._resolver.resolve(
                        target.host,
                        target.port,
                        self._remaining(deadline),
                    )
                )
            except (TimeoutError, socket.timeout):
                raise FetchError("fetch timeout") from None
            except Exception:
                raise FetchError("address resolution failed") from None
        else:
            raw_answers = (str(literal),)

        self._remaining(deadline)
        if not raw_answers:
            raise FetchError("address resolution returned no public address")

        approved: list[str] = []
        for raw_address in raw_answers:
            address = _parse_ip(raw_address)
            if not _is_public_address(address):
                raise FetchError("target address is not public")
            normalized = str(address)
            if normalized not in approved:
                approved.append(normalized)
        return approved[0]

    def _read_body(
        self,
        chunks: Iterable[bytes],
        content_encoding: str,
        deadline: float,
    ) -> bytes:
        encoding = content_encoding.strip().lower()
        if encoding in ("", "identity"):
            decompressor = None
        elif encoding == "gzip":
            decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
        elif encoding == "deflate":
            decompressor = zlib.decompressobj()
        else:
            raise FetchError("unsupported content encoding")

        compressed_count = 0
        decompressed_count = 0
        output: list[bytes] = []
        iterator = iter(chunks)
        try:
            while True:
                self._remaining(deadline)
                try:
                    chunk = next(iterator)
                except StopIteration:
                    break
                self._remaining(deadline)
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    raise FetchError("invalid response byte stream")
                data = bytes(chunk)
                compressed_count += len(data)
                if compressed_count > self._policy.max_compressed_bytes:
                    raise FetchError("compressed response exceeded limit")

                if decompressor is None:
                    decoded_parts = (data,)
                else:
                    decoded_parts = self._decompress_chunk(
                        decompressor,
                        data,
                        self._policy.max_decompressed_bytes - decompressed_count,
                    )
                for decoded in decoded_parts:
                    decompressed_count += len(decoded)
                    if decompressed_count > self._policy.max_decompressed_bytes:
                        raise FetchError("decompressed response exceeded limit")
                    output.append(decoded)

            if decompressor is not None:
                if not decompressor.eof:
                    raise FetchError("invalid compressed response")
                remaining = self._policy.max_decompressed_bytes - decompressed_count
                tail = decompressor.flush(remaining + 1)
                if len(tail) > remaining:
                    raise FetchError("decompressed response exceeded limit")
                output.append(tail)
        except zlib.error:
            raise FetchError("invalid compressed response") from None
        finally:
            close = getattr(iterator, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        return b"".join(output)

    @staticmethod
    def _decompress_chunk(
        decompressor: zlib.Decompress,
        data: bytes,
        remaining: int,
    ) -> tuple[bytes, ...]:
        if remaining < 0:
            raise FetchError("decompressed response exceeded limit")
        decoded: list[bytes] = []
        pending = data
        while pending:
            part = decompressor.decompress(pending, remaining + 1)
            if len(part) > remaining:
                raise FetchError("decompressed response exceeded limit")
            decoded.append(part)
            remaining -= len(part)
            if decompressor.unused_data:
                raise FetchError("invalid compressed response")
            next_pending = decompressor.unconsumed_tail
            if not next_pending:
                break
            if next_pending == pending and not part:
                raise FetchError("invalid compressed response")
            pending = next_pending
        return tuple(decoded)


class _SystemResolver:
    """Bound blocking getaddrinfo with a daemon worker and a caller deadline."""

    def resolve(self, host: str, port: int, timeout: float) -> Sequence[str]:
        result: queue.Queue[tuple[bool, object]] = queue.Queue(maxsize=1)

        def worker() -> None:
            try:
                infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                result.put((True, tuple(info[4][0] for info in infos)))
            except Exception as exc:
                result.put((False, exc))

        threading.Thread(target=worker, daemon=True, name="safe-fetch-dns").start()
        try:
            succeeded, value = result.get(timeout=max(0.0, timeout))
        except queue.Empty:
            raise TimeoutError("DNS deadline exceeded") from None
        if not succeeded:
            raise OSError("DNS resolution failed") from None
        return value  # type: ignore[return-value]


class _SocketTransport:
    """One-shot HTTP/1.1 transport that never resolves the approved hostname again."""

    def __init__(self, *, trust_env: bool = False) -> None:
        if trust_env:
            raise ValueError("environment proxy use is forbidden")
        self.trust_env = False

    def request(
        self,
        *,
        scheme: str,
        connect_ip: str,
        port: int,
        request_target: str,
        host_header: str,
        server_hostname: str | None,
        timeout: float,
    ) -> TransportResponse:
        deadline = time.monotonic() + timeout

        def remaining() -> float:
            value = deadline - time.monotonic()
            if value <= 0:
                raise TimeoutError("transport deadline exceeded")
            return value

        address = _parse_ip(connect_ip)
        family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        response: http.client.HTTPResponse | None = None
        try:
            sock.settimeout(remaining())
            endpoint = (str(address), port, 0, 0) if address.version == 6 else (str(address), port)
            sock.connect(endpoint)
            peer_ip = sock.getpeername()[0]
            if scheme == "https":
                if not server_hostname:
                    raise OSError("missing TLS server name")
                sock.settimeout(remaining())
                sock = ssl.create_default_context().wrap_socket(
                    sock,
                    server_hostname=server_hostname,
                )

            request = (
                f"GET {request_target} HTTP/1.1\r\n"
                f"Host: {host_header}\r\n"
                "User-Agent: Jarvis-SafeFetcher/1.0\r\n"
                "Accept: text/html, text/plain;q=0.9, application/xhtml+xml;q=0.9\r\n"
                "Accept-Encoding: gzip, deflate\r\n"
                "Connection: close\r\n\r\n"
            ).encode("ascii")
            sock.settimeout(remaining())
            sock.sendall(request)
            response = http.client.HTTPResponse(sock)
            sock.settimeout(remaining())
            response.begin()
            headers = {name: value for name, value in response.getheaders()}
        except Exception:
            if response is not None:
                response.close()
            sock.close()
            raise

        closed = False

        def close() -> None:
            nonlocal closed
            if closed:
                return
            closed = True
            response.close()
            sock.close()

        def chunks() -> Iterable[bytes]:
            try:
                while True:
                    sock.settimeout(remaining())
                    chunk = response.read(_READ_SIZE)
                    if not chunk:
                        break
                    yield chunk
            finally:
                close()

        return TransportResponse(
            status_code=response.status,
            headers=headers,
            chunks=chunks(),
            peer_ip=peer_ip,
            close=close,
        )


def _canonicalize_url(value: str) -> _CanonicalURL:
    if not isinstance(value, str) or not value:
        raise FetchError("URL is not permitted")
    if any(unicodedata.category(character).startswith("C") for character in value):
        raise FetchError("URL is not permitted")
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        host = parsed.hostname
        port = parsed.port
        has_userinfo = (
            parsed.username is not None
            or parsed.password is not None
            or "@" in parsed.netloc
        )
    except (TypeError, ValueError):
        raise FetchError("URL is not permitted") from None
    if scheme not in ("http", "https") or not host or has_userinfo:
        raise FetchError("URL is not permitted")
    if "%" in host:
        raise FetchError("URL is not permitted")

    host = host.rstrip(".")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            host = host.encode("idna").decode("ascii").lower()
        except UnicodeError:
            raise FetchError("URL is not permitted") from None
        labels = host.split(".")
        if (
            not host
            or len(host) > 253
            or any(not label or len(label) > 63 for label in labels)
            or host in _METADATA_HOSTS
        ):
            raise FetchError("URL is not permitted")
    else:
        host = str(address)

    port = port or (443 if scheme == "https" else 80)
    host_literal = f"[{host}]" if ":" in host else host
    default_port = 443 if scheme == "https" else 80
    authority = host_literal if port == default_port else f"{host_literal}:{port}"
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parsed.query, safe="/%?:@!$&'()*+,;=-._~")
    request_target = path + (f"?{query}" if query else "")
    canonical = urlunsplit((scheme, authority, path, query, ""))
    return _CanonicalURL(
        url=canonical,
        scheme=scheme,
        host=host,
        port=port,
        request_target=request_target,
        host_header=authority,
    )


def _parse_ip(value: object) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if not isinstance(value, str) or "%" in value:
        raise FetchError("target address is not public")
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        raise FetchError("target address is not public") from None


def _is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        address = mapped
    return bool(
        address.is_global
        and not address.is_private
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_reserved
        and not address.is_unspecified
    )


def _normalize_ip(value: str) -> str:
    return str(_parse_ip(value))


def _same_ip(left: str, right: str) -> bool:
    try:
        return _parse_ip(left) == _parse_ip(right)
    except FetchError:
        return False


def _accepted_content_type(value: str) -> str:
    media_type = value.split(";", 1)[0].strip().lower()
    if not (media_type.startswith("text/") or media_type == "application/xhtml+xml"):
        raise FetchError("response content type rejected")
    return media_type
