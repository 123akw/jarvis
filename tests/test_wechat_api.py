"""个人微信 Web API：鉴权、状态委托与应用生命周期。"""
from fastapi.testclient import TestClient

import jarvis.server as server


def _authed_client() -> tuple[TestClient, dict[str, str]]:
    client = TestClient(server.app)
    client.post("/api/login", json={"username": "admin", "password": "admin"})
    csrf = client.get("/api/session").json()["csrf_token"]
    return client, {"X-JWS-CSRF": csrf}


def test_wechat_endpoints_require_login():
    """防回归：未登录访问不得生成二维码、读状态或断开别人的桥。"""
    client = TestClient(server.app)

    assert client.get("/api/wechat/status").status_code == 401
    assert client.post("/api/wechat/connect").status_code == 401
    assert client.post("/api/wechat/disconnect").status_code == 401


def test_authenticated_wechat_endpoints_return_bridge_state(monkeypatch):
    """防回归：三条路由必须返回桥接状态，不能泄露其他对象。"""
    monkeypatch.setattr(server.wechat, "status", lambda: {"state": "idle"})
    monkeypatch.setattr(
        server.wechat,
        "connect",
        lambda: {"state": "waiting", "qr_uri": "data:image/svg+xml,qr"},
    )
    monkeypatch.setattr(server.wechat, "disconnect", lambda: {"state": "idle"})
    client, headers = _authed_client()

    assert client.get("/api/wechat/status", headers=headers).json() == {
        "state": "idle"
    }
    assert client.post("/api/wechat/connect", headers=headers).json() == {
        "state": "waiting",
        "qr_uri": "data:image/svg+xml,qr",
    }
    assert client.post("/api/wechat/disconnect", headers=headers).json() == {
        "state": "idle"
    }


def test_member_cannot_read_or_operate_owner_wechat_bridge(monkeypatch):
    server._accounts._ensure_bootstrap()
    assert server._accounts.create_user("wechat-member", "member", "Member")
    calls = []
    monkeypatch.setattr(server.wechat, "status", lambda: calls.append("status") or {"state": "waiting", "qr_uri": "secret"})
    monkeypatch.setattr(server.wechat, "connect", lambda: calls.append("connect") or {"state": "waiting"})
    monkeypatch.setattr(server.wechat, "disconnect", lambda: calls.append("disconnect") or {"state": "idle"})
    client = TestClient(server.app)
    assert client.post("/api/login", json={"username": "wechat-member", "password": "member"}).status_code == 200
    csrf = client.get("/api/session").json()["csrf_token"]
    assert client.get("/api/wechat/status").status_code == 403
    assert client.post("/api/wechat/connect", headers={"X-JWS-CSRF": csrf}).status_code == 403
    assert client.post("/api/wechat/disconnect", headers={"X-JWS-CSRF": csrf}).status_code == 403
    assert calls == []


def test_second_owner_cannot_operate_ambiguous_wechat_bridge(monkeypatch):
    server._accounts._ensure_bootstrap()
    assert server._accounts.create_user("wechat-owner-two", "owner", "Owner")
    calls = []
    monkeypatch.setattr(server.wechat, "status", lambda: calls.append("status") or {})
    monkeypatch.setattr(server.wechat, "connect", lambda: calls.append("connect") or {})
    monkeypatch.setattr(server.wechat, "disconnect", lambda: calls.append("disconnect") or {})
    client = TestClient(server.app)
    assert client.post("/api/login", json={"username": "wechat-owner-two", "password": "owner"}).status_code == 200
    csrf = client.get("/api/session").json()["csrf_token"]
    assert client.get("/api/wechat/status").status_code == 403
    assert client.post("/api/wechat/connect", headers={"X-JWS-CSRF": csrf}).status_code == 403
    assert client.post("/api/wechat/disconnect", headers={"X-JWS-CSRF": csrf}).status_code == 403
    assert calls == []


def test_app_lifespan_resumes_and_shuts_down_wechat(monkeypatch):
    """防回归：服务启动要恢复 Token，退出要停线程且保留凭据。"""
    calls = []
    monkeypatch.setattr(
        server.wechat, "resume_on_boot", lambda: calls.append("resume")
    )
    monkeypatch.setattr(server.wechat, "shutdown", lambda: calls.append("shutdown"))

    with TestClient(server.app):
        assert calls == ["resume"]

    assert calls == ["resume", "shutdown"]
