"""飞书长连接客户端：取地址、立即 ack、分片合包、心跳与配置、断线重连、握手错误。"""
import json
import threading
import time
from types import SimpleNamespace

import pytest

from jarvis.channels.feishu.frame import METHOD_CONTROL, METHOD_DATA, Frame
from jarvis.channels.feishu.ws import ConnectError, LongConnection, _handshake_error

from feishu_fakes import APP_ID, APP_SECRET, FakeFeishu, FakeWS, event_frame, message_event


def make_conn(fake=None, **kwargs):
    fake = fake or FakeFeishu()
    events, states = [], []
    conn = LongConnection(
        APP_ID, APP_SECRET, on_event=events.append, on_state=lambda s, e: states.append((s, e)),
        client_factory=fake.client, rng=lambda: 0.0, **kwargs,
    )
    return conn, events, states


def test_event_frame_is_acked_with_code_200_and_biz_rt():
    """官方要求 3 秒内 ack：处理完回写同一帧（同 SeqID/头）+ biz_rt，payload={"code":200}。"""
    conn, events, _ = make_conn()
    ws = FakeWS()

    conn.handle_frame(ws, event_frame(message_event("在吗"), seq_id=42))

    assert events[0]["header"]["event_id"] == "ev_1"
    [ack] = ws.outbox
    assert ack.seq_id == 42 and ack.method == METHOD_DATA and ack.service == 77
    assert ack.header("message_id") == "frame-msg-1" and ack.header("biz_rt") is not None
    assert json.loads(ack.payload) == {"code": 200}


def test_handler_crash_acks_500_and_bad_json_still_acks():
    ws = FakeWS()
    conn = LongConnection(APP_ID, APP_SECRET, on_event=lambda e: 1 / 0)
    conn.handle_frame(ws, event_frame({"header": {}}))
    assert json.loads(ws.outbox[-1].payload) == {"code": 500}

    broken = Frame(method=METHOD_DATA, headers=[("type", "event"), ("sum", "1"), ("seq", "0")], payload=b"{oops")
    conn.handle_frame(ws, broken.encode())
    assert json.loads(ws.outbox[-1].payload) == {"code": 200}  # 坏包重推也没用，直接 ack 免重推风暴


def test_fragmented_payload_is_combined_then_acked_once():
    conn, events, _ = make_conn()
    ws = FakeWS()
    payload = json.dumps(message_event("分片消息"), ensure_ascii=False).encode()
    half = len(payload) // 2
    for seq, part in ((1, payload[half:]), (0, payload[:half])):
        conn.handle_frame(ws, Frame(method=METHOD_DATA, headers=[
            ("type", "event"), ("message_id", "big"), ("sum", "2"), ("seq", str(seq))], payload=part).encode())

    assert len(events) == 1 and len(ws.outbox) == 1
    assert json.loads(events[0]["event"]["message"]["content"]) == {"text": "分片消息"}


def test_pong_payload_updates_client_config_and_ping_is_ignored():
    conn, events, _ = make_conn()
    ws = FakeWS()
    conn.handle_frame(ws, Frame(method=METHOD_CONTROL, headers=[("type", "pong")],
                                payload=b'{"PingInterval": 30, "ReconnectInterval": 5, "ReconnectNonce": 2}').encode())
    conn.handle_frame(ws, Frame(method=METHOD_CONTROL, headers=[("type", "ping")]).encode())

    assert (conn.ping_interval, conn.reconnect_interval, conn.reconnect_nonce) == (30, 5, 2)
    assert ws.outbox == [] and events == []


def test_discover_returns_url_and_applies_client_config():
    fake = FakeFeishu()
    conn, _, _ = make_conn(fake)

    assert conn.discover() == "wss://ws.example.test/ws?device_id=dev-1&service_id=77"
    assert (conn.ping_interval, conn.reconnect_interval, conn.reconnect_nonce) == (90, 60, 10)
    assert fake.calls[0]["path"] == "/callback/ws/endpoint"


