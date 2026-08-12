"""Tenant storage contracts: no request supplied owner can cross this boundary."""
from concurrent.futures import ThreadPoolExecutor
import json
import os

import pytest

from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantMigrationError, TenantScopeError, TenantStore, tenant_scope
import jarvis.server as server
import jarvis.cli as cli
from jarvis import wechat
from jarvis.tools import memo_add, memo_list, schedule_add, schedule_list, todo_add, todo_list
import importlib
from fastapi.testclient import TestClient


def _users(tmp_path):
    accounts = AccountStore(tmp_path / "accounts.sqlite3")
    accounts._ensure_bootstrap()
    owner = accounts.list_users()[0]
    member = accounts.create_user("member", "member", "Member")
    assert member is not None
    return owner["id"], member["id"]


def test_tenant_scope_is_explicit_and_context_safe(tmp_path):
    owner, member = _users(tmp_path)
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    with pytest.raises(TenantScopeError):
        store.add_memo("no default owner")

    def add(owner_id, text):
        with tenant_scope(owner_id):
            return store.add_memo(text)["id"], store.list_memos()

    with ThreadPoolExecutor(max_workers=2) as pool:
        left, right = list(pool.map(lambda item: add(*item), [(owner, "owner only"), (member, "member only")]))
    assert left[0] == right[0] == 1
    assert left[1] == [{"id": 1, "content": "owner only"}]
    assert right[1] == [{"id": 1, "content": "member only"}]


def test_same_owner_concurrent_ids_are_serialized(tmp_path):
    owner, _member = _users(tmp_path)
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    def add(index):
        with tenant_scope(owner):
            return store.add_memo(f"memo-{index}")["id"]
    with ThreadPoolExecutor(max_workers=8) as pool:
        ids = list(pool.map(add, range(16)))
    assert sorted(ids) == list(range(1, 17))


def test_same_owner_concurrent_alias_upsert_is_atomic(tmp_path):
    owner, member = _users(tmp_path)
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)

    def upsert(index):
        with tenant_scope(owner):
            return store.upsert_thread("same-alias", f"title-{index}").checkpoint_thread_id

    with ThreadPoolExecutor(max_workers=16) as pool:
        checkpoints = list(pool.map(upsert, range(32)))
    assert len(set(checkpoints)) == 1
    with tenant_scope(member):
        assert store.upsert_thread("same-alias", "member").checkpoint_thread_id != checkpoints[0]


def test_same_alias_has_distinct_checkpoint_and_owner_only_delete(tmp_path):
    owner, member = _users(tmp_path)
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    with tenant_scope(owner):
        a = store.upsert_thread("same", "owner title")
    with tenant_scope(member):
        b = store.upsert_thread("same", "member title")
        assert store.get_thread("same").checkpoint_thread_id == b.checkpoint_thread_id
        assert store.delete_thread("same").checkpoint_thread_id == b.checkpoint_thread_id
    with tenant_scope(owner):
        assert store.get_thread("same").checkpoint_thread_id == a.checkpoint_thread_id
        assert store.delete_thread("missing") is None
    assert a.checkpoint_thread_id != b.checkpoint_thread_id


def test_personal_rows_are_scoped_for_all_four_tools(tmp_path):
    owner, member = _users(tmp_path)
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    with tenant_scope(owner):
        store.add_memo("o")
        store.add_todo("o")
        store.add_schedule("o", "2026-08-12 09:00")
        store.set_location(1.0, 2.0, "o", "owner place")
    with tenant_scope(member):
        assert store.list_memos() == [] and store.list_todos() == [] and store.list_schedule() == []
        assert store.get_location() is None
        store.add_memo("m")
    with tenant_scope(owner):
        assert [x["content"] for x in store.list_memos()] == ["o"]


