"""Heartbeat 主动唤醒：清单裁量、双通道推送、开关与异常安全、端点送达。"""
import datetime
from types import SimpleNamespace

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
from jarvis.heartbeat import (DEFAULT_INTERVAL, HeartbeatScanner, PendingOutbox,
                              maybe_create)
from jarvis.tenancy import tenant_scope

NOW = datetime.datetime(2026, 8, 19, 15, 0)
OWNER = SimpleNamespace(user_id="owner-1")


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


def _scanner(tmp_path, *, content="盯着下午的会", compose=None, push=None, outbox=None):
    path = tmp_path / "HEARTBEAT.md"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    return HeartbeatScanner(
        owner_getter=lambda: OWNER,
        compose=compose or (lambda owner, text, now: "该开会了"),
        push_wechat=push,
        outbox=outbox,
        path_fn=lambda: path,
        now_fn=lambda: NOW,
    )


def test_due_content_pushes_both_channels(tmp_path):
    pushed = []
    outbox = PendingOutbox()
    s = _scanner(tmp_path, push=lambda text: pushed.append(text) or True, outbox=outbox)
    assert s.scan_once() is True
    assert pushed == ["🔔 该开会了"]
    items = outbox.drain(OWNER.user_id)
    assert [x["title"] for x in items] == ["该开会了"]
    assert items[0]["when"] == "2026-08-19 15:00"


def test_pass_or_blank_verdict_stays_silent(tmp_path):
    pushed = []
    for verdict in ("PASS", "pass", "", "  "):
        s = _scanner(tmp_path, compose=lambda o, t, n, v=verdict: v,
                     push=lambda text: pushed.append(text) or True)
        assert s.scan_once() is False
    assert pushed == []


def test_missing_or_empty_file_never_calls_model(tmp_path):
    calls = []
    compose = lambda o, t, n: calls.append(t) or "该开会了"  # noqa: E731
    missing = _scanner(tmp_path, content=None, compose=compose)
    assert missing.scan_once() is False
    empty = _scanner(tmp_path, content="   \n", compose=compose)
    assert empty.scan_once() is False
    assert calls == []


def test_env_switch_disables_scanner_entirely(monkeypatch):
    monkeypatch.setenv("JARVIS_HEARTBEAT_ENABLED", "0")
    assert maybe_create() is None
    monkeypatch.setenv("JARVIS_HEARTBEAT_ENABLED", "1")
    monkeypatch.setenv("JARVIS_HEARTBEAT_INTERVAL", "120")
    s = maybe_create()
    assert isinstance(s, HeartbeatScanner) and s._interval == 120.0
    monkeypatch.setenv("JARVIS_HEARTBEAT_INTERVAL", "not-a-number")
    assert maybe_create()._interval == DEFAULT_INTERVAL


def test_wechat_failure_still_delivers_to_outbox(tmp_path):
    outbox = PendingOutbox()
    def boom(text):
        raise RuntimeError("bridge down")
    s = _scanner(tmp_path, push=boom, outbox=outbox)
    assert s.scan_once() is True   # 微信挂了不影响桌面通道
    assert [x["title"] for x in outbox.drain(OWNER.user_id)] == ["该开会了"]


def test_compose_exception_is_contained(tmp_path):
    pushed = []
    def explode(owner, text, now):
        raise RuntimeError("model down")
    s = _scanner(tmp_path, compose=explode, push=lambda t: pushed.append(t) or True)
    assert s.scan_once() is False   # 只告警不外抛
    assert pushed == []


def test_outbox_drain_clears_per_user():
    outbox = PendingOutbox()
    outbox.put("u1", "a", "2026-08-19 15:00")
    outbox.put("u1", "b", "2026-08-19 15:30")
    outbox.put("u2", "c", "2026-08-19 15:00")
    assert [x["title"] for x in outbox.drain("u1")] == ["a", "b"]
    assert outbox.drain("u1") == []          # 领取即清
    assert [x["title"] for x in outbox.drain("u2")] == ["c"]


def test_pending_endpoint_delivers_heartbeat_items():
    user_id = AccountStore().list_users()[0]["id"]
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    server_mod._heartbeat_outbox.put(user_id, "该喝水了", "2026-08-19 15:00")
    items = c.get("/api/reminders/pending").json()["items"]
    assert [x["title"] for x in items] == ["该喝水了"]
    assert c.get("/api/reminders/pending").json()["items"] == []   # 领取即清
