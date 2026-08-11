"""桌面端状态同步与 coding_status 工具：确定性判定。"""
import jarvis.server as server_mod
from fastapi.testclient import TestClient
from jarvis.tools import coding_status


def _authed_client():
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    return c


def test_local_status_requires_login():
    assert TestClient(server_mod.app).post(
        "/api/local-status", json={"coding": []}).status_code == 401


def test_coding_status_without_sync():
    assert "还没同步" in coding_status.invoke({})


def test_sync_then_tool_reports():
    c = _authed_client()
    r = c.post("/api/local-status", json={"coding": [
        {"project": "JWS-Agent", "active": True,
         "last_active": "2026-08-11 10:00", "task": "增加监控桌面组件",
         "step": "Edit desktop/main.js", "files": ["main.js", "renderer.js"]},
        {"project": "blog", "active": False,
         "last_active": "2026-08-10 21:00", "task": "改样式"},
    ]})
    assert r.status_code == 200
    out = coding_status.invoke({})
    assert "JWS-Agent" in out and "🟢进行中" in out
    assert "blog" in out and "已暂停" in out
    assert "增加监控桌面组件" in out
    assert "当前动作：Edit desktop/main.js" in out
    assert "最近改动：main.js、renderer.js" in out


def test_sync_empty_reports_no_activity():
    c = _authed_client()
    c.post("/api/local-status", json={"coding": []})
    assert "没有 Claude Code 编程活动" in coding_status.invoke({})
