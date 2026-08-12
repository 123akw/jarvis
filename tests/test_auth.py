"""登录体系测试：不碰大模型，全部确定性判定。"""
import jarvis.server as server_mod
from fastapi.testclient import TestClient


def _client():
    return TestClient(server_mod.app)


def _login(client):
    response = client.post("/api/login", json={"username": "admin", "password": "admin"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    return client.get("/api/session").json()["csrf_token"]


def _desktop_token(client):
    response = client.post("/api/desktop/login", json={"username": "admin", "password": "admin"})
    assert response.status_code == 200
    return response.json()["access_token"]


def test_dashboard_requires_login():
    assert _client().get("/api/dashboard").status_code == 401


def test_chat_requires_login():
    resp = _client().post("/api/chat", json={"message": "你好"})
    assert resp.status_code == 401


def test_login_wrong_password_rejected(monkeypatch):
    monkeypatch.setattr(server_mod.time, "sleep", lambda s: None)
    resp = _client().post("/api/login", json={"username": "admin", "password": "wrong"})
    assert resp.status_code == 401


def test_login_ok_sets_cookie_and_grants_access():
    c = _client()
    _login(c)
    assert server_mod._COOKIE in c.cookies
    assert c.get("/api/dashboard").status_code == 200
    assert c.get("/api/session").json()["authed"] is True


def test_logout_revokes_session():
    c = _client()
    csrf = _login(c)
    assert c.get("/api/dashboard").status_code == 200
    c.post("/api/logout", headers={"X-JWS-CSRF": csrf})
    assert c.get("/api/dashboard").status_code == 401


def test_forged_cookie_rejected():
    c = _client()
    c.cookies.set(server_mod._COOKIE, "f" * 64)
    assert c.get("/api/dashboard").status_code == 401


def test_header_token_grants_access():
    c = _client()
    token = _desktop_token(c)
    c2 = _client()  # 无 cookie，仅带 bearer（桌面悬浮窗场景）
    assert c2.get("/api/dashboard", headers={"X-JWS-Token": token}).status_code == 200


def test_forged_header_token_rejected():
    c = _client()
    assert c.get("/api/dashboard", headers={"Authorization": f"Bearer {'f' * 64}"}).status_code == 401


def test_session_survives_restart_same_secret():
    c1 = _client()
    _login(c1)
    token = c1.cookies[server_mod._COOKIE]
    c2 = _client()  # 模拟服务重启后的新进程：SQLite 会话仍有效
    c2.cookies.set(server_mod._COOKIE, token)
    assert c2.get("/api/dashboard").status_code == 200
