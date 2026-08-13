"""工具层单元测试：不碰大模型，全部确定性判定。"""
import datetime
import sqlite3

import pytest

from jarvis.accounts import AccountStore
from jarvis.tenancy import tenant_scope
from jarvis.tools import now, memo_add, memo_list, memo_del, sys_query


@pytest.fixture
def owner_scope():
    """备忘工具已租户化：先引导 Owner 账号，再绑定其租户作用域。"""
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


# ---------- 时间 ----------

def test_now_contains_today():
    today = datetime.date.today().strftime("%Y-%m-%d")
    assert today in now.invoke({})


# ---------- 备忘 ----------

def test_memo_list_empty(owner_scope):
    assert "空" in memo_list.invoke({})


def test_memo_add_creates_file(isolated_data_dir, owner_scope):
    memo_add.invoke({"content": "周三交电费"})
    assert (isolated_data_dir / "accounts.sqlite3").exists()


def test_memo_add_returns_numbered_receipt(owner_scope):
    out = memo_add.invoke({"content": "买牛奶"})
    assert "编号" in out and "买牛奶" in out


def test_memo_add_then_list(owner_scope):
    memo_add.invoke({"content": "周三交电费"})
    assert "周三交电费" in memo_list.invoke({})


def test_memo_add_two_then_list_both(owner_scope):
    memo_add.invoke({"content": "第一件事"})
    memo_add.invoke({"content": "第二件事"})
    out = memo_list.invoke({})
    assert "第一件事" in out and "第二件事" in out


def test_memo_del_removes(owner_scope):
    receipt = memo_add.invoke({"content": "要被删掉的"})
    memo_id = int("".join(ch for ch in receipt.split("编号")[1] if ch.isdigit()))
    out = memo_del.invoke({"memo_id": memo_id})
    assert "已删除" in out
    assert "要被删掉的" not in memo_list.invoke({})


def test_memo_del_bad_id(owner_scope):
    assert "没找到" in memo_del.invoke({"memo_id": 9999})


def test_memo_persist_on_disk_as_json(isolated_data_dir, owner_scope):
    memo_add.invoke({"content": "落盘检查"})
    with sqlite3.connect(isolated_data_dir / "accounts.sqlite3") as c:
        rows = c.execute("SELECT content FROM tenant_memos").fetchall()
    assert any("落盘检查" in row[0] for row in rows)


# ---------- 白名单系统查询 ----------

def test_sys_query_date_runs():
    out = sys_query.invoke({"command": "date"})
    assert "拒绝" not in out and out.strip()


def test_sys_query_ls_runs():
    out = sys_query.invoke({"command": "ls"})
    assert "拒绝" not in out and out.strip()


def test_sys_query_rejects_rm():
    assert "拒绝" in sys_query.invoke({"command": "rm -rf /tmp/x"})


def test_sys_query_rejects_curl():
    assert "拒绝" in sys_query.invoke({"command": "curl http://example.com"})
