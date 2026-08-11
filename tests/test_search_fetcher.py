"""SSRF-safe public document fetching without live network access."""
from __future__ import annotations

import gzip

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
