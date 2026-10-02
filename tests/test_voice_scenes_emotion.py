"""语音场景切换 + 情绪感知：网关打桩测试（复用 test_voice_gateway 的假件形状）。"""
import asyncio
import time

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessageChunk

import jarvis.server as server_mod
import jarvis.voice.gateway as gateway_mod
import jarvis.voice.scenes as scenes_mod
from jarvis.voice.asr import ASRResult
from jarvis.voice.emotion import EMOTION_LABELS, extract_emotion


class _FakeAgent:
    def __init__(self, pieces=("好的。",)):
        self.pieces = pieces
        self.stream_inputs = []
        self.state_updates = []

    def stream(self, state, config=None, stream_mode=None):
        self.stream_inputs.append(state)
        for piece in self.pieces:
            yield AIMessageChunk(content=piece), {}

    def update_state(self, config, values):
        self.state_updates.append(values)


class _FakeTTS:
    created = []   # 每次实例化的关键字参数（语气/语速断言用）

    def __init__(self, **kwargs):
        self.audio_format = "pcm"
        self.sample_rate = 24000
        self._q = asyncio.Queue()
        _FakeTTS.created.append(kwargs)

    async def connect(self):
        pass

    async def speak(self, text):
        self._q.put_nowait(b"\x01\x02")

    async def finish(self):
        self._q.put_nowait(None)

    async def audio_chunks(self):
        while True:
            item = await self._q.get()
            if item is None:
                return
            yield item

    async def close(self):
        pass


class _FakeASR:
    async def connect(self):
        pass

    async def send_audio(self, chunk):
        text = chunk.decode("utf-8", errors="ignore")
        if text.startswith("F:"):
            self._q.put_nowait(ASRResult(text=text[2:], is_final=True))

    def __init__(self):
        self._q = asyncio.Queue()

    async def results(self):
        while True:
            yield await self._q.get()

    async def close(self):
        pass


def _client():
    return TestClient(server_mod.app)


def _login(client):
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    return client.get("/api/session").json()["csrf_token"], client.cookies[server_mod._COOKIE]


def _connect(client, token):
    return client.websocket_connect(
        "/api/voice/call", headers={"Cookie": f"{server_mod._COOKIE}={token}"})


def _collect_turn(ws, max_events=100):
    events = []
    for _ in range(max_events):
        message = ws.receive()
        if message.get("bytes") is not None:
            continue
        import json as json_mod
        event = json_mod.loads(message["text"])
        events.append(event)
        if event["type"] == "turn_end":
            break
    return events


# ---------- 场景目录 ----------

def test_scene_catalog_is_sound():
    ids = [s["id"] for s in scenes_mod.SCENES]
    assert len(ids) == len(set(ids)) and "butler" in ids
    assert len(ids) >= 8, "至少管家 + 7 个场景"
    assert scenes_mod.scene_prompt("butler") == gateway_mod.VOICE_STYLE_PROMPT, \
        "默认场景必须与原语音风格一致（回归保障）"
    assert scenes_mod.scene_prompt("不存在") == gateway_mod.VOICE_STYLE_PROMPT
    for scene in scenes_mod.SCENES:
        assert "语音通话" in scene["prompt"], f"{scene['id']} 必须带语音朗读基础约束"
    listed = scenes_mod.catalog()
    assert all("prompt" not in item for item in listed), "目录不应外泄提示词正文"


def test_voice_settings_carry_scene_catalog():
    client = _client()
    _login(client)
    data = client.get("/api/voice/settings").json()
    assert data["scene"] == "butler"
    assert any(item["id"] == "night" for item in data["scenes"])


# ---------- 场景切换 ----------

def test_scene_switch_changes_next_turn_prompt_and_persists(monkeypatch):
    agent = _FakeAgent()
    monkeypatch.setattr(server_mod, "_get_agent", lambda: agent)
    monkeypatch.setattr(gateway_mod, "create_tts_session", _FakeTTS)
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        ready = ws.receive_json()
        assert ready["type"] == "ready" and ready["scene"] == "butler"
        ws.send_json({"type": "scene", "scene": "night"})
        ack = ws.receive_json()
        assert ack == {"type": "scene", "scene": "night", "scene_name": "晚安电台",
                       "opening": scenes_mod.scene_by_id("night")["opening"]}
        ws.send_json({"type": "scene", "scene": "hack-unknown"})  # 未知场景静默忽略
        ws.send_json({"type": "user_text", "text": "睡不着"})
        _collect_turn(ws)
    style = agent.stream_inputs[-1]["messages"][0]
    assert "深夜电台" in style.content, "切场景后下一回合注入场景化规则"
    # 偏好已持久化：新通话默认进入该场景
    assert client.get("/api/voice/settings").json()["scene"] == "night"
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["scene"] == "night"
        ws.send_json({"type": "scene", "scene": "butler"})  # 复位，别污染后续用例
        ws.receive_json()


