"""会话管理接口测试：确定性判定，不碰大模型。"""
import jarvis.server as server_mod
from fastapi.testclient import TestClient


def _authed_client():
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    return c


def test_threads_requires_login():
    assert TestClient(server_mod.app).get("/api/threads").status_code == 401


def test_history_requires_login():
    assert TestClient(server_mod.app).get(
        "/api/history", params={"thread_id": "x"}).status_code == 401


def test_threads_empty_initially():
    assert _authed_client().get("/api/threads").json() == []


def test_upsert_creates_with_title_and_sorts():
    server_mod._upsert_thread("t1", "帮我查一下明天深圳的天气怎么样啊到底")
    server_mod._upsert_thread("t2", "第二个话题")
    out = _authed_client().get("/api/threads").json()
    assert [t["id"] for t in out] == ["t2", "t1"]
    assert out[1]["title"] == "帮我查一下明天深圳的天气怎么样啊到底"[:24]


def test_upsert_same_thread_keeps_title():
    server_mod._upsert_thread("t1", "最初的标题")
    server_mod._upsert_thread("t1", "后来的消息不该改标题")
    out = _authed_client().get("/api/threads").json()
    assert len(out) == 1 and out[0]["title"] == "最初的标题"


def test_delete_thread_removes_meta():
    server_mod._upsert_thread("t1", "要删的")
    server_mod._upsert_thread("t2", "留下的")
    c = _authed_client()
    assert c.delete("/api/thread", params={"thread_id": "t1"}).status_code == 200
    assert [t["id"] for t in c.get("/api/threads").json()] == ["t2"]
