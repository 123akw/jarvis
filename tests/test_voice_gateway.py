"""语音网关 /api/voice/call 测试：agent 与 TTS 全部打桩，不联网。"""
import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessageChunk
from starlette.websockets import WebSocketDisconnect

import jarvis.server as server_mod
import jarvis.voice.gateway as gateway_mod
from jarvis.voice.tts import TTSError


class _FakeAgent:
    """把固定文案按块吐出来的假 agent；stream_mode=messages 形状。"""

    def __init__(self, pieces=("你好，", "领导。", "马上办。"), delay=0.0):
        self.pieces = pieces
        self.delay = delay

    def stream(self, _state, config=None, stream_mode=None):
        for piece in self.pieces:
            if self.delay:
                time.sleep(self.delay)
            yield AIMessageChunk(content=piece), {}


class _FakeTTS:
    """走完整协议形状的假 TTS：speak 一句给一块音频。"""

    instances = []

    def __init__(self):
        self.audio_format = "pcm"
        self.sample_rate = 24000
        self.spoken = []
        self.closed = False
        self._q = asyncio.Queue()
        _FakeTTS.instances.append(self)

    async def connect(self):
        pass

    async def speak(self, text):
        self.spoken.append(text)
        self._q.put_nowait(b"\x01\x02\x03\x04")

    async def finish(self):
        self._q.put_nowait(None)

    async def audio_chunks(self):
        while True:
            item = await self._q.get()
            if item is None:
                return
            yield item

    async def close(self):
        self.closed = True


class _BrokenTTS(_FakeTTS):
    async def connect(self):
        raise TTSError("语音合成连接失败")


def _client():
    return TestClient(server_mod.app)


def _login(client):
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    session = client.get("/api/session").json()
    return session["csrf_token"], client.cookies[server_mod._COOKIE]


def _connect(client, token):
    return client.websocket_connect(
        "/api/voice/call", headers={"Cookie": f"{server_mod._COOKIE}={token}"})


def _collect_turn(ws, max_events=200):
    """收一整个回合的下行帧，直到 turn_end。"""
    events, audio = [], b""
    for _ in range(max_events):
        message = ws.receive()
        if message.get("bytes") is not None:
            audio += message["bytes"]
            continue
        event = json.loads(message["text"])
        events.append(event)
        if event["type"] == "turn_end":
            break
    return events, audio


def test_voice_call_rejects_unauthenticated():
    with _client().websocket_connect("/api/voice/call") as ws:
        first = ws.receive_json()
        assert first == {"type": "error", "code": "unauthorized", "message": "未登录"}
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == gateway_mod.CLOSE_UNAUTHORIZED


def test_voice_call_rejects_bad_csrf():
    client = _client()
    _csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": "forged"})
        first = ws.receive_json()
        assert first["code"] == "csrf"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == gateway_mod.CLOSE_UNAUTHORIZED


def test_voice_turn_streams_tokens_and_audio(monkeypatch):
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _FakeAgent())
    monkeypatch.setattr(gateway_mod, "create_tts_session", _FakeTTS)
    _FakeTTS.instances.clear()
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf, "thread_id": "voice"})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_json({"type": "user_text", "text": "在吗"})
        events, audio = _collect_turn(ws)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "turn_start"
    assert "token" in kinds and "audio_start" in kinds
    assert "".join(e.get("text", "") for e in events if e["type"] == "token") == "你好，领导。马上办。"
    assert events[-1] == {"type": "turn_end", "interrupted": False}
    assert len(audio) > 0
    assert _FakeTTS.instances and _FakeTTS.instances[-1].spoken  # 真送句子去合成了


def test_voice_turn_degrades_to_text_when_tts_fails(monkeypatch):
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _FakeAgent())
    monkeypatch.setattr(gateway_mod, "create_tts_session", _BrokenTTS)
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_json({"type": "user_text", "text": "在吗"})
        events, audio = _collect_turn(ws)
    kinds = [e["type"] for e in events]
    assert "tts_error" in kinds, "TTS 失败必须明确告知前端"
    assert "audio_start" not in kinds and audio == b""
    assert "".join(e.get("text", "") for e in events if e["type"] == "token") == "你好，领导。马上办。"
    assert events[-1] == {"type": "turn_end", "interrupted": False}


def test_new_utterance_interrupts_inflight_turn(monkeypatch):
    slow = _FakeAgent(pieces=tuple(f"第{i}句话说得很慢。" for i in range(50)), delay=0.05)
    fast = _FakeAgent(pieces=("好的。",))
    agents = iter([slow, fast, fast])
    monkeypatch.setattr(server_mod, "_get_agent", lambda: next(agents, fast))
    monkeypatch.setattr(gateway_mod, "create_tts_session", _FakeTTS)
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_json({"type": "user_text", "text": "讲个长故事"})
        first_events, _ = _collect_turn(ws, max_events=6)  # 只收前几帧就打断
        assert first_events[0]["type"] == "turn_start"
        assert first_events[-1]["type"] != "turn_end", "慢回合不该这么快结束"
        ws.send_json({"type": "user_text", "text": "停，换个话题"})
        events1, _audio = _collect_turn(ws)
        assert events1[-1] == {"type": "turn_end", "interrupted": True}, "在途回合必须被打断"
        events2, _audio = _collect_turn(ws)
        assert events2[0]["type"] == "turn_start"
        assert events2[-1] == {"type": "turn_end", "interrupted": False}
        assert any(e.get("text") == "好的。" for e in events2 if e["type"] == "token")


def test_binary_uplink_reports_asr_unavailable(monkeypatch):
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _FakeAgent())
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(b"\x00\x01fake-pcm")
        notice = ws.receive_json()
        assert notice["code"] == "asr_unavailable"
