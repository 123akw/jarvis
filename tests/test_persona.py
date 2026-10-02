"""人设工坊：称呼 / 语气偏好的存取与提示词注入；MOSS 人格已下线，旧数据按 J.A.R.V.I.S. 处理。"""
import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
import jarvis.prompts as prompts
from jarvis.prompts import SYSTEM_PROMPT, compose_system_prompt
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
    store.set_pref("persona_flavor", "回答末尾偶尔加一句冷幽默")
    composed = compose_system_prompt()
    assert composed.startswith(SYSTEM_PROMPT)
    assert "称呼用户为「陈总」" in composed
    assert "冷幽默" in composed


def test_legacy_moss_style_is_ignored_in_prompt():
    """旧数据里存着 moss 的账号：提示词不再注入任何 MOSS 人格，只保留称呼与语气。"""
    assert not hasattr(prompts, "PERSONA_MOSS")
    store = TenantStore()
    store.set_pref("persona_style", "moss")
    assert compose_system_prompt() == SYSTEM_PROMPT
    store.set_pref("persona_address", "陈总")
    composed = compose_system_prompt()
    assert "称呼用户为「陈总」" in composed
    assert "MOSS" not in composed


def test_persona_rest_roundtrip_and_validation():
    c = _authed_client()
    assert TestClient(server_mod.app).get("/api/persona").status_code == 401
    assert c.get("/api/persona").json() == {"style": "jarvis", "address": "", "flavor": ""}

    assert c.put("/api/persona", json={"style": "jarvis", "address": "陈总", "flavor": "多点冷幽默"}).status_code == 200
    assert c.get("/api/persona").json() == {"style": "jarvis", "address": "陈总", "flavor": "多点冷幽默"}

    # MOSS 已下线：PUT moss 返回 422 与一句人话，原有设置不被改动
    r = c.put("/api/persona", json={"style": "moss", "address": "张总", "flavor": ""})
    assert r.status_code == 422
    assert "MOSS" in r.json()["error"] and "下线" in r.json()["error"]
    assert c.get("/api/persona").json() == {"style": "jarvis", "address": "陈总", "flavor": "多点冷幽默"}
    assert c.put("/api/persona", json={"style": "gpt", "address": "", "flavor": ""}).status_code == 422
    # 清空：回到默认人设
    assert c.put("/api/persona", json={"style": "jarvis", "address": "", "flavor": ""}).status_code == 200
    assert c.get("/api/persona").json() == {"style": "jarvis", "address": "", "flavor": ""}


def test_persona_get_maps_legacy_moss_to_jarvis():
    """旧数据里存着 moss 的账号，读取时按 jarvis 返回；保存一次后落盘也变成 jarvis。"""
    c = _authed_client()
    store = TenantStore()   # autouse fixture 的租户就是登录的 admin
    store.set_pref("persona_style", "moss")
    store.set_pref("persona_address", "陈总")
    assert c.get("/api/persona").json() == {"style": "jarvis", "address": "陈总", "flavor": ""}
    # 只改称呼与语气（不传 style）也能保存
    assert c.put("/api/persona", json={"address": "王总", "flavor": ""}).status_code == 200
    assert c.get("/api/persona").json() == {"style": "jarvis", "address": "王总", "flavor": ""}
    assert store.get_pref("persona_style") == "jarvis"
