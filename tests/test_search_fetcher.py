"""SSRF-safe public document fetching without live network access."""
from __future__ import annotations

import gzip
import io
import ipaddress
import socket
import threading
import time

import pytest


PUBLIC_IP = "93.184.216.34"


def _api():
    try:
        from jarvis.search.fetcher import (
            FetchError,
            FetchPolicy,
            SafeFetcher,
            TransportResponse,
        )
    except (ImportError, ModuleNotFoundError) as exc:
        pytest.fail(f"SafeFetcher API is not implemented: {type(exc).__name__}")
    return FetchError, FetchPolicy, SafeFetcher, TransportResponse


class _StubResolver:
    def __init__(self, answers):
        self.answers = {host: tuple(addresses) for host, addresses in answers.items()}
        self.calls = []

    def resolve(self, host, port, timeout):
        self.calls.append((host, port, timeout))
        return self.answers[host]


class _SequencedResolver:
    def __init__(self, answers):
        self.answers = [tuple(answer) for answer in answers]
        self.calls = []

    def resolve(self, host, port, timeout):
        self.calls.append((host, port, timeout))
        return self.answers.pop(0)


class _StubTransport:
    trust_env = False

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.last_host_header = None
        self.last_server_hostname = None

    def request(self, **kwargs):
        self.calls.append(kwargs)
        self.last_host_header = kwargs["host_header"]
        self.last_server_hostname = kwargs["server_hostname"]
        spec = self.responses.pop(0)
        if isinstance(spec, BaseException):
            raise spec
        _, _, _, response_type = _api()
        return response_type(
            status_code=spec.get("status", 200),
            headers=spec.get("headers", {"Content-Type": "text/html"}),
            chunks=spec.get("chunks", (b"ok",)),
            peer_ip=spec.get("peer_ip", kwargs["connect_ip"]),
            close=spec.get("close", lambda: None),
        )


