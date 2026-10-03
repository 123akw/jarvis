"""新手引导「看过没」：按账号存 tenant_prefs，GET 读、PUT 记一笔 / 重置；鉴权、CSRF、id 白名单、账号隔离。"""
import json

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis import onboarding
from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantStore, tenant_scope


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def test_requires_login_and_csrf(owner_id):
    anon = TestClient(server_mod.app)
    assert anon.get("/api/onboarding").status_code == 401
    assert anon.put("/api/onboarding", json={"tour": "market", "status": "done"}).status_code == 401
    c = _client()
    no_csrf = TestClient(server_mod.app)
    no_csrf.cookies = c.cookies
    assert no_csrf.put("/api/onboarding", json={"tour": "market", "status": "done"}).status_code == 403
    assert c.get("/api/onboarding").json() == {"seen": {}}             # 没记上


def test_record_read_and_overwrite(owner_id):
    c = _client()
    assert c.get("/api/onboarding").json() == {"seen": {}}
    r = c.put("/api/onboarding", json={"tour": "flows-editor", "status": "skipped"})
    assert r.status_code == 200 and r.json()["ok"] is True
    c.put("/api/onboarding", json={"tour": "app", "status": "done"})
    seen = c.get("/api/onboarding").json()["seen"]
    assert set(seen) == {"flows-editor", "app"}
    assert seen["flows-editor"]["status"] == "skipped" and seen["app"]["status"] == "done"
    assert seen["app"]["at"]                                            # 带时间
    c.put("/api/onboarding", json={"tour": "flows-editor", "status": "done"})
    assert c.get("/api/onboarding").json()["seen"]["flows-editor"]["status"] == "done"
    assert r.headers["cache-control"] == "no-store"


def test_reset_clears_everything(owner_id):
    c = _client()
    c.put("/api/onboarding", json={"tour": "market", "status": "done"})
    r = c.put("/api/onboarding", json={"reset": True})
    assert r.status_code == 200 and r.json() == {"ok": True, "seen": {}}
    assert c.get("/api/onboarding").json() == {"seen": {}}
    with tenant_scope(owner_id):
        assert TenantStore().get_pref(onboarding.PREF_KEY) is None    # 真删了，不是存个空对象


@pytest.mark.parametrize("payload", [
    {"tour": "Market", "status": "done"},          # 大写
    {"tour": "m", "status": "done"},               # 太短
    {"tour": "a" * 33, "status": "done"},          # 太长
    {"tour": "1app", "status": "done"},            # 数字开头
    {"tour": "app_home", "status": "done"},        # 下划线
    {"tour": "../x", "status": "done"},
    {"tour": "app", "status": "maybe"},            # 状态不对
    {"tour": "app"},                               # 没状态
    {"status": "done"},                            # 没 id
    {},
])
def test_rejects_bad_tour_or_status(owner_id, payload):
    c = _client()
    r = c.put("/api/onboarding", json=payload)
    assert r.status_code == 400 and r.json()["error"]
    assert c.get("/api/onboarding").json() == {"seen": {}}


def test_caps_at_fifty_tours(owner_id):
    c = _client()
    for i in range(onboarding.MAX_TOURS):
        assert c.put("/api/onboarding", json={"tour": f"t{i:02d}", "status": "done"}).status_code == 200
    r = c.put("/api/onboarding", json={"tour": "one-more", "status": "done"})
    assert r.status_code == 400 and "重置" in r.json()["error"]
    assert c.put("/api/onboarding", json={"tour": "t00", "status": "skipped"}).status_code == 200   # 改旧的照样行
    assert len(c.get("/api/onboarding").json()["seen"]) == onboarding.MAX_TOURS


def test_corrupt_pref_is_ignored(owner_id):
    with tenant_scope(owner_id):
        TenantStore().set_pref(onboarding.PREF_KEY, "{not json")
    c = _client()
    assert c.get("/api/onboarding").json() == {"seen": {}}
    with tenant_scope(owner_id):
        TenantStore().set_pref(onboarding.PREF_KEY, json.dumps({
            "app": {"status": "done", "at": "2026-10-03T00:00:00+00:00"},
            "BAD ID": {"status": "done"}, "market": {"status": "weird"}, "flows-home": "done",
        }))
    assert c.get("/api/onboarding").json() == {"seen": {"app": {"status": "done", "at": "2026-10-03T00:00:00+00:00"}}}
    c.put("/api/onboarding", json={"tour": "market", "status": "skipped"})   # 写回时顺带清掉脏条目
    assert set(c.get("/api/onboarding").json()["seen"]) == {"app", "market"}


def test_accounts_are_isolated(owner_id):
    AccountStore().create_user("member", "member", "Member")
    owner = _client()
    owner.put("/api/onboarding", json={"tour": "market", "status": "done"})
    member = _client("member", "member")
    assert member.get("/api/onboarding").json() == {"seen": {}}          # A 看过不等于 B 看过
    member.put("/api/onboarding", json={"tour": "app", "status": "skipped"})
    member.put("/api/onboarding", json={"reset": True})                  # B 重置不影响 A
    assert set(owner.get("/api/onboarding").json()["seen"]) == {"market"}