def test_actual_personal_tools_require_scope_and_do_not_cross(tmp_path, monkeypatch):
    owner, member = _users(tmp_path)
    location = importlib.import_module("jarvis.tools.location")
    monkeypatch.setattr(location, "_reverse_geocode", lambda *_: "place")
    with pytest.raises(TenantScopeError):
        memo_add.invoke({"content": "closed"})
    with tenant_scope(owner):
        assert "owner memo" in memo_add.invoke({"content": "owner memo"})
        todo_add.invoke({"content": "owner todo"})
        schedule_add.invoke({"title": "owner event", "when": "2026-08-12 09:00"})
        location.set_location(1, 2, "owner")
    with tenant_scope(member):
        assert "空" in memo_list.invoke({}) and "空" in todo_list.invoke({}) and "空" in schedule_list.invoke({})
        assert location.get_location() is None


def test_legacy_json_backup_and_retry_are_atomic(tmp_path, monkeypatch):
    owner, _member = _users(tmp_path)
    legacy = {
        "threads.json": [{"id": "legacy", "title": "old thread", "updated": "2026-01-01"}],
        "memos.json": [{"id": 7, "content": "old"}],
        "todos.json": [{"id": 2, "content": "todo", "done": False}],
        "schedule.json": [{"id": 3, "title": "meeting", "when": "2026-08-12 09:00"}],
        "location.json": {"lat": 1, "lon": 2, "place": "old place", "source": "old", "updated": "2026-01-01"},
        "local_status.json": {"coding": [], "updated": "2026-01-01"},
    }
    for name, payload in legacy.items():
        (tmp_path / name).write_text(json.dumps(payload), encoding="utf-8")
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    original = store._import_legacy
    monkeypatch.setattr(store, "_import_legacy", lambda *_args: (_ for _ in ()).throw(RuntimeError("interrupted")))
    with pytest.raises(RuntimeError):
        store.migrate_legacy()
    assert (tmp_path / "memos.json").exists()
    for name in legacy:
        assert (tmp_path / f"{name}.tenant-v1.bak").stat().st_mode & 0o777 == 0o600
    with tenant_scope(owner):
        assert store.list_memos() == []
    monkeypatch.setattr(store, "_import_legacy", original)
    assert store.migrate_legacy() is True
    assert store.migrate_legacy() is False
    with tenant_scope(owner):
        assert store.list_memos() == [{"id": 7, "content": "old"}]
        assert store.get_thread("legacy").checkpoint_thread_id == "legacy"


def test_malformed_legacy_never_marks_completion_or_partially_imports(tmp_path):
    owner, _member = _users(tmp_path)
    (tmp_path / "memos.json").write_text("{bad", encoding="utf-8")
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    with pytest.raises(TenantMigrationError):
        store.migrate_legacy()
    with tenant_scope(owner):
        assert store.list_memos() == []


def test_completed_migration_does_not_block_after_second_owner(tmp_path):
    owner, _member = _users(tmp_path)
    (tmp_path / "memos.json").write_text(json.dumps([{"id": 1, "content": "old"}]), encoding="utf-8")
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    assert store.migrate_legacy() is True
    assert AccountStore(tmp_path / "accounts.sqlite3").create_user("second-owner", "pw", "Owner")
    assert store.migrate_legacy() is False


def test_empty_legacy_directory_is_not_marked_and_can_migrate_later(tmp_path):
    owner, _member = _users(tmp_path)
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    assert store.migrate_legacy() is False
    (tmp_path / "memos.json").write_text(json.dumps([{"id": 1, "content": "later"}]), encoding="utf-8")
    assert store.migrate_legacy() is True
    with tenant_scope(owner):
        assert store.list_memos() == [{"id": 1, "content": "later"}]


def test_completed_marker_precedes_legacy_file_read(tmp_path):
    _owner, _member = _users(tmp_path)
    store = TenantStore(tmp_path / "accounts.sqlite3", legacy_dir=tmp_path)
    (tmp_path / "memos.json").write_text(json.dumps([{"id": 1, "content": "ok"}]), encoding="utf-8")
    assert store.migrate_legacy() is True
    (tmp_path / "memos.json").write_text("{broken", encoding="utf-8")
    assert store.migrate_legacy() is False


