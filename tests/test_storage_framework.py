"""存储层框架优化（2026-10-02 QA 轮）：连接及时关闭、账户库迁移检查每进程一次、审计表索引。"""
import gc
import sqlite3
import warnings

import pytest

from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantStore, tenant_scope


def _unclosed(caught):
    return [w for w in caught if issubclass(w.category, ResourceWarning) and "unclosed database" in str(w.message)]


def test_store_connections_are_closed_when_with_block_ends():
    """sqlite3 自带的 with 只提交/回滚、不关闭连接：此前每次读写都留一个待 GC 回收的连接
    （Python 3.13+ 每个都报 ResourceWarning: unclosed database；异常路径上引用环会让文件句柄
    拖到下一次 GC 才释放）。"""
    accounts = AccountStore()
    gc.collect()   # 先清掉其他用例遗留的连接（如 checkpointer），只统计本用例
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        accounts._ensure_bootstrap()
        owner = accounts.list_users()[0]["id"]
        accounts.principal_for_token("nope", "web")
        with tenant_scope(owner):
            store = TenantStore()
            store.add_todo("x")
            store.list_todos()
            store.set_pref("k", "v")
            store.get_pref("k")
        gc.collect()
    assert _unclosed(caught) == []


def test_account_migration_check_runs_once_per_process(monkeypatch):
    """每个已登录请求都会 principal_for_token → _connect：此前每次都在全进程锁里重跑 3 条
    迁移检查语句（TenantStore 早已缓存，AccountStore 漏了）。"""
    calls = []
    original = AccountStore._migrate

    def counting(connection):
        calls.append(1)
        return original(connection)

    monkeypatch.setattr(AccountStore, "_migrate", staticmethod(counting))
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    for _ in range(5):
        accounts.principal_for_token("nope", "web")
    assert len(calls) == 1


def test_account_migration_reruns_when_database_file_is_replaced(tmp_path):
    path = tmp_path / "acc.sqlite3"
    AccountStore(path).list_users()
    path.unlink()
    assert AccountStore(path).list_users() == []   # 新文件照样建表，不因缓存跳过迁移


def test_failed_migration_is_not_cached(tmp_path, monkeypatch):
    path = tmp_path / "acc.sqlite3"

    def broken(_connection):
        raise RuntimeError("disk full")

    monkeypatch.setattr(AccountStore, "_migrate", staticmethod(broken))
    with pytest.raises(RuntimeError):
        AccountStore(path).list_users()
    monkeypatch.undo()
    assert AccountStore(path).list_users() == []


def test_upload_rejects_oversize_before_decoding(monkeypatch):
    """实测：30MB 文本先整段 base64 解码（多占 ~22MB 内存）才报「超过 10MB」。按编码长度先拦。"""
    import base64
    from fastapi.testclient import TestClient
    import jarvis.server as server_mod

    AccountStore()._ensure_bootstrap()
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    decoded = []
    real = base64.b64decode
    monkeypatch.setattr(base64, "b64decode",   # CSRF 校验也会解码短令牌，只记大块
                        lambda s, *a, **k: (len(s) > 1_000_000 and decoded.append(1)) or real(s, *a, **k))
    r = c.post("/api/upload", json={"name": "a.txt", "content_b64": "QUFB" * (4 * 1024 * 1024)})
    assert r.status_code == 422 and "10MB" in r.json()["error"]
    assert decoded == []


def test_audit_trim_uses_created_at_index():
    """每次登录/失败登录都要按 created_at 排序裁剪审计表（上限 1 万行）：没有索引就是全表排序。"""
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    with sqlite3.connect(accounts.path or (__import__("jarvis.config").config.data_dir() / "accounts.sqlite3")) as db:
        plan = db.execute("EXPLAIN QUERY PLAN SELECT id FROM audit ORDER BY created_at DESC LIMIT -1 OFFSET 10000").fetchall()
    assert any("audit_created_at" in str(row) for row in plan), plan