@pytest.mark.parametrize("code,fatal", [(1, False), (1000040343, False), (10003, True)])
def test_discover_error_codes_are_classified(code, fatal):
    fake = FakeFeishu()
    fake.endpoint = {"code": code, "msg": "nope"}
    conn, _, _ = make_conn(fake)
    with pytest.raises(ConnectError) as caught:
        conn.discover()
    assert caught.value.fatal is fatal
    assert APP_SECRET not in str(caught.value)


def test_handshake_headers_map_to_actionable_errors():
    limit = SimpleNamespace(response=SimpleNamespace(headers={
        "handshake-status": "514", "handshake-msg": "limit", "handshake-autherrcode": "1000040350"}))
    forbidden = SimpleNamespace(response=SimpleNamespace(headers={"handshake-status": "403", "handshake-msg": "no"}))
    assert _handshake_error(limit).fatal and "50" in str(_handshake_error(limit))
    assert _handshake_error(forbidden).fatal
    assert _handshake_error(RuntimeError("plain")) is None


def test_run_forever_pings_receives_and_reconnects_after_drop():
    """断线后自动重连：第一条连接收一个事件后掉线，第二条连接上来后再收一个事件。"""
    fake = FakeFeishu()
    first = FakeWS([event_frame(message_event(message_id="om_a"), seq_id=1), ConnectionError("drop")])
    second = FakeWS([event_frame(message_event(message_id="om_b"), seq_id=2)])
    sockets = iter([first, second])
    urls = []

    def connect(url):
        urls.append(url)
        return next(sockets)

    conn, events, states = make_conn(fake, ws_connect=connect)
    conn.start()
    deadline = time.monotonic() + 5
    while len(events) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    conn.stop(timeout=3)

    assert [e["event"]["message"]["message_id"] for e in events] == ["om_a", "om_b"]
    assert len(urls) == 2 and [c["path"] for c in fake.calls].count("/callback/ws/endpoint") == 2
    for ws in (first, second):
        pings = [f for f in ws.outbox if f.method == METHOD_CONTROL]
        assert pings and pings[0].header("type") == "ping" and pings[0].service == 77
    names = [s for s, _ in states]
    assert names[:2] == ["connecting", "connected"] and "reconnecting" in names
    assert names[-1] == "stopped" and second.closed


def test_fatal_discovery_error_backs_off_without_busy_loop():
    fake = FakeFeishu()
    fake.endpoint = {"code": 10003, "msg": "invalid app"}
    conn, _, states = make_conn(fake)
    conn.start()
    deadline = time.monotonic() + 2
    while not any(s == "error" for s, _ in states) and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(0.1)
    conn.stop(timeout=3)

    assert [c["path"] for c in fake.calls].count("/callback/ws/endpoint") == 1  # 600 秒后才会再试
    assert any(s == "error" and "code=10003" in e for s, e in states)


def test_real_websocket_roundtrip_against_local_server():
    """真 socket：本地 websockets 服务端推一条事件帧，客户端要回 ack 并发心跳。"""
    from websockets.sync.server import serve

    received, done = [], threading.Event()

    def handler(ws):
        ws.send(event_frame(message_event("真连接"), seq_id=5))
        for _ in range(2):
            received.append(Frame.decode(ws.recv(timeout=5)))
        done.set()
        ws.recv(timeout=5)  # 等客户端关闭

    server = serve(handler, "127.0.0.1", 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.socket.getsockname()[1]
    fake = FakeFeishu()
    fake.endpoint["data"]["URL"] = f"ws://127.0.0.1:{port}/ws?device_id=d&service_id=77"
    conn, events, _ = make_conn(fake)
    try:
        conn.start()
        assert done.wait(5)
    finally:
        conn.stop(timeout=3)
        server.shutdown()

    assert events[0]["event"]["message"]["content"] == json.dumps({"text": "真连接"}, ensure_ascii=False)
    kinds = {(f.method, f.header("type")) for f in received}
    assert kinds == {(METHOD_CONTROL, "ping"), (METHOD_DATA, "event")}
    ack = next(f for f in received if f.method == METHOD_DATA)
    assert ack.seq_id == 5 and json.loads(ack.payload) == {"code": 200}
