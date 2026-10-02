"""口令策略与账户接口的人话报错（第十一轮）：建用户/改口令拒绝弱口令，已有账号登录不受影响；
sessions 表定期清理。"""
import datetime as dt
import sqlite3
import threading
import time

import pytest
from fastapi.testclient import TestClient

import jarvis.server as server_mod
from jarvis.accounts import (AccountError, AccountStore, SessionJanitor, password_is_weak,
                             password_policy_error, username_policy_error)

STRONG = "Str0ng-Pass-2026"


@pytest.fixture(autouse=True)
def fresh_limiters(monkeypatch):
    """限速器是模块级单例：每条用例换新的，免得和别的测试互相吃配额。"""
    monkeypatch.setattr(server_mod, "_login_limiter", server_mod.LoginAttemptLimiter())
    monkeypatch.setattr(server_mod, "_settings_limiter",
                        server_mod.LoginAttemptLimiter(attempts=10, spray_attempts=50, window_seconds=60))


def _owner_client() -> TestClient:
    """conftest 引导的 Owner 是 admin/admin——正是「已有弱口令账号」的现状。"""
    client = TestClient(server_mod.app)
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    return client


def _create(client, username, password, role="Member"):
    return client.post("/api/admin/users", json={"username": username, "password": password, "role": role})


# ---------- 规则本身 ----------

@pytest.mark.parametrize("password,needle", [
    ("short7!", "至少要 8 位"),
    ("password123", "太常见"),
    ("zhangsan2026", "用户名"),
    ("abababababab", "一两个字符"),
    ("13800138000", "纯数字"),
    ("x" * 300, "不能超过 256 位"),
])
def test_policy_explains_each_rejection_in_chinese(password, needle):
    reason = password_policy_error(password, "zhangsan")
    assert reason and needle in reason


def test_policy_accepts_reasonable_passwords_and_matches_weak_flag():
    for password in (STRONG, "correct horse battery", "Admin@2026"):
        assert password_policy_error(password, "admin") is None
        assert password_is_weak(password, "admin") is False
    # 同一套规则：策略拒绝的（除超长外）就是登录时会被标记为弱口令的
    assert password_is_weak("admin", "admin") is True


@pytest.mark.parametrize("username,needle", [("", "不能为空"), ("   ", "不能为空"),
                                             ("a" * 65, "64"), ("bad\nname", "控制字符")])
def test_username_policy(username, needle):
    assert needle in (username_policy_error(username) or "")


# ---------- 建用户 ----------

def test_create_user_rejects_weak_password_with_reason():
    client = _owner_client()
    for password, needle in (("1234567", "8 位"), ("password123", "太常见"), ("member1", "8 位")):
        response = _create(client, "member1", password)
        assert response.status_code == 400
        assert needle in response.json()["error"]
        assert response.headers["cache-control"] == "no-store"
    assert [u["username"] for u in AccountStore().list_users()] == ["admin"]


def test_create_user_duplicate_name_says_so():
    client = _owner_client()
    assert _create(client, "member1", STRONG).status_code == 201
    for name in ("member1", " MEMBER1 "):          # 用户名大小写不敏感、首尾空格会被去掉
        response = _create(client, name, STRONG)
        assert response.status_code == 409
        assert "已被占用" in response.json()["error"]
    assert "admin" in _create(client, "admin", STRONG).json()["error"]


def test_create_user_bad_role_and_bad_name():
    client = _owner_client()
    assert "角色" in _create(client, "member1", STRONG, role="Root").json()["error"]
    long_name = _create(client, "m" * 80, STRONG)
    assert long_name.status_code == 400 and "64" in long_name.json()["error"]


def test_created_user_with_strong_password_can_log_in():
    client = _owner_client()
    created = _create(client, "member1", STRONG)
    assert created.status_code == 201 and created.json()["username"] == "member1"
    member = TestClient(server_mod.app)
    assert member.post("/api/login", json={"username": "member1", "password": STRONG}).status_code == 200
    assert member.get("/api/session").json()["password_weak"] is False


