"""任务台写接口：待办勾选/新增/删除、备忘、日程的 REST 操作与鉴权。"""
import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
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


def test_panel_writes_require_login_and_csrf():
    anon = TestClient(server_mod.app)
    assert anon.post("/api/todos", json={"content": "x"}).status_code == 401
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    assert c.post("/api/todos", json={"content": "x"}).status_code == 403  # 缺 CSRF


def test_todo_add_check_uncheck_delete_roundtrip():
    c = _authed_client()
    created = c.post("/api/todos", json={"content": "  整理  会议材料 "}).json()
    assert created["ok"] is True
    tid = created["id"]
    assert [t["content"] for t in c.get("/api/dashboard").json()["todos"]] == ["整理 会议材料"]

    assert c.patch(f"/api/todos/{tid}", json={"done": True}).status_code == 200
    assert c.get("/api/dashboard").json()["todos"] == []          # 勾完从待办里消失
    assert c.patch(f"/api/todos/{tid}", json={"done": False}).status_code == 200
    assert len(c.get("/api/dashboard").json()["todos"]) == 1      # 可反悔取消勾选

    assert c.delete(f"/api/todos/{tid}").status_code == 200
    assert c.delete(f"/api/todos/{tid}").status_code == 404
    assert TenantStore().list_todos() == []


def test_memo_and_schedule_endpoints():
    c = _authed_client()
    mid = c.post("/api/memos", json={"content": "周三交电费"}).json()["id"]
    sid = c.post("/api/schedule", json={"title": "项目复盘", "when": "2026-08-20 15:00"}).json()["id"]
    d = c.get("/api/dashboard").json()
    assert [m["content"] for m in d["memos"]] == ["周三交电费"]
    assert [s["title"] for s in d["schedule"]] == ["项目复盘"]

    assert c.post("/api/schedule", json={"title": "坏时间", "when": "明天下午"}).status_code == 422
    assert c.post("/api/memos", json={"content": "   "}).status_code == 422

    assert c.delete(f"/api/memos/{mid}").status_code == 200
    assert c.delete(f"/api/schedule/{sid}").status_code == 200
    d = c.get("/api/dashboard").json()
    assert d["memos"] == [] and d["schedule"] == []


def test_panel_writes_are_tenant_isolated():
    """Member 勾不到 Owner 的待办：按租户隔离返回 404。"""
    c = _authed_client()
    tid = c.post("/api/todos", json={"content": "Owner 的事"}).json()["id"]

    AccountStore().create_user("member1", "Member-Pass-9", "Member")
    m = TestClient(server_mod.app)
    m.post("/api/login", json={"username": "member1", "password": "Member-Pass-9"})
    m.headers["X-JWS-CSRF"] = m.get("/api/session").json()["csrf_token"]
    assert m.patch(f"/api/todos/{tid}", json={"done": True}).status_code == 404
    assert m.delete(f"/api/todos/{tid}").status_code == 404
