"""长期记忆画像：工具、系统提示词注入与「记忆」面板 REST 接口。"""
import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
from jarvis.prompts import SYSTEM_PROMPT, compose_system_prompt
from jarvis.tenancy import tenant_scope
from jarvis.tools.profile import profile_forget, profile_list, profile_remember


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


def _authed_client():
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def test_profile_tools_roundtrip_and_dedup():
    assert "记住了" in profile_remember.invoke({"fact": "领导喝咖啡只喝美式"})
    assert "已经记着了" in profile_remember.invoke({"fact": "领导喝咖啡只喝美式"})  # 幂等
    listed = profile_list.invoke({})
    assert "领导喝咖啡只喝美式" in listed and listed.startswith("1.")
    assert "已忘记" in profile_forget.invoke({"profile_id": 1})
    assert "还没有记住" in profile_list.invoke({})


def test_compose_system_prompt_injects_profile():
    assert compose_system_prompt() == SYSTEM_PROMPT   # 无画像时保持原样
    profile_remember.invoke({"fact": "领导在深圳做后端开发"})
    composed = compose_system_prompt()
    assert composed.startswith(SYSTEM_PROMPT)
    assert "领导在深圳做后端开发" in composed
    assert "长期记忆画像" in composed


def test_compose_system_prompt_without_tenant_scope_is_safe():
    # 在租户上下文之外（如误用）也不崩：退回基础人设
    import jarvis.tenancy as tenancy_mod
    token = tenancy_mod._OWNER.set(None)
    try:
        assert compose_system_prompt() == SYSTEM_PROMPT
    finally:
        tenancy_mod._OWNER.reset(token)


def test_profile_rest_endpoints():
    c = _authed_client()
    assert TestClient(server_mod.app).get("/api/profile").status_code == 401
    pid = c.post("/api/profile", json={"content": "领导习惯晚上十一点后不接会议"}).json()["id"]
    items = c.get("/api/profile").json()["items"]
    assert [x["content"] for x in items] == ["领导习惯晚上十一点后不接会议"]
    assert c.delete(f"/api/profile/{pid}").status_code == 200
    assert c.get("/api/profile").json()["items"] == []
    assert c.delete(f"/api/profile/{pid}").status_code == 404