# ---------- Owner 修改用户 ----------

def test_owner_reset_password_is_checked_against_target_username():
    client = _owner_client()
    user_id = _create(client, "lisi", STRONG).json()["id"]
    weak = client.patch(f"/api/admin/users/{user_id}", json={"password": "lisi2026"})
    assert weak.status_code == 400 and "用户名" in weak.json()["error"]
    # 同时改名时按新用户名判
    renamed = client.patch(f"/api/admin/users/{user_id}", json={"username": "wangwu", "password": "wangwu123"})
    assert renamed.status_code == 400 and "用户名" in renamed.json()["error"]
    assert client.patch(f"/api/admin/users/{user_id}", json={"password": "Another-Pass-77"}).status_code == 200


def test_owner_update_errors_are_specific():
    client = _owner_client()
    user_id = _create(client, "lisi", STRONG).json()["id"]
    taken = client.patch(f"/api/admin/users/{user_id}", json={"username": "ADMIN"})
    assert taken.status_code == 409 and "已被占用" in taken.json()["error"]
    missing = client.patch("/api/admin/users/no-such-user", json={"role": "Member"})
    assert missing.status_code == 404 and "不存在" in missing.json()["error"]
    empty = client.patch(f"/api/admin/users/{user_id}", json={})
    assert empty.status_code == 400 and "没有要修改" in empty.json()["error"]
    owner_id = next(u["id"] for u in AccountStore().list_users() if u["username"] == "admin")
    last_owner = client.patch(f"/api/admin/users/{owner_id}", json={"active": False})
    assert last_owner.status_code == 409 and "Owner" in last_owner.json()["error"]


# ---------- 本人改口令 ----------

def test_change_password_reasons():
    client = _owner_client()
    url = "/api/account/password"
    weak = client.post(url, json={"current_password": "admin", "new_password": "admin123"})
    assert weak.status_code == 400 and "太常见" in weak.json()["error"]
    wrong = client.post(url, json={"current_password": "not-admin", "new_password": STRONG})
    assert wrong.status_code == 400 and wrong.json()["error"] == "当前口令不对"
    ok = client.post(url, json={"current_password": "admin", "new_password": STRONG})
    assert ok.status_code == 200
    # 改完旧会话全部作废；用新口令登录后，「新旧相同」也要说清楚
    again = TestClient(server_mod.app)
    assert again.post("/api/login", json={"username": "admin", "password": STRONG}).status_code == 200
    again.headers["X-JWS-CSRF"] = again.get("/api/session").json()["csrf_token"]
    same = again.post(url, json={"current_password": STRONG, "new_password": STRONG})
    assert same.status_code == 400 and "相同" in same.json()["error"]


def test_change_password_guessing_is_rate_limited():
    client = _owner_client()
    statuses = [client.post("/api/account/password",
                            json={"current_password": f"guess-{i}", "new_password": STRONG}).status_code
                for i in range(12)]
    assert statuses[:10] == [400] * 10 and statuses[10:] == [429, 429]


def test_existing_weak_account_still_logs_in_and_is_only_flagged():
    """策略只管新口令：admin/admin 这类存量账号照常登录（网页与桌面），只亮弱口令提示。"""
    web = TestClient(server_mod.app)
    assert web.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    assert web.get("/api/session").json()["password_weak"] is True
    desktop = TestClient(server_mod.app)
    assert desktop.post("/api/desktop/login", json={"username": "admin", "password": "admin"}).status_code == 200


def test_store_level_legacy_methods_keep_old_contract():
    """内部/夹具用的旧接口不套策略、失败回 None/False；HTTP 入口走 *_checked。"""
    store = AccountStore()
    store._ensure_bootstrap()
    assert store.create_user("fixture", "pw", "Member")
    assert store.create_user("fixture", "pw", "Member") is None
    with pytest.raises(AccountError) as error:
        store.create_user_checked("fixture", STRONG, "Member")
    assert error.value.status == 409