class _Clock:
    def __init__(self):
        self.value = 100.0

    def now(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class _FakeSocket:
    def __init__(self, raw_response=b"", *, peer_ip=PUBLIC_IP):
        self._raw_response = raw_response
        self._offset = 0
        self.peer_ip = peer_ip
        self.sent = []
        self.connected_to = None
        self.closed = False

    def settimeout(self, _timeout):
        pass

    def connect(self, endpoint):
        self.connected_to = endpoint

    def getpeername(self):
        return (self.peer_ip, 443)

    def sendall(self, data):
        self.sent.append(data)

    def recv(self, size):
        if self._offset >= len(self._raw_response):
            return b""
        end = min(len(self._raw_response), self._offset + size)
        data = self._raw_response[self._offset:end]
        self._offset = end
        return data

    def makefile(self, _mode):
        return io.BytesIO(self._raw_response)

    def close(self):
        self.closed = True


class _TrickleSocket(_FakeSocket):
    def __init__(self, raw_response, *, clock, seconds_per_byte):
        super().__init__(raw_response)
        self.clock = clock
        self.seconds_per_byte = seconds_per_byte
        self.current_timeout = None
        self.recv_timeouts = []

    def settimeout(self, timeout):
        self.current_timeout = timeout

    def recv(self, _size):
        self.recv_timeouts.append(self.current_timeout)
        self.clock.advance(self.seconds_per_byte)
        return super().recv(1)


class _FakeTLSContext:
    def __init__(self, tls_socket):
        self.tls_socket = tls_socket
        self.wrap_calls = []

    def wrap_socket(self, sock, *, server_hostname):
        self.wrap_calls.append((sock, server_hostname))
        return self.tls_socket


def _fetcher(*responses, answers=None, resolver=None, policy=None, monotonic=None):
    _, _, safe_fetcher, _ = _api()
    transport = _StubTransport(responses or ({},))
    resolver = resolver or _StubResolver(answers or {"news.example": (PUBLIC_IP,)})
    fetcher = safe_fetcher(
        resolver=resolver,
        transport=transport,
        policy=policy,
        monotonic=monotonic,
    )
    return fetcher, resolver, transport


def test_fetch_policy_exposes_the_exact_public_safety_defaults():
    """Changing a constructor default would silently weaken or alter every generic fetch."""
    _, fetch_policy, _, _ = _api()

    policy = fetch_policy()

    assert (
        policy.max_redirects,
        policy.max_compressed_bytes,
        policy.max_decompressed_bytes,
        policy.total_timeout_seconds,
    ) == (3, 2 * 1024 * 1024, 8 * 1024 * 1024, 15.0)


def test_per_call_absolute_deadline_is_enforced_inside_the_body_read_loop():
    """Checking a browser deadline only after fetch returns permits a full extra fetch window."""
    fetch_error, _, _, _ = _api()
    clock = _Clock()

    def trickle():
        clock.advance(0.6)
        yield b"late"

    fetcher, _, transport = _fetcher(
        {"chunks": trickle()}, monotonic=clock.now
    )

    with pytest.raises(fetch_error, match="timeout"):
        fetcher.fetch("https://news.example/story", deadline=clock.now() + 0.5)

    assert transport.calls[0]["timeout"] <= 0.5


def test_per_call_wire_and_decompressed_overrides_are_enforced_before_return():
    """Post-return accounting can overfetch by one full policy-sized response."""
    fetch_error, _, _, _ = _api()
    fetcher, _, transport = _fetcher({"chunks": (b"1234",)})

    with pytest.raises(fetch_error, match="limit"):
        fetcher.fetch("https://news.example/story", max_wire_bytes=3)

    assert transport.calls[0]["max_wire_bytes"] == 3

    compressed = gzip.compress(b"expanded")
    fetcher, _, _ = _fetcher(
        {
            "headers": {
                "Content-Type": "text/plain",
                "Content-Encoding": "gzip",
            },
            "chunks": (compressed,),
        }
    )
    with pytest.raises(fetch_error, match="decompressed"):
        fetcher.fetch("https://news.example/story", max_decompressed_bytes=3)


def test_head_uses_real_method_status_and_safe_headers_without_reading_body():
    """Turning browser HEAD into a GET and a fabricated 200 changes upstream semantics."""
    body_touched = False

    def forbidden_body():
        nonlocal body_touched
        body_touched = True
        raise AssertionError("HEAD response body must not be consumed")
        yield b"unreachable"

    fetcher, _, transport = _fetcher(
        {
            "status": 404,
            "headers": {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": "42",
                "Access-Control-Allow-Origin": "https://reader.example",
                "Access-Control-Allow-Credentials": "true",
                "X-Secret-Upstream": "must-not-cross",
            },
            "chunks": forbidden_body(),
        }
    )

    document = fetcher.fetch(
        "https://news.example/missing",
        method="HEAD",
        allow_http_errors=True,
    )

    assert transport.calls[0]["method"] == "HEAD"
    assert document.status_code == 404
    assert document.content == b""
    assert body_touched is False
    assert dict(document.headers) == {
        "content-type": "text/plain; charset=utf-8",
        "content-length": "42",
        "access-control-allow-origin": "https://reader.example",
        "access-control-allow-credentials": "true",
    }


def test_gzip_get_recomputes_content_length_but_head_preserves_representation_length():
    """A decompressed GET body must not retain compressed length; HEAD describes representation."""
    expanded = b"expanded response body"
    compressed = gzip.compress(expanded)
    headers = {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
        "Content-Length": str(len(compressed)),
    }
    get_fetcher, _, _ = _fetcher({"headers": headers, "chunks": (compressed,)})

    fetched_get = get_fetcher.fetch("https://news.example/gzip")

    assert fetched_get.content == expanded
    assert dict(fetched_get.headers)["content-length"] == str(len(expanded))
    assert "content-encoding" not in dict(fetched_get.headers)

    body_touched = False

    def forbidden_body():
        nonlocal body_touched
        body_touched = True
        raise AssertionError("HEAD body must remain unread")
        yield b"unreachable"

    head_fetcher, _, _ = _fetcher(
        {"headers": headers, "chunks": forbidden_body()}
    )

    fetched_head = head_fetcher.fetch("https://news.example/gzip", method="HEAD")

    assert fetched_head.content == b""
    assert dict(fetched_head.headers)["content-length"] == str(len(compressed))
    assert body_touched is False


@pytest.mark.parametrize(
    "url",
    (
        "ftp://news.example/a?token=secret-value",
        "file:///etc/passwd?token=secret-value",
        "https://user:password@news.example/a?token=secret-value",
        "http://@news.example/a?token=secret-value",
    ),
)
def test_non_http_schemes_and_userinfo_are_rejected_without_secret_leakage(url):
    """Removing scheme/userinfo checks would send attacker-controlled targets or credentials."""
    fetch_error, _, _, _ = _api()
    fetcher, _, transport = _fetcher()

    with pytest.raises(fetch_error) as raised:
        fetcher.fetch(url)

    assert "secret-value" not in str(raised.value)
    assert "token=" not in str(raised.value)
    assert transport.calls == []


@pytest.mark.parametrize(
    "url",
    (
        "http://127.0.0.1/a",
        "http://[::1]/a",
        "http://10.0.0.1/a",
        "http://172.16.0.1/a",
        "http://192.168.0.1/a",
        "http://169.254.10.20/a",
        "http://169.254.169.254/latest/meta-data",
        "http://100.64.0.1/a",
        "http://224.0.0.1/a",
        "http://[ff02::1]/a",
        "http://[fc00::1]/a",
        "http://[fe80::1]/a",
        "http://[::ffff:127.0.0.1]/a",
        "http://127.0.0.1:8888/a",
    ),
)
def test_loopback_private_link_local_metadata_and_non_public_addresses_are_rejected(url):
    """Weakening the public-address gate would expose local services, including SearXNG's port."""
    fetch_error, _, _, _ = _api()
    fetcher, _, transport = _fetcher()

    with pytest.raises(fetch_error, match="public"):
        fetcher.fetch(url)

    assert transport.calls == []


@pytest.mark.parametrize(
    "url",
    (
        "http://0.0.0.0/a",
        "http://192.0.2.1/a",
        "http://198.51.100.1/a",
        "http://203.0.113.1/a",
        "http://240.0.0.1/a",
        "http://255.255.255.255/a",
        "http://[::]/a",
        "http://[2001:db8::1]/a",
    ),
)
def test_documentation_and_reserved_address_ranges_are_rejected(url):
    """Treating documentation or reserved space as globally routable would create SSRF gaps."""
    fetch_error, _, _, _ = _api()
    fetcher, _, transport = _fetcher()

    with pytest.raises(fetch_error, match="public"):
        fetcher.fetch(url)

    assert transport.calls == []


def test_mixed_public_and_private_dns_answer_rejects_the_whole_set():
    """Selecting only the first good answer would permit a mixed-answer rebinding bypass."""
    fetch_error, _, _, _ = _api()
    fetcher, resolver, transport = _fetcher(
        answers={"news.example": (PUBLIC_IP, "10.0.0.7")}
    )

    with pytest.raises(fetch_error, match="public"):
        fetcher.fetch("https://news.example/a")

    assert len(resolver.calls) == 1
    assert transport.calls == []


def test_connection_uses_approved_ip_but_original_host_and_sni():
    """Passing the hostname to the connector would reopen DNS TOCTOU after approval."""
    fetcher, _, transport = _fetcher(answers={"news.example": (PUBLIC_IP,)})

    fetched = fetcher.fetch("https://news.example/a")

    assert fetched.peer_ip == PUBLIC_IP
    assert fetched.content == b"ok"
    assert transport.calls[0]["connect_ip"] == PUBLIC_IP
    assert transport.last_host_header == "news.example"
    assert transport.last_server_hostname == "news.example"


def test_redirect_target_is_fully_revalidated_before_connecting():
    """Following a redirect without the full address gate would expose private destinations."""
    fetch_error, _, _, _ = _api()
    fetcher, _, transport = _fetcher(
        {"status": 302, "headers": {"Location": "http://10.0.0.8/admin"}},
        answers={"news.example": (PUBLIC_IP,)},
    )

    with pytest.raises(fetch_error, match="public"):
        fetcher.fetch("https://news.example/a")

    assert len(transport.calls) == 1


def test_redirect_loop_is_rejected_without_an_extra_connection():
    """Dropping canonical loop detection would repeatedly connect to the same target."""
    fetch_error, _, _, _ = _api()
    fetcher, _, transport = _fetcher(
        {"status": 302, "headers": {"Location": "/a"}},
    )

    with pytest.raises(fetch_error, match="redirect loop"):
        fetcher.fetch("https://news.example/a")

    assert len(transport.calls) == 1


def test_redirect_count_is_bounded_by_default_policy():
    """Removing the default three-hop cap would allow unbounded redirect work."""
    fetch_error, _, _, _ = _api()
    responses = tuple(
        {"status": 302, "headers": {"Location": f"/hop-{index + 1}"}}
        for index in range(4)
    )
    fetcher, _, transport = _fetcher(*responses)

    with pytest.raises(fetch_error, match="too many redirects"):
        fetcher.fetch("https://news.example/hop-0")

    assert len(transport.calls) == 4


def test_dns_rebinding_is_rejected_before_the_second_connection():
    """Reusing the first approval after DNS changes would permit same-host rebinding."""
    fetch_error, _, _, _ = _api()
    resolver = _SequencedResolver(((PUBLIC_IP,), ("127.0.0.1",)))
    fetcher, resolver, transport = _fetcher(
        {"status": 302, "headers": {"Location": "/next"}},
        resolver=resolver,
    )

    with pytest.raises(fetch_error, match="public"):
        fetcher.fetch("https://news.example/a")

    assert len(resolver.calls) == 2
    assert len(transport.calls) == 1


@pytest.mark.parametrize(
    "content_type",
    ("application/json", "image/png", "application/octet-stream", ""),
)
def test_non_html_and_non_text_content_types_are_rejected(content_type):
    """Accepting arbitrary binary media would violate the public-document boundary."""
    fetch_error, _, _, _ = _api()
    fetcher, _, _ = _fetcher(
        {"headers": {"Content-Type": content_type}, "chunks": (b"payload",)}
    )

    with pytest.raises(fetch_error, match="content type"):
        fetcher.fetch("https://news.example/a")


def test_content_length_is_not_trusted_instead_of_the_stream():
    """Rejecting solely from Content-Length would ignore the actual bounded byte stream."""
    fetcher, _, _ = _fetcher(
        {
            "headers": {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": str(100 * 1024 * 1024),
            },
            "chunks": (b"small",),
        }
    )

    fetched = fetcher.fetch("https://news.example/a")

    assert fetched.content == b"small"
    assert fetched.content_type == "text/html"


def test_default_compressed_byte_limit_counts_streamed_bytes():
    """Trusting a false Content-Length would allow more than 2 MiB onto the fetch path."""
    fetch_error, _, _, _ = _api()
    fetcher, _, _ = _fetcher(
        {
            "headers": {"Content-Type": "text/plain", "Content-Length": "1"},
            "chunks": (b"x" * (2 * 1024 * 1024), b"y"),
        }
    )

    with pytest.raises(fetch_error, match="compressed"):
        fetcher.fetch("https://news.example/a")


def test_default_decompressed_byte_limit_stops_a_gzip_bomb():
    """Checking only wire bytes would allow a tiny gzip body to inflate beyond 8 MiB."""
    fetch_error, _, _, _ = _api()
    compressed = gzip.compress(b"x" * (8 * 1024 * 1024 + 1))
    fetcher, _, _ = _fetcher(
        {
            "headers": {
                "Content-Type": "text/plain",
                "Content-Encoding": "gzip",
            },
            "chunks": (compressed,),
        }
    )

    with pytest.raises(fetch_error, match="decompressed"):
        fetcher.fetch("https://news.example/a")


def test_total_timeout_covers_streaming_not_only_connection_setup():
    """A per-operation timeout alone would allow the complete fetch to exceed 15 seconds."""
    fetch_error, _, _, _ = _api()
    clock = _Clock()

    def slow_chunks():
        clock.advance(15.1)
        yield b"late"

    fetcher, _, _ = _fetcher({"chunks": slow_chunks()}, monotonic=clock.now)

    with pytest.raises(fetch_error, match="timeout"):
        fetcher.fetch("https://news.example/a")


def test_transport_errors_never_expose_url_query_values():
    """Propagating a client exception verbatim would leak sensitive query values."""
    fetch_error, _, _, _ = _api()
    fetcher, _, _ = _fetcher(
        RuntimeError("failed https://news.example/a?token=secret-value")
    )

    with pytest.raises(fetch_error) as raised:
        fetcher.fetch("https://news.example/a?token=secret-value")

    assert "secret-value" not in str(raised.value)
    assert "token=" not in str(raised.value)


def _direct_transport_request(transport, *, scheme="http"):
    return transport.request(
        scheme=scheme,
        connect_ip=PUBLIC_IP,
        port=443 if scheme == "https" else 80,
        request_target="/a?token=never-sent",
        host_header="news.example",
        server_hostname="news.example" if scheme == "https" else None,
        timeout=1.0,
    )


def test_socket_transport_rejects_tcp_peer_mismatch_before_tls_or_send(monkeypatch):
    """Checking peer identity only after HTTP I/O would disclose the request to a wrong peer."""
    from jarvis.search import fetcher as fetcher_module

    raw_socket = _FakeSocket(peer_ip="10.0.0.7")
    tls_socket = _FakeSocket(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nok"
    )
    context = _FakeTLSContext(tls_socket)
    monkeypatch.setattr(fetcher_module.socket, "socket", lambda *_args: raw_socket)
    monkeypatch.setattr(fetcher_module.ssl, "create_default_context", lambda: context)

    error = None
    try:
        _direct_transport_request(fetcher_module._SocketTransport(), scheme="https")
    except Exception as exc:  # noqa: BLE001 - assert the exact safe failure below
        error = exc

    assert context.wrap_calls == []
    assert raw_socket.sent == []
    assert isinstance(error, fetcher_module.FetchError)


def test_socket_transport_rechecks_tls_peer_before_send(monkeypatch):
    """Skipping the post-wrap peer check would send request data on a replaced TLS socket."""
    from jarvis.search import fetcher as fetcher_module

    raw_socket = _FakeSocket(peer_ip=PUBLIC_IP)
    tls_socket = _FakeSocket(peer_ip="10.0.0.8")
    context = _FakeTLSContext(tls_socket)
    monkeypatch.setattr(fetcher_module.socket, "socket", lambda *_args: raw_socket)
    monkeypatch.setattr(fetcher_module.ssl, "create_default_context", lambda: context)

    error = None
    try:
        _direct_transport_request(fetcher_module._SocketTransport(), scheme="https")
    except Exception as exc:  # noqa: BLE001 - assert the exact safe failure below
        error = exc

    assert len(context.wrap_calls) == 1
    assert tls_socket.sent == []
    assert isinstance(error, fetcher_module.FetchError)


def _force_legacy_permissive_ipv6_classification(monkeypatch):
    monkeypatch.setattr(
        ipaddress.IPv6Address,
        "is_global",
        property(lambda _address: True),
    )
    for attribute in ("is_private", "is_reserved"):
        monkeypatch.setattr(
            ipaddress.IPv6Address,
            attribute,
            property(lambda _address: False),
        )


@pytest.mark.parametrize(
    "url",
    (
        "http://[2002:7f00:1::]/a",
        "http://[2002:a00:1::]/a",
        "http://[64:ff9b::a9fe:a9fe]/a",
        "http://[::ffff:0:a9fe:a9fe]/a",
        "http://[2001:0:c000:201:0:0:f5ff:fffe]/a",
        "http://[fd00::1]/a",
    ),
)
def test_special_ipv6_ranges_reject_embedded_local_ipv4_across_runtime_versions(
    monkeypatch,
    url,
):
    """Depending on ipaddress version flags would reopen transition-address SSRF."""
    fetch_error, _, _, _ = _api()
    _force_legacy_permissive_ipv6_classification(monkeypatch)
    fetcher, _, transport = _fetcher()

    with pytest.raises(fetch_error, match="public"):
        fetcher.fetch(url)

    assert transport.calls == []


@pytest.mark.parametrize(
    ("embedded", "allowed"),
    (
        ("10.0.0.1", False),
        (PUBLIC_IP, True),
    ),
)
def test_configured_local_nat64_prefix_recursively_checks_embedded_ipv4(
    monkeypatch,
    embedded,
    allowed,
):
    """Treating a configured local NAT64 prefix as wholly trusted would expose private IPv4."""
    fetch_error, _, safe_fetcher, _ = _api()
    _force_legacy_permissive_ipv6_classification(monkeypatch)
    address = ipaddress.IPv4Address(embedded)
    url = f"http://[fd00:64::{int(address) >> 16:x}:{int(address) & 0xffff:x}]/a"
    transport = _StubTransport(({},))
    fetcher = safe_fetcher(
        resolver=_StubResolver({}),
        transport=transport,
        local_nat64_prefixes=("fd00:64::/96",),
    )

    if allowed:
        expected_peer = str(ipaddress.ip_address(url.split("[")[1].split("]")[0]))
        assert fetcher.fetch(url).peer_ip == expected_peer
        assert len(transport.calls) == 1
    else:
        with pytest.raises(fetch_error, match="public"):
            fetcher.fetch(url)
        assert transport.calls == []


@pytest.mark.parametrize(
    "prefix",
    (
        "::ffff:0:0/96",
        "::ffff:0:0:0/96",
        "2002:c0a8::/32",
        "2001::/32",
        "64:ff9b::/96",
    ),
    ids=("mapped", "translated", "6to4", "teredo", "well-known-nat64"),
)
def test_local_nat64_configuration_rejects_inherent_special_range_overlap(prefix):
    """Allowing local NAT64 to overlap an inherent representation would change its meaning."""
    _, _, safe_fetcher, _ = _api()

    with pytest.raises(ValueError, match="overlap"):
        safe_fetcher(
            resolver=_StubResolver({}),
            transport=_StubTransport(({},)),
            local_nat64_prefixes=(prefix,),
        )


def test_inherent_6to4_semantics_precede_preparsed_local_nat64_prefix():
    """Checking local NAT64 first would reinterpret private 6to4 as a public IPv4 target."""
    from jarvis.search.fetcher import _is_public_address

    target = ipaddress.ip_address("2002:c0a8:5db8:d822::")
    overlapping_prefix = ipaddress.ip_network("2002:c0a8::/32")

    assert _is_public_address(target, (overlapping_prefix,)) is False


def _fetch_raw_response(monkeypatch, raw_response):
    from jarvis.search import fetcher as fetcher_module

    fake_socket = _FakeSocket(raw_response)
    monkeypatch.setattr(fetcher_module.socket, "socket", lambda *_args: fake_socket)
    fetcher = fetcher_module.SafeFetcher(resolver=_StubResolver({"news.example": (PUBLIC_IP,)}))
    return fetcher, fake_socket


def test_wire_limit_counts_status_headers_and_framing_not_only_payload(monkeypatch):
    """Counting only transfer-decoded payload would permit a response over the 2 MiB wire cap."""
    fetch_error, _, _, _ = _api()
    body = b"x" * (2 * 1024 * 1024 - 1)
    raw = (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: text/plain\r\n"
        + f"Content-Length: {len(body)}\r\n\r\n".encode()
        + body
    )
    fetcher, _ = _fetch_raw_response(monkeypatch, raw)

    with pytest.raises(fetch_error, match="wire"):
        fetcher.fetch("http://news.example/a")


def test_wire_reader_recomputes_total_deadline_for_each_trickled_byte(monkeypatch):
    """Reusing one socket timeout would let sub-timeout bytes extend the total indefinitely."""
    from jarvis.search import fetcher as fetcher_module

    clock = _Clock()
    raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok"
    fake_socket = _TrickleSocket(raw, clock=clock, seconds_per_byte=0.75)
    monkeypatch.setattr(fetcher_module.socket, "socket", lambda *_args: fake_socket)
    monkeypatch.setattr(fetcher_module.time, "monotonic", clock.now)
    fetcher = fetcher_module.SafeFetcher(
        policy=fetcher_module.FetchPolicy(total_timeout_seconds=3.0),
        resolver=_StubResolver({"news.example": (PUBLIC_IP,)}),
        monotonic=clock.now,
    )

    with pytest.raises(fetcher_module.FetchError, match="timeout"):
        fetcher.fetch("http://news.example/a")

    assert len(fake_socket.recv_timeouts) <= 4
    assert all(
        earlier > later
        for earlier, later in zip(
            fake_socket.recv_timeouts,
            fake_socket.recv_timeouts[1:],
        )
    )


def _large_initial_headers():
    headers = b"".join(
        f"X-Fill-{index}: ".encode() + b"a" * 1000 + b"\r\n"
        for index in range(70)
    )
    return b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n" + headers + b"\r\nok"


def _large_chunk_extensions():
    extension = b"a" * 40_000
    chunks = b"1;x=" + extension + b"\r\na\r\n" + b"1;y=" + extension + b"\r\nb\r\n"
    return (
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n" + chunks + b"0\r\n\r\n"
    )


def _large_trailers():
    trailers = b"".join(
        f"X-Trailer-{index}: ".encode() + b"a" * 1000 + b"\r\n"
        for index in range(70)
    )
    return (
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\n" + trailers + b"\r\n"
    )


@pytest.mark.parametrize(
    "raw_response",
    (_large_initial_headers(), _large_chunk_extensions(), _large_trailers()),
    ids=("headers", "chunk-extensions", "trailers"),
)
def test_response_metadata_limit_covers_headers_chunk_extensions_and_trailers(
    monkeypatch,
    raw_response,
):
    """Limiting each line alone would allow aggregate protocol metadata exhaustion."""
    fetch_error, _, _, _ = _api()
    assert len(raw_response) < 2 * 1024 * 1024
    fetcher, _ = _fetch_raw_response(monkeypatch, raw_response)

    with pytest.raises(fetch_error, match="metadata"):
        fetcher.fetch("http://news.example/a")


def test_chunk_count_limit_rejects_many_tiny_chunks_below_wire_limit(monkeypatch):
    """A small payload split into unbounded chunks would consume unbounded parser work."""
    fetch_error, _, _, _ = _api()
    chunks = b"1\r\na\r\n" * 1025
    raw = (
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n" + chunks + b"0\r\n\r\n"
    )
    assert len(raw) < 2 * 1024 * 1024
    fetcher, _ = _fetch_raw_response(monkeypatch, raw)

    with pytest.raises(fetch_error, match="chunk"):
        fetcher.fetch("http://news.example/a")


def test_system_resolver_workers_and_queue_remain_bounded_when_dns_blocks():
    """Starting one daemon per timeout would allow an attacker to accumulate threads."""
    from jarvis.search.fetcher import _ResolverWorkerPool, _SystemResolver

    release = threading.Event()
    started = threading.Barrier(3)

    def blocking_getaddrinfo(*_args, **_kwargs):
        started.wait(timeout=1)
        release.wait(timeout=2)
        return []

    prefix = "safe-fetch-dns-test"
    pool = _ResolverWorkerPool(
        max_workers=2,
        max_queue=1,
        getaddrinfo=blocking_getaddrinfo,
        thread_name_prefix=prefix,
    )
    resolver = _SystemResolver(pool=pool)
    caller_errors = []

    def occupy_worker():
        try:
            resolver.resolve("news.example", 443, 1.0)
        except Exception as exc:  # noqa: BLE001 - callers are expected to time out
            caller_errors.append(exc)

    callers = [threading.Thread(target=occupy_worker) for _ in range(2)]
    for caller in callers:
        caller.start()
    started.wait(timeout=1)

    try:
        with pytest.raises(TimeoutError):
            resolver.resolve("queued.example", 443, 0.01)
        before = time.monotonic()
        with pytest.raises(OSError, match="busy"):
            resolver.resolve("overflow.example", 443, 1.0)
        elapsed = time.monotonic() - before

        workers = [thread for thread in threading.enumerate() if thread.name.startswith(prefix)]
        assert len(workers) == 2
        assert elapsed < 0.1
    finally:
        release.set()
        for caller in callers:
            caller.join(timeout=1)


@pytest.mark.parametrize(
    "headers",
    (
        (("Content-Type", "text/plain"), ("Content-Type", "text/html")),
        (
            ("Content-Type", "text/plain"),
            ("Content-Encoding", "gzip"),
            ("Content-Encoding", "identity"),
        ),
        (("Content-Type", "text/plain, text/html"),),
        (("Content-Type", "text/"),),
        (("Content-Type", "text/pla(in"),),
        (("Content-Type", "text/*"),),
        (("Content-Type", "text/plain"), ("Content-Encoding", "gzip, identity")),
    ),
    ids=(
        "duplicate-content-type",
        "duplicate-content-encoding",
        "comma-content-type",
        "empty-subtype",
        "invalid-token",
        "wildcard-subtype",
        "comma-content-encoding",
    ),
)
def test_ambiguous_or_invalid_safety_headers_are_rejected(headers):
    """Folding singleton safety headers would let an ambiguous value reach body handling."""
    fetch_error, _, _, _ = _api()
    fetcher, _, _ = _fetcher({"headers": headers, "chunks": (b"payload",)})

    with pytest.raises(fetch_error, match="(content type|content encoding)"):
        fetcher.fetch("https://news.example/a")


def test_valid_rfc_content_type_token_and_quoted_parameters_are_accepted():
    """Rejecting legal quoted separators would replace RFC parsing with naive splitting."""
    fetcher, _, _ = _fetcher(
        {
            "headers": {
                "Content-Type": 'text/html; charset=utf-8; profile="a=b;c"',
            },
            "chunks": (b"ok",),
        }
    )

    assert fetcher.fetch("https://news.example/a").content_type == "text/html"
