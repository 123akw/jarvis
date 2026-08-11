"""A fail-closed, IP-pinned fetch boundary for public HTTP(S) documents."""
from __future__ import annotations

import http.client
import ipaddress
import queue
import re
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
_IPV4_MAPPED = ipaddress.ip_network("::ffff:0:0/96")
_IPV4_TRANSLATED = ipaddress.ip_network("::ffff:0:0:0/96")
_NAT64_WELL_KNOWN = ipaddress.ip_network("64:ff9b::/96")
_NAT64_LOCAL_USE = ipaddress.ip_network("64:ff9b:1::/48")
_SIX_TO_FOUR = ipaddress.ip_network("2002::/16")
_TEREDO = ipaddress.ip_network("2001::/32")
_NAT64_PREFIX_LENGTHS = frozenset((32, 40, 48, 56, 64, 96))
_NON_PUBLIC_IPV4 = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)
_NON_PUBLIC_IPV6 = tuple(
    ipaddress.ip_network(network)
    for network in (
        "::/96",
        "::1/128",
        "100::/64",
        "2001:db8::/32",
        "3fff::/20",
        "5f00::/16",
        "fc00::/7",
        "fe80::/10",
        "ff00::/8",
    )
)
_HTTP_TOKEN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")


class FetchError(RuntimeError):
    """A redacted public-fetch failure safe to surface in diagnostics."""