# ---------- sessions 表清理 ----------

def _age_session(store: AccountStore, session_id: str, *, expires_at=None, revoked_at=None):
    with store._connect() as db:
        if expires_at is not None:
            db.execute("UPDATE sessions SET expires_at = ? WHERE id = ?", (expires_at, session_id))
        if revoked_at is not None:
            db.execute("UPDATE sessions SET revoked_at = ? WHERE id = ?", (revoked_at, session_id))


def _session_ids(store: AccountStore) -> set[str]:
    with store._connect() as connection:
        return {row["id"] for row in connection.execute("SELECT id FROM sessions")}


def test_purge_removes_only_dead_sessions():
    store = AccountStore()
    store._ensure_bootstrap()
    owner_id = store.list_users()[0]["id"]
    now = dt.datetime.now(dt.timezone.utc)
    (active, active_token) = store.issue_session(owner_id, "web")
    (expired, _) = store.issue_session(owner_id, "desktop")
    (old_revoked, _) = store.issue_session(owner_id, "web")
    (fresh_revoked, _) = store.issue_session(owner_id, "web")
    _age_session(store, expired.session_id, expires_at=(now - dt.timedelta(minutes=1)).isoformat())
    _age_session(store, old_revoked.session_id, revoked_at=(now - dt.timedelta(days=8)).isoformat())
    _age_session(store, fresh_revoked.session_id, revoked_at=(now - dt.timedelta(hours=1)).isoformat())

    assert store.purge_sessions() == 2
    assert _session_ids(store) == {active.session_id, fresh_revoked.session_id}
    assert store.principal_for_token(active_token, "web") is not None   # 活跃会话不受影响
    assert store.purge_sessions() == 0                                   # 幂等


def test_janitor_runs_first_pass_soon_after_start(monkeypatch):
    store = AccountStore()
    store._ensure_bootstrap()
    owner_id = store.list_users()[0]["id"]
    (expired, _) = store.issue_session(owner_id, "web")
    _age_session(store, expired.session_id, expires_at="2000-01-01T00:00:00+00:00")
    janitor = SessionJanitor(store, interval=3600)
    monkeypatch.setattr(janitor, "first_delay", 0.01)
    rounds = threading.Event()
    original = janitor.scan_once
    monkeypatch.setattr(janitor, "scan_once", lambda: (original(), rounds.set())[0])
    janitor.start()
    try:
        assert rounds.wait(3), "首轮应在 first_delay 后执行，而不是等满 6 小时"
    finally:
        janitor.stop()
    assert expired.session_id not in _session_ids(store)


def test_janitor_failure_is_contained():
    class BrokenStore:
        def purge_sessions(self):
            raise sqlite3.OperationalError("database is locked")

    janitor = SessionJanitor(BrokenStore(), interval=0.01)
    janitor.first_delay = 0.0
    janitor.start()
    time.sleep(0.1)
    alive = janitor._thread is not None and janitor._thread.is_alive()
    janitor.stop()
    assert alive


def test_lifespan_starts_and_stops_session_janitor(monkeypatch):
    monkeypatch.setenv("JARVIS_REMINDERS_ENABLED", "0")
    monkeypatch.setenv("JARVIS_HEARTBEAT_ENABLED", "0")
    monkeypatch.setenv("JARVIS_WEAK_PASSWORD_SCAN", "0")
    with TestClient(server_mod.app):
        names = {t.name for t in threading.enumerate()}
        assert SessionJanitor.thread_name in names
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and any(
            t.name == SessionJanitor.thread_name and t.is_alive() for t in threading.enumerate()):
        time.sleep(0.02)
    assert not any(t.name == SessionJanitor.thread_name and t.is_alive() for t in threading.enumerate())
