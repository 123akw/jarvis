"""飞书 Web 接口：鉴权、绑定码、解绑、状态，以及 lifespan 启停挂钩。"""
from fastapi.testclient import TestClient

import jarvis.server as server


def _login(username="admin", password="admin"):
    client = TestClient(server.app)
    assert client.post("/api/login", json={"username": username, "password": password}).status_code == 200
    return client, {"X-JWS-CSRF": client.get("/api/session").json()["csrf_token"]}


def test_feishu_endpoints_require_login_and_csrf():
    anonymous = TestClient(server.app)
    assert anonymous.get("/api/feishu/status").status_code == 401
    assert anonymous.post("/api/feishu/bind-code").status_code == 401
    assert anonymous.post("/api/feishu/unbind").status_code == 401

    client, _headers = _login()
    assert client.post("/api/feishu/bind-code").status_code == 403  # 缺 CSRF


def test_bind_code_from_api_is_redeemable_by_bridge_and_unbind_clears_it():
    client, headers = _login()
    issued = client.post("/api/feishu/bind-code", headers=headers)
    assert issued.status_code == 200 and issued.headers["cache-control"] == "no-store"
    payload = issued.json()
    assert payload["code"].isdigit() and len(payload["code"]) == 6 and payload["expires_in"] == 600
    assert payload["command"] == f"绑定 {payload['code']}"
    assert client.get("/api/feishu/status").json()["bound"] is False

    result, user_id = server.feishu.get_bridge().bindings.redeem(payload["code"], "ou_route")
    assert result == "ok" and user_id == server._accounts.unique_active_owner().user_id
    status = client.get("/api/feishu/status").json()
    assert status["bound"] is True and status["state"] == "disabled" and status["configured"] is False

    assert client.post("/api/feishu/unbind", headers=headers).json() == {"ok": True, "removed": 1}
    assert client.get("/api/feishu/status").json()["bound"] is False


def test_member_status_hides_connection_error_details(monkeypatch):
    server._accounts._ensure_bootstrap()
    assert server._accounts.create_user("feishu-member", "member", "Member")
    monkeypatch.setattr(server.feishu.get_bridge(), "status",
                        lambda: {"state": "error", "error": "code=10014 app secret invalid"})
    member, headers = _login("feishu-member", "member")
    assert member.get("/api/feishu/status").json()["error"] == ""
    owner, _ = _login()
    assert "10014" in owner.get("/api/feishu/status").json()["error"]
    # Member 也能为自己领码（每个人绑定自己的飞书账号）
    assert member.post("/api/feishu/bind-code", headers=headers).status_code == 200


def test_app_lifespan_starts_and_shuts_down_feishu(monkeypatch):
    calls = []
    monkeypatch.setattr(server.feishu, "start", lambda: calls.append("start"))
    monkeypatch.setattr(server.feishu, "shutdown", lambda: calls.append("shutdown"))
    with TestClient(server.app):
        assert calls == ["start"]
    assert calls == ["start", "shutdown"]
