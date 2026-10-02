"""长时间运行的后台线程（2026-10-02 QA 轮）：异常时不能静默死亡，要有退避与日志。"""
import logging
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from jarvis import distill, heartbeat, reminders, wechat
from test_wechat import FakeClient, FakeResponse, make_bridge


class RecordingStop:
    def __init__(self):
        self.waits = []

    def is_set(self):
        return False

    def set(self):
        pass

    def wait(self, seconds):
        self.waits.append(seconds)
        return False


def _connected(bridge, tmp_path):
    bridge._generation = 1
    bridge._set(state="connected")
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")


def _text_msg(text, sender="wxid_alice@im.wechat"):
    return {"from_user_id": sender, "message_type": 1, "context_token": "ctx",
            "item_list": [{"type": 1, "text_item": {"text": text}}]}


# ---------- 微信长轮询 ----------

def test_wechat_loop_survives_unexpected_exception_and_backs_off(tmp_path, caplog):
    """实测：只捕获 HTTPError/TypeError/ValueError，写盘 PermissionError 等异常直接打死线程，
    状态却还显示 connected、没有任何 jarvis 日志。"""

    class Exploding(FakeClient):
        def post(self, url, **kwargs):
            self.post_calls.append((url, kwargs))
            if len(self.post_calls) == 1:
                raise RuntimeError("unexpected")
            return FakeResponse(status_code=401)

    client = Exploding()
    bridge, _ = make_bridge(tmp_path, client)
    _connected(bridge, tmp_path)
    stop = RecordingStop()
    with caplog.at_level(logging.WARNING):
        bridge._updates_loop(1, "saved", stop)
    assert len(client.post_calls) == 2, "异常后必须继续轮询"
    assert stop.waits and stop.waits[0] >= 1
    assert any("getupdates" in r.getMessage() for r in caplog.records)


def test_wechat_network_errors_back_off_exponentially(tmp_path):
    class Flaky(FakeClient):
        def post(self, url, **kwargs):
            self.post_calls.append((url, kwargs))
            if len(self.post_calls) <= 4:
                raise httpx.ConnectError("down")
            return FakeResponse(status_code=401)

    client = Flaky()
    bridge, _ = make_bridge(tmp_path, client)
    _connected(bridge, tmp_path)
    stop = RecordingStop()
    bridge._updates_loop(1, "saved", stop)
    assert stop.waits == [2, 4, 8, 16]


def test_wechat_fast_empty_polls_are_throttled(tmp_path):
    """服务端若秒回空结果，旧实现会以每秒数千次的频率空转。"""
    client = FakeClient(post_responses=[FakeResponse({"ret": 0, "msgs": []}), FakeResponse(status_code=401)])
    bridge, _ = make_bridge(tmp_path, client)
    _connected(bridge, tmp_path)
    stop = RecordingStop()
    bridge._updates_loop(1, "saved", stop)
    assert stop.waits == [wechat.MIN_EMPTY_POLL_SECONDS]


def test_wechat_malformed_message_does_not_replay_batch(tmp_path):
    """实测：同批里一条 item_list=None 的消息让整批抛 TypeError；游标已落盘但内存游标没更新，
    下一轮整批重放，同一人 6.5 秒内被回复 4 次。"""
    client = FakeClient()
    bridge, agent_calls = make_bridge(tmp_path, client)
    bad = {"from_user_id": "wxid_bob@im.wechat", "message_type": 1, "item_list": None}
    next_buf = bridge._handle_updates_response(client, "token", {
        "ret": 0, "get_updates_buf": "cursor-2", "msgs": [_text_msg("你好"), bad, _text_msg("在吗", "wxid_carol@im.wechat")],
    })
    assert next_buf == "cursor-2"
    assert [c["text"] for c in agent_calls] == ["你好", "在吗"]


def test_wechat_cursor_save_failure_still_processes_messages(tmp_path, monkeypatch, caplog):
    client = FakeClient()
    bridge, agent_calls = make_bridge(tmp_path, client)

    def deny(_value):
        raise PermissionError("read-only data dir")

    monkeypatch.setattr(bridge, "_save_sync_buf", deny)
    with caplog.at_level(logging.WARNING):
        next_buf = bridge._handle_updates_response(client, "token", {
            "ret": 0, "get_updates_buf": "cursor-3", "msgs": [_text_msg("记一下")]})
    assert next_buf == "cursor-3" and [c["text"] for c in agent_calls] == ["记一下"]
    assert any("cursor" in r.getMessage() for r in caplog.records)


def test_wechat_resume_with_unreadable_token_does_not_raise(tmp_path, monkeypatch):
    bridge, _ = make_bridge(tmp_path, FakeClient())
    token = tmp_path / "wechat_token"
    token.write_text("saved", encoding="utf-8")
    original = type(token).read_text

    def unreadable(self, *args, **kwargs):
        if self.name == "wechat_token":
            raise PermissionError("denied")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(type(token), "read_text", unreadable)
    status = bridge.resume_on_boot()
    assert status["state"] != "connected" and status["error"]