@dataclass(frozen=True)
class FetchPolicy:
    max_redirects: int = 3
    max_compressed_bytes: int = 2 * 1024 * 1024
    max_decompressed_bytes: int = 8 * 1024 * 1024
    total_timeout_seconds: float = 15.0
    max_response_metadata_bytes: int = 64 * 1024
    max_response_chunks: int = 1024

    def __post_init__(self) -> None:
        if (
            isinstance(self.max_redirects, bool)
            or not isinstance(self.max_redirects, int)
            or self.max_redirects < 0
        ):
            raise ValueError("max_redirects must be a non-negative integer")
        for name in (
            "max_compressed_bytes",
            "max_decompressed_bytes",
            "max_response_metadata_bytes",
            "max_response_chunks",
        ):
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
    headers: Mapping[str, str] | Sequence[tuple[str, str]]
    chunks: Iterable[bytes]
    peer_ip: str
    close: Callable[[], None] = _noop

    def __post_init__(self) -> None:
        items = self.headers.items() if isinstance(self.headers, Mapping) else self.headers
        try:
            pairs = tuple((str(name), str(value)) for name, value in items)
        except (TypeError, ValueError):
            raise ValueError("headers must contain name/value pairs") from None
        object.__setattr__(self, "headers", pairs)


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
        local_nat64_prefixes: Sequence[str] = (),
    ) -> None:
        self._policy = policy or FetchPolicy()
        self._resolver = resolver or _SystemResolver()
        self._transport = transport or _SocketTransport(
            trust_env=False,
            max_wire_bytes=self._policy.max_compressed_bytes,
            max_metadata_bytes=self._policy.max_response_metadata_bytes,
            max_chunks=self._policy.max_response_chunks,
        )
        self._monotonic = monotonic or time.monotonic
        self._local_nat64_prefixes = _parse_nat64_prefixes(local_nat64_prefixes)
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
                if response.status_code in _REDIRECT_STATUSES:
                    if redirects >= self._policy.max_redirects:
                        raise FetchError("too many redirects")
                    location = _single_header(response.headers, "location")
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
                content_type = _accepted_content_type(response.headers)
                content_encoding = _accepted_content_encoding(response.headers)
                content = self._read_body(
                    response.chunks,
                    content_encoding,
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
            if not _is_public_address(address, self._local_nat64_prefixes):
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


@dataclass(frozen=True)
class _ResolverTask:
    host: str
    port: int
    result: queue.Queue[tuple[bool, object]]


class _ResolverWorkerPool:
    """Fixed daemon workers and a bounded non-blocking submission queue."""

    def __init__(
        self,
        *,
        max_workers: int,
        max_queue: int,
        getaddrinfo: Callable[..., object] = socket.getaddrinfo,
        thread_name_prefix: str = "safe-fetch-dns",
    ) -> None:
        if max_workers <= 0 or max_queue <= 0:
            raise ValueError("resolver worker and queue bounds must be positive")
        self._getaddrinfo = getaddrinfo
        self._slots = threading.BoundedSemaphore(max_workers + max_queue)
        self._tasks: queue.Queue[_ResolverTask] = queue.Queue(
            maxsize=max_workers + max_queue
        )
        self._workers = tuple(
            threading.Thread(
                target=self._worker,
                daemon=True,
                name=f"{thread_name_prefix}-{index}",
            )
            for index in range(max_workers)
        )
        for worker in self._workers:
            worker.start()

    def submit(self, host: str, port: int) -> queue.Queue[tuple[bool, object]]:
        result: queue.Queue[tuple[bool, object]] = queue.Queue(maxsize=1)
        if not self._slots.acquire(blocking=False):
            raise OSError("DNS resolver busy") from None
        try:
            self._tasks.put_nowait(_ResolverTask(host=host, port=port, result=result))
        except queue.Full:
            self._slots.release()
            raise OSError("DNS resolver busy") from None
        return result

    def _worker(self) -> None:
        while True:
            task = self._tasks.get()
            try:
                try:
                    infos = self._getaddrinfo(
                        task.host,
                        task.port,
                        type=socket.SOCK_STREAM,
                    )
                    addresses = tuple(info[4][0] for info in infos)  # type: ignore[index]
                    outcome: tuple[bool, object] = (True, addresses)
                except Exception as exc:
                    outcome = (False, exc)
                task.result.put_nowait(outcome)
            finally:
                self._tasks.task_done()
                self._slots.release()


_DEFAULT_RESOLVER_POOL = _ResolverWorkerPool(max_workers=4, max_queue=8)


class _SystemResolver:
    """Resolve through a process-wide fixed pool under the caller deadline."""

    def __init__(self, *, pool: _ResolverWorkerPool | None = None) -> None:
        self._pool = pool or _DEFAULT_RESOLVER_POOL

    def resolve(self, host: str, port: int, timeout: float) -> Sequence[str]:
        result = self._pool.submit(host, port)
        try:
            succeeded, value = result.get(timeout=max(0.0, timeout))
        except queue.Empty:
            raise TimeoutError("DNS deadline exceeded") from None
        if not succeeded:
            raise OSError("DNS resolution failed") from None
        return value  # type: ignore[return-value]


class _WireBudget:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.used = 0

    @property
    def remaining(self) -> int:
        return self.limit - self.used

    def consume(self, amount: int) -> None:
        self.used += amount
        if self.used > self.limit:
            raise FetchError("compressed/wire response exceeded limit")


class _HTTPWireFile:
    """Socket-backed file that meters bytes before http.client parses them."""

    def __init__(
        self,
        sock: socket.socket,
        *,
        wire_limit: int,
        metadata_limit: int,
        chunk_limit: int,
    ) -> None:
        self._sock = sock
        self._wire = _WireBudget(wire_limit)
        self._metadata_limit = metadata_limit
        self._chunk_limit = chunk_limit
        self._metadata_used = 0
        self._chunks_seen = 0
        self._buffer = bytearray()
        self._eof = False
        self._closed = False
        self._header_phase = True
        self._chunked = False
        self._trailers = False

    def mark_body(self, *, chunked: bool) -> None:
        self._header_phase = False
        self._chunked = chunked

    def _receive(self) -> None:
        if self._eof:
            return
        size = min(_READ_SIZE, max(1, self._wire.remaining + 1))
        data = self._sock.recv(size)
        if not data:
            self._eof = True
            return
        self._wire.consume(len(data))
        self._buffer.extend(data)

    def _record_metadata(self, line: bytes) -> None:
        if not self._header_phase and not self._chunked:
            return
        self._metadata_used += len(line)
        if self._metadata_used > self._metadata_limit:
            raise FetchError("response metadata exceeded limit")
        if self._header_phase or self._trailers:
            return
        size_token = line.split(b";", 1)[0].strip()
        try:
            chunk_size = int(size_token, 16)
        except ValueError:
            return
        if chunk_size == 0:
            self._trailers = True
            return
        self._chunks_seen += 1
        if self._chunks_seen > self._chunk_limit:
            raise FetchError("response chunk count exceeded limit")

    def readline(self, limit: int = -1) -> bytes:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                size = newline + 1
                if limit >= 0:
                    size = min(size, limit)
                break
            if limit >= 0 and len(self._buffer) >= limit:
                size = limit
                break
            if self._eof:
                size = len(self._buffer)
                break
            self._receive()
        line = bytes(self._buffer[:size])
        del self._buffer[:size]
        self._record_metadata(line)
        return line

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            while not self._eof:
                self._receive()
            size = len(self._buffer)
        else:
            while len(self._buffer) < size and not self._eof:
                self._receive()
            size = min(size, len(self._buffer))
        data = bytes(self._buffer[:size])
        del self._buffer[:size]
        return data

    def read1(self, size: int = -1) -> bytes:
        return self.read(size)

    def close(self) -> None:
        self._closed = True
        self._buffer.clear()

    def flush(self) -> None:
        pass

    @property
    def closed(self) -> bool:
        return self._closed


class _HTTPResponseSocket:
    def __init__(self, wire_file: _HTTPWireFile) -> None:
        self._wire_file = wire_file

    def makefile(self, _mode: str) -> _HTTPWireFile:
        return self._wire_file


class _SocketTransport:
    """One-shot HTTP/1.1 transport that never resolves the approved hostname again."""

    def __init__(
        self,
        *,
        trust_env: bool = False,
        max_wire_bytes: int = 2 * 1024 * 1024,
        max_metadata_bytes: int = 64 * 1024,
        max_chunks: int = 1024,
    ) -> None:
        if trust_env:
            raise ValueError("environment proxy use is forbidden")
        self.trust_env = False
        self._max_wire_bytes = max_wire_bytes
        self._max_metadata_bytes = max_metadata_bytes
        self._max_chunks = max_chunks

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
            peer_ip = _assert_connected_peer(sock, connect_ip)
            if scheme == "https":
                if not server_hostname:
                    raise OSError("missing TLS server name")
                sock.settimeout(remaining())
                sock = ssl.create_default_context().wrap_socket(
                    sock,
                    server_hostname=server_hostname,
                )
                peer_ip = _assert_connected_peer(sock, connect_ip)

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
            wire_file = _HTTPWireFile(
                sock,
                wire_limit=self._max_wire_bytes,
                metadata_limit=self._max_metadata_bytes,
                chunk_limit=self._max_chunks,
            )
            response = http.client.HTTPResponse(_HTTPResponseSocket(wire_file))
            sock.settimeout(remaining())
            response.begin()
            wire_file.mark_body(chunked=response.chunked)
            headers = tuple(response.getheaders())
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


def _is_public_address(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    local_nat64_prefixes: Sequence[ipaddress.IPv6Network] = (),
) -> bool:
    if isinstance(address, ipaddress.IPv4Address):
        if any(address in network for network in _NON_PUBLIC_IPV4):
            return False
        return bool(
            address.is_global
            and not address.is_private
            and not address.is_loopback
            and not address.is_link_local
            and not address.is_multicast
            and not address.is_reserved
            and not address.is_unspecified
        )

    for prefix in local_nat64_prefixes:
        if address in prefix:
            embedded = _extract_nat64_ipv4(address, prefix)
            return embedded is not None and _is_public_address(embedded)

    if address in _IPV4_MAPPED or address in _IPV4_TRANSLATED:
        return _is_public_address(ipaddress.IPv4Address(address.packed[-4:]))
    if address in _NAT64_WELL_KNOWN:
        return _is_public_address(ipaddress.IPv4Address(address.packed[-4:]))
    if address in _SIX_TO_FOUR:
        return _is_public_address(ipaddress.IPv4Address(address.packed[2:6]))
    if address in _TEREDO or address in _NAT64_LOCAL_USE:
        return False
    if any(address in network for network in _NON_PUBLIC_IPV6):
        return False
    return bool(
        address.is_global
        and not address.is_private
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_reserved
        and not address.is_unspecified
    )


def _parse_nat64_prefixes(values: Sequence[str]) -> tuple[ipaddress.IPv6Network, ...]:
    prefixes: list[ipaddress.IPv6Network] = []
    for value in values:
        try:
            network = ipaddress.ip_network(value, strict=True)
        except (TypeError, ValueError):
            raise ValueError("local_nat64_prefixes must contain canonical IPv6 networks") from None
        if (
            not isinstance(network, ipaddress.IPv6Network)
            or network.prefixlen not in _NAT64_PREFIX_LENGTHS
        ):
            raise ValueError("local_nat64_prefixes use unsupported prefix lengths")
        if any(network.overlaps(existing) for existing in prefixes):
            raise ValueError("local_nat64_prefixes must not overlap")
        prefixes.append(network)
    return tuple(prefixes)


def _extract_nat64_ipv4(
    address: ipaddress.IPv6Address,
    prefix: ipaddress.IPv6Network,
) -> ipaddress.IPv4Address | None:
    if address not in prefix:
        return None
    packed = address.packed
    if prefix.prefixlen == 96:
        return ipaddress.IPv4Address(packed[12:16])
    if packed[8] != 0:
        return None
    start = prefix.prefixlen // 8
    high = packed[start:8]
    low = packed[9 : 9 + (4 - len(high))]
    if len(high) + len(low) != 4:
        return None
    return ipaddress.IPv4Address(high + low)


def _normalize_ip(value: str) -> str:
    return str(_parse_ip(value))


def _same_ip(left: str, right: str) -> bool:
    try:
        return _parse_ip(left) == _parse_ip(right)
    except FetchError:
        return False


def _assert_connected_peer(sock: socket.socket, approved_ip: str) -> str:
    peer_ip = str(sock.getpeername()[0])
    if not _same_ip(peer_ip, approved_ip):
        raise FetchError("connected peer did not match approved address")
    return peer_ip


def _header_values(
    headers: Mapping[str, str] | Sequence[tuple[str, str]],
    name: str,
) -> tuple[str, ...]:
    items = headers.items() if isinstance(headers, Mapping) else headers
    return tuple(
        str(value).strip()
        for header_name, value in items
        if str(header_name).strip().lower() == name
    )


def _single_header(
    headers: Mapping[str, str] | Sequence[tuple[str, str]],
    name: str,
) -> str:
    values = _header_values(headers, name)
    if len(values) > 1:
        raise FetchError(f"response {name.replace('-', ' ')} rejected")
    return values[0] if values else ""


def _accepted_content_type(
    headers: Mapping[str, str] | Sequence[tuple[str, str]],
) -> str:
    values = _header_values(headers, "content-type")
    if len(values) != 1:
        raise FetchError("response content type rejected")
    parts = _split_http_parameters(values[0])
    media = parts[0]
    if media.count("/") != 1:
        raise FetchError("response content type rejected")
    media_type, subtype = media.split("/", 1)
    if (
        not _is_http_token(media_type)
        or not _is_http_token(subtype)
        or media_type == "*"
        or subtype == "*"
    ):
        raise FetchError("response content type rejected")
    seen_parameters: set[str] = set()
    for parameter in parts[1:]:
        if "=" not in parameter:
            raise FetchError("response content type rejected")
        parameter_name, parameter_value = (part.strip() for part in parameter.split("=", 1))
        normalized_name = parameter_name.lower()
        if (
            not _is_http_token(parameter_name)
            or normalized_name in seen_parameters
            or not (_is_http_token(parameter_value) or _is_quoted_string(parameter_value))
        ):
            raise FetchError("response content type rejected")
        seen_parameters.add(normalized_name)
    normalized = f"{media_type.lower()}/{subtype.lower()}"
    if not (normalized.startswith("text/") or normalized == "application/xhtml+xml"):
        raise FetchError("response content type rejected")
    return normalized


def _accepted_content_encoding(
    headers: Mapping[str, str] | Sequence[tuple[str, str]],
) -> str:
    values = _header_values(headers, "content-encoding")
    if len(values) > 1:
        raise FetchError("response content encoding rejected")
    if not values:
        return ""
    if not _is_http_token(values[0]):
        raise FetchError("response content encoding rejected")
    return values[0].lower()


def _split_http_parameters(value: str) -> tuple[str, ...]:
    parts: list[str] = []
    start = 0
    quoted = False
    escaped = False
    for index, character in enumerate(value):
        if escaped:
            escaped = False
        elif quoted and character == "\\":
            escaped = True
        elif character == '"':
            quoted = not quoted
        elif character == ";" and not quoted:
            parts.append(value[start:index].strip())
            start = index + 1
    if quoted or escaped:
        raise FetchError("response content type rejected")
    parts.append(value[start:].strip())
    if not parts or any(not part for part in parts):
        raise FetchError("response content type rejected")
    return tuple(parts)


def _is_http_token(value: str) -> bool:
    return bool(value and _HTTP_TOKEN.fullmatch(value))


def _is_quoted_string(value: str) -> bool:
    if len(value) < 2 or value[0] != '"' or value[-1] != '"':
        return False
    escaped = False
    for character in value[1:-1]:
        codepoint = ord(character)
        if escaped:
            if character != "\t" and not 0x20 <= codepoint <= 0x7E:
                return False
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == '"' or (
            character != "\t"
            and not (codepoint == 0x20 or 0x21 <= codepoint <= 0x7E)
        ):
            return False
    return not escaped
