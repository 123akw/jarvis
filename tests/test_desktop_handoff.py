"""桌面接管票据测试：一次性、60 秒时效、绑定用户、不碰密码、不落日志。"""
import logging

import pytest
from fastapi.testclient import TestClient

import jarvis.server as server_mod


@pytest.fixture(autouse=True)
def clean_ticket_table():
    """内存票据表跨测试清零，保证每条测试从空表出发。"""
    with server_mod._handoff_lock:
        server_mod._handoff_tickets.clear()
    yield
    with server_mod._handoff_lock:
        server_mod._handoff_tickets.clear()


def _client():
    return TestClient(server_mod.app)


def _web_login(client):
    response = client.post("/api/login", json={"username": "admin", "password": "admin"})
    assert response.status_code == 200
    return client.get("/api/session").json()["csrf_token"]


def _ticket(client, csrf):
    response = client.post("/api/desktop/handoff", headers={"X-JWS-CSRF": csrf})
    assert response.status_code == 200
    body = response.json()
    assert body["expires_in"] == 60
    return body["ticket"]


def test_handoff_requires_login():
    response = _client().post("/api/desktop/handoff")
    assert response.status_code == 401
    assert "ticket" not in response.json()


def test_handoff_rejects_missing_csrf():
    c = _client()
    _web_login(c)
    response = c.post("/api/desktop/handoff")  # 有会话但没带 X-JWS-CSRF
    assert response.status_code == 403
    assert "ticket" not in response.json()


def test_handoff_rejects_desktop_token_holder():
    """领票只开放给网页会话；桌面令牌不能再领票（防止令牌自我繁殖）。"""
    c = _client()
    login = c.post("/api/desktop/login", json={"username": "admin", "password": "admin"})
    assert login.status_code == 200
    bare = _client()
    response = bare.post(
        "/api/desktop/handoff", headers={"X-JWS-Token": login.json()["access_token"]}
    )
    assert response.status_code in {401, 403}
    assert "ticket" not in response.json()


def test_exchange_returns_usable_desktop_token():
    c = _client()
    csrf = _web_login(c)
    ticket = _ticket(c, csrf)
    exchange = _client().post("/api/desktop/handoff/exchange", json={"ticket": ticket})
    assert exchange.status_code == 200
    issued = exchange.json()
    assert issued["token_type"] == "x-jws-token"
    assert issued["openai_token_type"] == "bearer"
    assert issued["access_token"] != ticket
    # 拿换来的令牌走桌面通道调一个真实端点（无 cookie，纯 X-JWS-Token）
    desktop = _client()
    dashboard = desktop.get("/api/dashboard", headers={"X-JWS-Token": issued["access_token"]})
    assert dashboard.status_code == 200
    who = desktop.get("/api/session", headers={"X-JWS-Token": issued["access_token"]}).json()
    assert who["authed"] is True
    assert who["username"] == "admin"


def test_exchange_is_single_use():
    c = _client()
    csrf = _web_login(c)
    ticket = _ticket(c, csrf)
    first = _client().post("/api/desktop/handoff/exchange", json={"ticket": ticket})
    assert first.status_code == 200
    second = _client().post("/api/desktop/handoff/exchange", json={"ticket": ticket})
    assert second.status_code == 401
    assert "access_token" not in second.json()


def test_exchange_rejects_expired_ticket(monkeypatch):
    clock = {"now": 1_000_000.0}
    monkeypatch.setattr(server_mod, "_handoff_now", lambda: clock["now"])
    c = _client()
    csrf = _web_login(c)
    ticket = _ticket(c, csrf)
    clock["now"] += 61  # 越过 60 秒时效
    response = _client().post("/api/desktop/handoff/exchange", json={"ticket": ticket})
    assert response.status_code == 401
    assert "access_token" not in response.json()


def test_exchange_uniform_denial_and_no_password_path():
    """未知 / 重复 / 过期票据响应完全同构，不区分原因；端点不接受密码字段。"""
    unknown = _client().post("/api/desktop/handoff/exchange", json={"ticket": "x" * 43})
    assert unknown.status_code == 401
    c = _client()
    csrf = _web_login(c)
    ticket = _ticket(c, csrf)
    _client().post("/api/desktop/handoff/exchange", json={"ticket": ticket})
    reused = _client().post("/api/desktop/handoff/exchange", json={"ticket": ticket})
    assert reused.status_code == 401
    assert reused.json() == unknown.json()
    # 只带密码不带票据：请求体校验直接拒绝，永远走不到密码逻辑
    password_only = _client().post(
        "/api/desktop/handoff/exchange", json={"username": "admin", "password": "admin"}
    )
    assert password_only.status_code == 422


def test_tickets_and_tokens_never_logged(caplog):
    with caplog.at_level(logging.DEBUG):
        c = _client()
        csrf = _web_login(c)
        ticket = _ticket(c, csrf)
        exchange = _client().post("/api/desktop/handoff/exchange", json={"ticket": ticket})
        assert exchange.status_code == 200
        issued = exchange.json()
    assert ticket not in caplog.text
    assert issued["access_token"] not in caplog.text
    assert issued["openai_token"] not in caplog.text
    # 内存表里也只允许出现哈希，不允许出现明文票据
    with server_mod._handoff_lock:
        assert ticket not in server_mod._handoff_tickets
