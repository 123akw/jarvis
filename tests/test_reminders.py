"""日程主动提醒：到点窗口、单通道只提醒一次、扫描线程与轮询端点。"""
import datetime

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
from jarvis.reminders import ReminderScanner, format_reminder, reminder_window
from jarvis.tenancy import TenantStore, tenant_scope

NOW = datetime.datetime(2026, 8, 14, 15, 0)


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


def _seed():
    store = TenantStore()
    store.add_schedule("已到点的会", "2026-08-14 14:55")
    store.add_schedule("还没到的会", "2026-08-14 16:00")
    store.add_schedule("过点太久的会", "2026-08-14 13:00")
    return store


def test_due_window_excludes_future_and_stale():
    store = _seed()
    floor, ceiling = reminder_window(NOW)
    due = store.due_reminders(floor=floor, ceiling=ceiling, channel="wechat")
    assert [d["title"] for d in due] == ["已到点的会"]


def test_mark_reminded_is_per_channel_and_once():
    store = _seed()
    floor, ceiling = reminder_window(NOW)
    item = store.due_reminders(floor=floor, ceiling=ceiling, channel="wechat")[0]
    store.mark_reminded(item["id"], item["when"], "wechat")
    assert store.due_reminders(floor=floor, ceiling=ceiling, channel="wechat") == []
    # 其他通道不受影响，各自只提醒一次
    assert len(store.due_reminders(floor=floor, ceiling=ceiling, channel="web")) == 1


def test_scanner_pushes_once_and_retries_on_failure():
    _seed()
    owner = AccountStore().unique_active_owner()
    pushed = []
    fail_first = {"n": 1}

    def push(text):
        if fail_first["n"]:
            fail_first["n"] -= 1
            return False          # 第一次推送失败：不得记账，下一轮要重试
        pushed.append(text)
        return True

    scanner = ReminderScanner(owner_getter=lambda: owner, push_wechat=push, now_fn=lambda: NOW)
    assert scanner.scan_once() == 0      # 失败轮
    assert scanner.scan_once() == 1      # 重试成功
    assert scanner.scan_once() == 0      # 已记账，不重复
    assert pushed == [format_reminder({"when": "2026-08-14 14:55", "title": "已到点的会"})]


def test_pending_endpoint_marks_per_transport(monkeypatch):
    _seed()

    class FrozenDT(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

    monkeypatch.setattr(server_mod.datetime, "datetime", FrozenDT)
    c = TestClient(server_mod.app)
    assert c.get("/api/reminders/pending").status_code == 401  # 未登录拒绝
    c.post("/api/login", json={"username": "admin", "password": "admin"})

    first = c.get("/api/reminders/pending").json()["items"]
    assert [x["title"] for x in first] == ["已到点的会"]
    assert c.get("/api/reminders/pending").json()["items"] == []  # web 通道只弹一次

    token = c.post("/api/desktop/login", json={"username": "admin", "password": "admin"}).json()["access_token"]
    d = TestClient(server_mod.app)
    d.headers["X-JWS-Token"] = token
    assert [x["title"] for x in d.get("/api/reminders/pending").json()["items"]] == ["已到点的会"]
    assert d.get("/api/reminders/pending").json()["items"] == []  # desktop 通道独立记账


def test_v2_migration_upgrades_existing_v1_database():
    """存量库升级路径：只打过 v1 的库重新连接后必须补建 v2 三张表（线上踩坑回归）。"""
    store = TenantStore()
    with store._connect() as c:  # 先造一个「旧库」：删掉 v2 记录与三张新表
        c.execute("DROP TABLE tenant_prefs")
        c.execute("DROP TABLE tenant_profile")
        c.execute("DROP TABLE tenant_reminders_sent")
        c.execute("DELETE FROM tenant_schema_migrations WHERE version=2")
        c.commit()
    # 任何一次重新连接都应触发 v2 迁移，三张表可用
    assert store.get_pref("nope") is None
    store.set_pref("tts_voice", "female-yujie")
    assert store.get_pref("tts_voice") == "female-yujie"
    assert store.list_profile() == []
    floor, ceiling = reminder_window(NOW)
    assert store.due_reminders(floor=floor, ceiling=ceiling, channel="wechat") == []
