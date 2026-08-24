"""悬浮窗显隐偏好 + 桌面指令领取 + 会议工具 + tenant_meetings 迁移。"""
import sqlite3

import pytest
from fastapi.testclient import TestClient

import jarvis.meeting as meeting_mod
import jarvis.server as server_mod
from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantStore, tenant_scope


def _client():
    return TestClient(server_mod.app)


def _login(client):
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    return client.get("/api/session").json()["csrf_token"]


@pytest.fixture(autouse=True)
def _clean_boxes():
    meeting_mod.desktop_commands._items.clear()
    meeting_mod.active_meetings._active.clear()
    yield
    meeting_mod.desktop_commands._items.clear()
    meeting_mod.active_meetings._active.clear()


def test_desktop_settings_roundtrip_and_csrf():
    client = _client()
    csrf = _login(client)
    assert client.get("/api/desktop/settings").json() == {"ball_visible": True}, "默认显示"
    assert client.put("/api/desktop/settings", json={"ball_visible": False},
                      headers={"X-JWS-CSRF": csrf}).status_code == 200
    assert client.get("/api/desktop/settings").json() == {"ball_visible": False}
    assert client.put("/api/desktop/settings", json={"ball_visible": True}).status_code == 403, \
        "网页写偏好必须带 CSRF"
    assert client.get("/api/desktop/settings").json() == {"ball_visible": False}


def test_desktop_commands_drain_and_carry_ball_pref():
    client = _client()
    csrf = _login(client)
    client.put("/api/desktop/settings", json={"ball_visible": False},
               headers={"X-JWS-CSRF": csrf})
    owner = client.get("/api/session").json()["username"]
    assert owner == "admin"
    user_id = AccountStore().unique_active_owner().user_id
    meeting_mod.desktop_commands.put(user_id, {"command": "meeting-start", "title": "周会"})
    first = client.get("/api/desktop/commands").json()
    assert first["ball_visible"] is False
    assert first["commands"] == [{"command": "meeting-start", "title": "周会"}]
    assert client.get("/api/desktop/commands").json()["commands"] == [], "领取即清"
    assert TestClient(server_mod.app).get("/api/desktop/commands").status_code == 401


def test_meeting_tools_enqueue_desktop_commands():
    from jarvis.tools.meeting import meeting_start, meeting_stop
    store = AccountStore()
    owner = store.unique_active_owner()
    with tenant_scope(owner.user_id):
        reply = meeting_start.invoke({"title": "产品评审"})
        assert "桌面端" in reply
        stop_reply = meeting_stop.invoke({})
    commands = meeting_mod.desktop_commands.drain(owner.user_id)
    assert commands[0] == {"command": "meeting-start", "title": "产品评审"}
    assert commands[1] == {"command": "meeting-stop"}
    assert "没有正在监控" in stop_reply


def test_meeting_start_tool_refuses_duplicate():
    from jarvis.tools.meeting import meeting_start
    owner = AccountStore().unique_active_owner()
    assert meeting_mod.active_meetings.start(owner.user_id, "已有会议") is not None
    with tenant_scope(owner.user_id):
        reply = meeting_start.invoke({"title": "又一场"})
    assert "已经有一场" in reply
    assert meeting_mod.desktop_commands.drain(owner.user_id) == [], "重复开始不投指令"


def test_schema_v3_applies_to_existing_databases(isolated_data_dir):
    """存量库升级路径：版本门必须把 v3 建表带给已有数据库（v2 踩坑的回归）。"""
    AccountStore()  # 引导 users 表与 Owner
    store = TenantStore()
    owner = AccountStore().unique_active_owner()
    with tenant_scope(owner.user_id):
        store.migrate_legacy()
    db = isolated_data_dir / "accounts.sqlite3"
    with sqlite3.connect(db) as raw:
        # 模拟一台只跑过 v2 的旧机器：删掉 v3 的表和版本记录
        raw.execute("DROP TABLE tenant_meetings")
        raw.execute("DELETE FROM tenant_schema_migrations WHERE version=3")
        raw.commit()
    with tenant_scope(owner.user_id):
        record = TenantStore().add_meeting(
            title="升级验证", started_at="2026-08-24 10:00", ended_at="2026-08-24 10:30",
            transcript="[10:00:00] 我：测试", minutes="# 会议纪要")
        assert record["id"] == 1
        items = TenantStore().list_meetings()
    assert items[0]["title"] == "升级验证" and items[0]["has_minutes"]


def test_meeting_store_roundtrip_and_mailed_mark():
    AccountStore()
    owner = AccountStore().unique_active_owner()
    with tenant_scope(owner.user_id):
        store = TenantStore()
        store.migrate_legacy()
        record = store.add_meeting(
            title="周会", started_at="2026-08-24 09:00", ended_at="2026-08-24 09:45",
            transcript="[09:00:01] 对方：开始吧", minutes="")
        assert store.get_meeting(record["id"])["mailed_to"] == ""
        assert store.mark_meeting_mailed(record["id"], "1539598158@qq.com")
        detail = store.get_meeting(record["id"])
        assert detail["mailed_to"] == "1539598158@qq.com"
        assert store.list_meetings()[0]["has_minutes"] is False
        assert store.get_meeting(999) is None
