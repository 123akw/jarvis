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
from jarvis.voice.asr import ASRError, ASRResult
from jarvis.voice.tts import TTSError


class _FakeAgent:
    """把固定文案按块吐出来的假 agent；stream_mode=messages 形状。
    记录每次 stream 的输入与 update_state 调用，供提示词注入/摘除断言。"""

    def __init__(self, pieces=("你好，", "领导。", "马上办。"), delay=0.0):
        self.pieces = pieces
        self.delay = delay
        self.stream_inputs = []
        self.state_updates = []

    def stream(self, state, config=None, stream_mode=None):
        self.stream_inputs.append(state)
        for piece in self.pieces:
            if self.delay:
                time.sleep(self.delay)
            yield AIMessageChunk(content=piece), {}

    def update_state(self, config, values):
        self.state_updates.append(values)


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


class _FakeASR:
    """假识别会话：把上行音频帧当脚本解释（P:增量 / F:定稿 / E:断连），
    结果从 results() 流出——时序完全由测试通过 WebSocket 帧驱动，无跨线程竞态。"""

    instances = []
    connect_delay = 0.0

    def __init__(self):
        self.received = []
        self.closed = False
        self._q = asyncio.Queue()
        _FakeASR.instances.append(self)

    async def connect(self):
        if type(self).connect_delay:
            await asyncio.sleep(type(self).connect_delay)

    async def send_audio(self, chunk):
        self.received.append(chunk)
        text = chunk.decode("utf-8", errors="ignore")
        if text.startswith("P:"):
            self._q.put_nowait(ASRResult(text=text[2:], is_final=False))
        elif text.startswith("F:"):
            self._q.put_nowait(ASRResult(text=text[2:], is_final=True))
        elif text.startswith("E:"):
            self._q.put_nowait(ASRError("语音识别连接中断"))

    async def results(self):
        while True:
            item = await self._q.get()
            if isinstance(item, ASRError):
                raise item
            yield item

    async def close(self):
        self.closed = True


class _BrokenASR(_FakeASR):
    async def connect(self):
        raise ASRError("语音识别连接失败")


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


def test_binary_uplink_falls_back_without_asr_key(monkeypatch):
    """无 DASHSCOPE_API_KEY（真实默认路径，不打桩）：二进制上行 → 一次 asr_fallback。"""
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _FakeAgent())
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(b"\x00\x01fake-pcm")
        notice = ws.receive_json()
        assert notice["type"] == "asr_fallback"
        assert notice["message"], "降级必须带人话提示"
        # 降级后继续送音频不报错、不重复提示；user_text 通道照常可用
        ws.send_bytes(b"\x00\x01more-pcm")
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def _start_call(monkeypatch, asr_factory):
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _FakeAgent())
    monkeypatch.setattr(gateway_mod, "create_tts_session", _FakeTTS)
    monkeypatch.setattr(gateway_mod, "create_asr_session", asr_factory)
    _FakeTTS.instances.clear()
    _FakeASR.instances.clear()
    client = _client()
    csrf, token = _login(client)
    return client, csrf, token


def test_asr_partials_stream_as_subtitles_and_final_starts_turn(monkeypatch):
    client, csrf, token = _start_call(monkeypatch, _FakeASR)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes("P:今天".encode())
        assert ws.receive_json() == {"type": "asr_partial", "text": "今天"}
        ws.send_bytes("P:今天天气".encode())
        assert ws.receive_json() == {"type": "asr_partial", "text": "今天天气"}
        ws.send_bytes("F:今天天气怎么样？".encode())
        assert ws.receive_json() == {"type": "asr_final", "text": "今天天气怎么样？"}
        events, audio = _collect_turn(ws)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "turn_start", "识别定稿必须自动开回合"
    assert "".join(e.get("text", "") for e in events if e["type"] == "token") == "你好，领导。马上办。"
    assert events[-1] == {"type": "turn_end", "interrupted": False}
    assert len(audio) > 0


def test_asr_buffers_audio_while_connecting(monkeypatch):
    _FakeASR.connect_delay = 0.2
    try:
        client, csrf, token = _start_call(monkeypatch, _FakeASR)
        with _connect(client, token) as ws:
            ws.send_json({"type": "init", "csrf": csrf})
            assert ws.receive_json() == {"type": "ready"}
            ws.send_bytes(b"\x00\x01head")       # 建连期间先攒着
            ws.send_bytes("P:第一句".encode())
            assert ws.receive_json() == {"type": "asr_partial", "text": "第一句"}
    finally:
        _FakeASR.connect_delay = 0.0
    session = _FakeASR.instances[-1]
    assert session.received[0] == b"\x00\x01head", "建连前的音频帧必须按序补发，不能丢"