def test_schema_creation_failure_rolls_back(tmp_path, monkeypatch):
    accounts = AccountStore(tmp_path / "accounts.sqlite3")
    accounts._ensure_bootstrap()
    statements = list(TenantStore._schema_statements())
    monkeypatch.setattr(TenantStore, "_schema_statements", staticmethod(lambda: tuple([statements[0], "NOT SQL"])))
    with pytest.raises(Exception):
        TenantStore(tmp_path / "accounts.sqlite3")._connect()
    import sqlite3
    with sqlite3.connect(tmp_path / "accounts.sqlite3") as connection:
        assert not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tenant_legacy_migrations'").fetchone()


class _State:
    values = {"messages": []}


class _Checkpoint:
    def __init__(self): self.deleted = []
    def delete_thread(self, thread_id): self.deleted.append(thread_id)


class _Agent:
    def __init__(self): self.checkpointer = _Checkpoint(); self.history_ids = []
    def get_state(self, config): self.history_ids.append(config["configurable"]["thread_id"]); return _State()
    def invoke(self, _state, config): self.history_ids.append(config["configurable"]["thread_id"]); return {"messages": [type("M", (), {"content": "ok"})()]}


def _desktop(username, password):
    return TestClient(server.app).post("/api/desktop/login", json={"username": username, "password": password}).json()


def test_http_desktop_and_openai_principals_cannot_cross_alias(monkeypatch):
    accounts = server._accounts
    accounts._ensure_bootstrap()
    member = accounts.create_user("member-http", "member", "Member")
    assert member
    owner_token = _desktop("admin", "admin")
    member_token = _desktop("member-http", "member")
    owner = accounts.principal_for_token(owner_token["access_token"], "desktop")
    member_principal = accounts.principal_for_token(member_token["access_token"], "desktop")
    assert owner and member_principal
    with tenant_scope(owner.user_id):
        mine = TenantStore(); mine.migrate_legacy(); own_thread = mine.upsert_thread("same", "owner")
        mine.upsert_thread("owner-only", "private")
    with tenant_scope(member_principal.user_id):
        theirs = TenantStore().upsert_thread("same", "member")
    fake = _Agent(); monkeypatch.setattr(server, "_get_agent", lambda: fake)
    c = TestClient(server.app)
    headers = {"X-JWS-Token": member_token["access_token"]}
    assert c.get("/api/threads", headers=headers).json()[0]["title"] == "member"
    assert c.get("/api/history", headers=headers, params={"thread_id": "same"}).status_code == 200
    assert c.get("/api/history", headers=headers, params={"thread_id": "owner-only"}).status_code == 404
    assert fake.history_ids[-1] == theirs.checkpoint_thread_id
    assert c.delete("/api/thread", headers=headers, params={"thread_id": "missing"}).status_code == 404
    assert c.delete("/api/thread", headers=headers, params={"thread_id": "same"}).status_code == 200
    with tenant_scope(owner.user_id):
        assert TenantStore().get_thread("same").checkpoint_thread_id == own_thread.checkpoint_thread_id
    r = c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {owner_token['openai_token']}", "X-Thread-ID": "same"}, json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200
    assert fake.history_ids[-1] == own_thread.checkpoint_thread_id


def test_web_cookie_principal_and_fixed_owner_transports(tmp_path, monkeypatch):
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    assert accounts.create_user("member-cookie", "member", "Member")
    owner = accounts.list_users()[0]
    with tenant_scope(owner["id"]):
        TenantStore().migrate_legacy(); TenantStore().upsert_thread("web-only", "owner")
    web = TestClient(server.app)
    assert web.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    assert [row["id"] for row in web.get("/api/threads").json()] == ["web-only"]

    class FakeAgent:
        def invoke(self, _state, config): return {"messages": [type("M", (), {"content": "ok"})()]}
    assert "账号未就绪" in wechat.WeChatBridge(agent_getter=lambda: FakeAgent(), chunk_text=str, owner_getter=lambda: None)._reply("hi", "person")
    assert accounts.create_user("second-cli-owner", "owner", "Owner")
    with pytest.raises(RuntimeError):
        cli.chat(FakeAgent(), "hi", "cli")