def test_init_scene_overrides_pref(monkeypatch):
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _FakeAgent())
    monkeypatch.setattr(gateway_mod, "create_tts_session", _FakeTTS)
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf, "scene": "debate"})
        ready = ws.receive_json()
        assert ready["scene"] == "debate" and ready["opening"], "init 可直接指定场景"


# ---------- 情绪感知 ----------

def test_emotion_detected_downlinked_and_injected_next_turn(monkeypatch):
    agent = _FakeAgent()
    monkeypatch.setattr(server_mod, "_get_agent", lambda: agent)
    monkeypatch.setattr(gateway_mod, "create_tts_session", _FakeTTS)
    monkeypatch.setattr(gateway_mod, "create_asr_session", _FakeASR)
    monkeypatch.setattr(gateway_mod, "_EMOTION_MIN_PCM_BYTES", 1)
    monkeypatch.setattr(gateway_mod, "detect_emotion", lambda wav: "sad")
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes("F:今天有点难受。".encode())
        events = _collect_turn(ws)
        kinds = {e["type"] for e in events}
        assert "emotion" in kinds, "情绪帧必须下行给前端"
        emotion = next(e for e in events if e["type"] == "emotion")
        assert emotion == {"type": "emotion", "emotion": "sad", "label": "低落"}
        ws.send_bytes("F:再聊聊吧。".encode())
        _collect_turn(ws)
    second_style = agent.stream_inputs[-1]["messages"][0]
    assert "低落" in second_style.content and "语气感知" in second_style.content, \
        "情绪结果就绪后必须注入回合提示（异步旁路，快则当回合、慢则下一回合）"
    tts_kwargs = _FakeTTS.created[-1]
    assert tts_kwargs.get("emotion") == "calm" and tts_kwargs.get("speed_scale", 1) < 1, \
        "主人低落：下一回合 TTS 更稳更慢，而不是跟着低落"


def test_tts_style_scene_base_and_emotion_nudge():
    from jarvis.voice.emotion import tts_style_for

    assert tts_style_for("neutral") == {} and tts_style_for("") == {}
    assert tts_style_for("happy")["emotion"] == "happy"
    assert scenes_mod.scene_tts("butler") == {}
    assert scenes_mod.scene_tts("night") == {"emotion": "calm", "speed_scale": 0.9}

    call = gateway_mod._CallSession.__new__(gateway_mod._CallSession)
    call.scene_id, call.last_emotion = "night", "happy"
    style = call.tts_style()
    assert style["emotion"] == "calm", "场景定下的语气不被情绪覆盖"
    assert style["speed_scale"] == round(0.9 * 1.03, 3)
    call.scene_id, call.last_emotion = "butler", "angry"
    assert call.tts_style() == {"emotion": "calm", "speed_scale": 0.97}


def test_neutral_emotion_not_injected(monkeypatch):
    agent = _FakeAgent()
    monkeypatch.setattr(server_mod, "_get_agent", lambda: agent)
    monkeypatch.setattr(gateway_mod, "create_tts_session", _FakeTTS)
    monkeypatch.setattr(gateway_mod, "create_asr_session", _FakeASR)
    monkeypatch.setattr(gateway_mod, "_EMOTION_MIN_PCM_BYTES", 1)
    monkeypatch.setattr(gateway_mod, "detect_emotion", lambda wav: "neutral")
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes("F:平常说话。".encode())
        _collect_turn(ws)
        ws.send_bytes("F:继续。".encode())
        _collect_turn(ws)
    assert all("语气感知" not in m["messages"][0].content for m in
               [{"messages": s["messages"]} for s in agent.stream_inputs])


def test_extract_emotion_parses_annotations():
    payload = {"output": {"choices": [{"message": {
        "content": [{"text": "你好"}],
        "annotations": [{"type": "audio_info", "language": "zh", "emotion": "Happy"}],
    }}]}}
    assert extract_emotion(payload) == "happy"
    assert extract_emotion({}) == ""
    assert extract_emotion({"output": {"choices": [{"message": {"annotations": [
        {"emotion": "unknown-tag"}]}}]}}) == ""
    assert set(EMOTION_LABELS) == {"happy", "sad", "angry", "surprised",
                                   "fearful", "disgusted", "neutral"}