def test_asr_connect_failure_downgrades_and_user_text_still_works(monkeypatch):
    client, csrf, token = _start_call(monkeypatch, _BrokenASR)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(b"\x00\x01pcm")
        notice = ws.receive_json()
        assert notice["type"] == "asr_fallback"
        ws.send_json({"type": "user_text", "text": "在吗"})  # 降级通道照常对话
        events, audio = _collect_turn(ws)
    assert events[0]["type"] == "turn_start"
    assert events[-1] == {"type": "turn_end", "interrupted": False}
    assert len(audio) > 0


def test_asr_midstream_disconnect_downgrades_once(monkeypatch):
    client, csrf, token = _start_call(monkeypatch, _FakeASR)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes("P:喂喂".encode())
        assert ws.receive_json() == {"type": "asr_partial", "text": "喂喂"}
        ws.send_bytes(b"E:")  # 识别流中途断掉
        notice = ws.receive_json()
        assert notice["type"] == "asr_fallback"
        ws.send_bytes(b"\x00\x01after")  # 降级后音频静默丢弃，连接不崩
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}
    assert _FakeASR.instances[-1].closed, "降级后必须关掉识别连接"


def test_voice_turn_injects_style_prompt_then_scrubs_it(monkeypatch):
    """语音回合：注入一次性口语化 system 指令，回合结束从 checkpoint 摘除。"""
    agent = _FakeAgent()
    monkeypatch.setattr(server_mod, "_get_agent", lambda: agent)
    monkeypatch.setattr(gateway_mod, "create_tts_session", _FakeTTS)
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_json({"type": "user_text", "text": "现在几点了"})
        _collect_turn(ws)
    messages = agent.stream_inputs[-1]["messages"]
    style, user = messages[0], messages[-1]
    assert style.type == "system" and style.content == gateway_mod.VOICE_STYLE_PROMPT
    assert style.id.startswith("voice-style-")
    assert user["content"] == "现在几点了"
    removed = [m for upd in agent.state_updates for m in upd.get("messages", [])]
    assert [m.id for m in removed] == [style.id], "回合结束必须把风格指令从 checkpoint 摘掉"


def test_text_chat_unaffected_by_voice_style_prompt(monkeypatch):
    """文字模式 /api/chat：输入里绝不能出现语音风格指令。"""
    agent = _FakeAgent()
    monkeypatch.setattr(server_mod, "_get_agent", lambda: agent)
    client = _client()
    csrf, _token = _login(client)
    with client.stream("POST", "/api/chat", headers={"X-JWS-CSRF": csrf},
                       json={"message": "现在几点了", "thread_id": "web"}) as response:
        assert response.status_code == 200
        body = "".join(response.iter_text())
    assert '"done"' in body, "文字聊天要真实走完流式"
    messages = agent.stream_inputs[-1]["messages"]
    assert len(messages) == 1 and messages[0]["role"] == "user"
    assert gateway_mod.VOICE_STYLE_PROMPT not in str(messages)
    assert agent.state_updates == [], "文字模式不该有任何语音模式的状态修补"


def test_style_scrub_removes_system_message_from_real_checkpoint():
    """真 langgraph 检查点（非打桩）：注入的 system 指令被 _scrub_style 真正摘除。"""
    from langchain_core.messages import AIMessage, SystemMessage
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import START, MessagesState, StateGraph

    graph = StateGraph(MessagesState)
    graph.add_node("responder", lambda state: {"messages": [AIMessage(content="好的。")]})
    graph.add_edge(START, "responder")
    agent = graph.compile(checkpointer=InMemorySaver())

    config = {"configurable": {"thread_id": "t-scrub"}}
    style_id = "voice-style-test"
    for _ in agent.stream(
            {"messages": [SystemMessage(content=gateway_mod.VOICE_STYLE_PROMPT, id=style_id),
                          {"role": "user", "content": "在吗"}]},
            config=config, stream_mode="messages"):
        pass
    types_before = [m.type for m in agent.get_state(config).values["messages"]]
    assert "system" in types_before, "前置条件：注入的确落进了检查点"

    gateway_mod._Turn._scrub_style(agent, config, style_id)

    remaining = agent.get_state(config).values["messages"]
    assert [m.type for m in remaining] == ["human", "ai"], "文字回放与后续上下文零残留"


def test_interrupt_discards_unfinalized_partial(monkeypatch):
    client, csrf, token = _start_call(monkeypatch, _FakeASR)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes("P:帮我查一下那个".encode())
        assert ws.receive_json() == {"type": "asr_partial", "text": "帮我查一下那个"}
        ws.send_json({"type": "interrupt"})
        assert ws.receive_json() == {"type": "asr_partial", "text": ""}, \
            "打断必须丢弃未定稿文字并清空字幕灰字"
        # 未定稿文字不得变成回合；之后新的定稿照常开回合
        ws.send_bytes("F:换个话题".encode())
        assert ws.receive_json() == {"type": "asr_final", "text": "换个话题"}
        events, _audio = _collect_turn(ws)
    starts = [e for e in events if e["type"] == "turn_start"]
    assert len(starts) == 1, "打断丢弃的 partial 不该开过回合"
