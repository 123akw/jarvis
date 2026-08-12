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