def test_lifespan_survives_channel_startup_failure(monkeypatch):
    """实测：resume_on_boot 抛 PermissionError 时 lifespan 没接住，整个服务起不来。"""
    import jarvis.server as server_mod

    def boom():
        raise PermissionError("token unreadable")

    monkeypatch.setattr(server_mod.wechat, "resume_on_boot", boom)
    monkeypatch.setenv("JARVIS_REMINDERS_ENABLED", "0")
    monkeypatch.setenv("JARVIS_HEARTBEAT_ENABLED", "0")
    monkeypatch.setenv("JARVIS_WEAK_PASSWORD_SCAN", "0")
    with TestClient(server_mod.app) as client:
        assert client.get("/api/session").status_code == 200


# ---------- 定时扫描线程（提醒 / 晨报 / 心跳 / 蒸馏） ----------

def _workers(interval=0.01):
    return [
        reminders.ReminderScanner(owner_getter=lambda: None, push_wechat=lambda _t: True, interval=interval),
        reminders.MorningRadio(owner_getter=lambda: None, compose=lambda _o: "", push_voice=lambda _t: True,
                               interval=interval),
        heartbeat.HeartbeatScanner(owner_getter=lambda: None, compose=lambda *_a: "", interval=interval),
        distill.NightlyDistiller(owner_getter=lambda: None, collect=lambda _o: "", compose=lambda *_a: "",
                                 remember=lambda *_a: True, interval=interval),
    ]


@pytest.mark.parametrize("worker", _workers(), ids=lambda w: type(w).__name__)
def test_worker_loop_survives_crashing_round(worker, monkeypatch, caplog):
    """实测：scan_once 的 try 之外（now_fn、parse_facts、briefing.strip 等）一旦抛错线程就死，
    只在 stderr 留堆栈，之后提醒/晨报/心跳/蒸馏全部无声停摆。"""
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return 0

    monkeypatch.setattr(worker, "scan_once", flaky)
    with caplog.at_level(logging.ERROR):
        worker.start()
        deadline = time.monotonic() + 3
        while len(calls) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        alive = worker._thread is not None and worker._thread.is_alive()
        worker.stop()
    assert len(calls) >= 3 and alive
    assert any("crashed" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("worker", _workers(), ids=lambda w: type(w).__name__)
def test_worker_restart_does_not_leave_two_threads(worker, monkeypatch):
    """实测：stop() 不 join、start() 又 clear 同一个 Event——旧线程若正在跑一轮，回到 wait 时
    信号已被清掉，于是复活，两个线程同时跑（各烧一份模型调用）。"""
    gate, entered = threading.Event(), threading.Event()
    owners = set()

    def slow_round():
        owners.add(threading.current_thread())
        entered.set()
        gate.wait(2)
        return 0

    monkeypatch.setattr(worker, "scan_once", slow_round)
    worker.start()
    assert entered.wait(2)
    first = worker._thread
    worker.stop()
    worker.start()          # 旧线程还卡在本轮里
    gate.set()
    deadline = time.monotonic() + 2
    while first.is_alive() and time.monotonic() < deadline:
        time.sleep(0.01)
    worker.stop()
    assert not first.is_alive(), "旧线程必须退出"


def test_owner_lookup_failure_is_logged_not_silent(caplog):
    def broken():
        raise RuntimeError("db locked")

    scanner = reminders.ReminderScanner(owner_getter=broken, push_wechat=lambda _t: True)
    with caplog.at_level(logging.WARNING):
        assert scanner.scan_once() == 0
    assert any("owner" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("raw,expected", [("0", 60.0), ("-5", 60.0), ("1", 60.0), ("inf", 86400.0),
                                           ("nan", heartbeat.DEFAULT_INTERVAL), ("120", 120.0)])
def test_heartbeat_interval_is_clamped(monkeypatch, raw, expected):
    """实测：JARVIS_HEARTBEAT_INTERVAL=0 时 0.5 秒内调用模型 74 万次。"""
    monkeypatch.setenv("JARVIS_HEARTBEAT_INTERVAL", raw)
    assert heartbeat.maybe_create()._interval == expected


def test_pending_outbox_is_bounded():
    """实测：无人领取时一周积压 336 条，网页一登录就弹一屏。"""
    box = heartbeat.PendingOutbox()
    for i in range(100):
        box.put("u1", f"消息{i}", f"2026-10-02 10:{i % 60:02d}")
    items = box.drain("u1")
    assert len(items) == heartbeat.MAX_PENDING_PER_USER
    assert items[-1]["title"] == "消息99"


# ---------- 飞书长连接 ----------

def test_feishu_reconnect_has_minimum_delay():
    """平台下发 ReconnectNonce=0 且连上即断时，旧实现零间隔重连（实测每秒上万次）。"""
    from jarvis.channels.feishu.ws import LongConnection
    from feishu_fakes import APP_ID, APP_SECRET, FakeFeishu, FakeWS

    fake = FakeFeishu()
    connects = []

    def connect(url):
        connects.append(time.monotonic())
        return FakeWS([ConnectionError("drop")])

    conn = LongConnection(APP_ID, APP_SECRET, on_event=lambda _e: None, on_state=lambda *_a: None,
                          client_factory=fake.client, rng=lambda: 0.0, ws_connect=connect)
    conn.reconnect_nonce = 0
    conn.configure = lambda _conf: None   # 保持 nonce=0
    conn.start()
    time.sleep(0.5)
    conn.stop(timeout=3)
    assert 1 <= len(connects) <= 2
