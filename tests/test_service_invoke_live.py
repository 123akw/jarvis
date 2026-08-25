"""服务线程一次性调用（成本泄漏修复）+ 会议实时要点。"""
import datetime

import pytest
from fastapi.testclient import TestClient

import jarvis.server as server_mod
import jarvis.voice.meeting_gateway as gateway_mod
from jarvis.voice.asr import ASRResult


class _RecordingAgent:
    """记录每次 invoke 的 config 与 checkpointer 删除调用。"""

    def __init__(self, text="好的。"):
        self.text = text
        self.configs = []
        deleted = self.deleted = []

        class _Saver:
            def delete_thread(self, thread_id):
                deleted.append(thread_id)
        self.checkpointer = _Saver()

    def invoke(self, state, config=None):
        self.configs.append(config)
        return {"messages": [type("M", (), {"content": self.text})()]}


class _Owner:
    def __init__(self, user_id):
        self.user_id = user_id


def _owner():
    from jarvis.accounts import AccountStore
    return AccountStore().unique_active_owner()


def test_service_invoke_uses_fresh_ephemeral_checkpoint_each_call():
    """heartbeat 等定时任务不得在同一 checkpoint 上无限累积历史（成本螺旋回归）。"""
    agent = _RecordingAgent()
    import unittest.mock as mock
    owner = _owner()
    with mock.patch.object(server_mod, "_get_agent", lambda: agent):
        first = server_mod._heartbeat_compose(_Owner(owner.user_id), "提醒我喝水", datetime.datetime.now())
        second = server_mod._heartbeat_compose(_Owner(owner.user_id), "提醒我喝水", datetime.datetime.now())
    assert first == "好的。" and second == "好的。"
    ids = [c["configurable"]["thread_id"] for c in agent.configs]
    assert len(ids) == 2 and ids[0] != ids[1], "每次调用必须是全新 checkpoint 上下文"
    base = ids[0].split("#")[0]
    assert ids[1].split("#")[0] == base, "一次性 id 以注册线程为前缀（保留归属关系）"
    assert agent.deleted == ids, "一次性上下文用完即删"
    # alias 线程仍照常注册（蒸馏排除与网页隐藏依赖它）
    from jarvis.tenancy import TenantStore, tenant_scope
    with tenant_scope(owner.user_id):
        assert TenantStore().get_thread("heartbeat") is not None


def test_service_invoke_survives_missing_delete_support():
    class _NoSaverAgent(_RecordingAgent):
        def __init__(self):
            super().__init__()
            self.checkpointer = object()   # 没有 delete_thread 的 checkpointer
    import unittest.mock as mock
    owner = _owner()
    with mock.patch.object(server_mod, "_get_agent", lambda: _NoSaverAgent()):
        assert server_mod._radio_compose(_Owner(owner.user_id)) == "好的。"


# ---------- 会中实时要点 ----------

class _FakeASR:
    async def connect(self):
        pass

    def __init__(self):
        import asyncio
        self._q = asyncio.Queue()

    async def send_audio(self, chunk):
        text = chunk.decode("utf-8", errors="ignore")
        if text.startswith("F:"):
            self._q.put_nowait(ASRResult(text=text[2:], is_final=True))

    async def results(self):
        while True:
            yield await self._q.get()

    async def finish(self):
        pass

    async def close(self):
        pass


def _login(client):
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    return client.get("/api/session").json()["csrf_token"], client.cookies[server_mod._COOKIE]


@pytest.fixture(autouse=True)
def _clean_meetings():
    import jarvis.meeting as meeting_mod
    meeting_mod.active_meetings._active.clear()
    yield
    meeting_mod.active_meetings._active.clear()


def test_meeting_live_points_streamed_with_throttle(monkeypatch):
    monkeypatch.setattr(server_mod, "_get_agent",
                        lambda: _RecordingAgent(text="· 首屏用动效\n· 九月第二周上线"))
    monkeypatch.setattr(gateway_mod, "create_asr_session", _FakeASR)
    monkeypatch.setattr(gateway_mod, "LIVE_MIN_SEGMENTS", 2)
    monkeypatch.setattr(gateway_mod, "LIVE_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(server_mod.mailer, "send_mail", lambda *a, **k: None)
    client = TestClient(server_mod.app)
    csrf, token = _login(client)
    with client.websocket_connect(
            "/api/meeting/stream", headers={"Cookie": f"{server_mod._COOKIE}={token}"}) as ws:
        ws.send_json({"type": "init", "csrf": csrf, "title": "评审"})
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(b"\x00" + "F:首屏用动效方案。".encode())
        assert ws.receive_json()["type"] == "segment"
        ws.send_bytes(b"\x01" + "F:九月第二周上线。".encode())
        assert ws.receive_json()["type"] == "segment"
        live = ws.receive_json()
        assert live["type"] == "live_points"
        assert "首屏用动效" in live["text"]
        ws.send_json({"type": "stop"})
        while ws.receive_json()["type"] != "stopped":
            pass


def test_meeting_live_points_pass_is_silent(monkeypatch):
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _RecordingAgent(text="PASS"))
    monkeypatch.setattr(gateway_mod, "create_asr_session", _FakeASR)
    monkeypatch.setattr(gateway_mod, "LIVE_MIN_SEGMENTS", 1)
    monkeypatch.setattr(gateway_mod, "LIVE_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(server_mod.mailer, "send_mail", lambda *a, **k: None)
    client = TestClient(server_mod.app)
    csrf, token = _login(client)
    with client.websocket_connect(
            "/api/meeting/stream", headers={"Cookie": f"{server_mod._COOKIE}={token}"}) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(b"\x00" + "F:嗯。".encode())
        assert ws.receive_json()["type"] == "segment"
        ws.send_json({"type": "ping"})
        event = ws.receive_json()
        assert event["type"] == "pong", "PASS 不得下发实时要点帧"
        ws.send_json({"type": "stop"})
        while ws.receive_json()["type"] != "stopped":
            pass
