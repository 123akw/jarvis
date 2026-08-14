"""人设工坊：称呼 / MOSS 人格切换 / 语气偏好的存取与提示词注入。"""
import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
from jarvis.prompts import PERSONA_MOSS, SYSTEM_PROMPT, compose_system_prompt
from jarvis.tenancy import TenantStore, tenant_scope


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


def test_compose_prompt_applies_persona_overrides():
    assert compose_system_prompt() == SYSTEM_PROMPT   # 默认零覆写
    store = TenantStore()
    store.set_pref("persona_address", "陈总")
    store.set_pref("persona_style", "moss")
    store.set_pref("persona_flavor", "回答末尾偶尔加一句冷幽默")
    composed = compose_system_prompt()
    assert composed.startswith(SYSTEM_PROMPT)
    assert "称呼用户为「陈总」" in composed
    assert PERSONA_MOSS in composed
    assert "冷幽默" in composed


def test_persona_rest_roundtrip_and_validation():
    c = _authed_client()
    assert TestClient(server_mod.app).get("/api/persona").status_code == 401
    assert c.get("/api/persona").json() == {"style": "jarvis", "address": "", "flavor": ""}

    assert c.put("/api/persona", json={"style": "moss", "address": "陈总", "flavor": "多点冷幽默"}).status_code == 200
    assert c.get("/api/persona").json() == {"style": "moss", "address": "陈总", "flavor": "多点冷幽默"}

    assert c.put("/api/persona", json={"style": "gpt", "address": "", "flavor": ""}).status_code == 422
    # 清空：回到默认人设
    assert c.put("/api/persona", json={"style": "jarvis", "address": "", "flavor": ""}).status_code == 200
    assert c.get("/api/persona").json() == {"style": "jarvis", "address": "", "flavor": ""}
