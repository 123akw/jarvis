"""MiniMax TTS 客户端单元测试：不联网，注入假 WebSocket 验证协议处理。"""
import asyncio
import json

import pytest

from jarvis.voice.tts import TTSError, TTSSession


class _FakeWS:
    """按脚本吐服务端事件的假连接。"""

    def __init__(self, incoming):
        self._incoming = list(incoming)
        self.sent = []
        self.closed = False

    async def recv(self):
        if not self._incoming:
            await asyncio.sleep(3600)  # 没词了就挂起，模拟服务端沉默
        return json.dumps(self._incoming.pop(0))

    async def send(self, data):
        self.sent.append(json.loads(data))

    async def close(self):
        self.closed = True


def _run(coro):
    return asyncio.run(coro)


def test_connect_without_key_raises(monkeypatch):
    monkeypatch.delenv("MINIMAX_API_KEY", raising=False)
    session = TTSSession()
    with pytest.raises(TTSError):
        _run(session.connect())


def test_audio_stream_decodes_hex_until_finished():
    async def scenario():
        session = TTSSession()
        session._ws = _FakeWS([
            {"event": "task_continued", "data": {"audio": b"PCM!".hex()}},
            {"event": "task_continued", "data": {"audio": b"MORE".hex()}, "is_final": True},
            {"event": "task_finished"},
        ])
        session._receiver = asyncio.create_task(session._recv_loop())
        chunks = [c async for c in session.audio_chunks()]
        await session.close()
        return chunks

    assert _run(scenario()) == [b"PCM!", b"MORE"]


def test_task_failed_surfaces_as_tts_error():
    async def scenario():
        session = TTSSession()
        session._ws = _FakeWS([
            {"event": "task_failed", "base_resp": {"status_code": 1004}},
        ])
        session._receiver = asyncio.create_task(session._recv_loop())
        with pytest.raises(TTSError):
            async for _ in session.audio_chunks():
                pass
        await session.close()

    _run(scenario())


def test_speak_routes_text_and_close_blocks_further_sends():
    async def scenario():
        session = TTSSession()
        ws = _FakeWS([])
        session._ws = ws
        await session.speak("你好，领导。")
        assert ws.sent == [{"event": "task_continue", "text": "你好，领导。"}]
        await session.close()
        assert ws.closed
        with pytest.raises(TTSError):
            await session.speak("还在吗")

    _run(scenario())


def test_sentence_boundaries_marked_only_when_requested():
    """每句最后一个 task_continued 带 is_final：mark_sentences 时以空块标出句子边界。"""
    script = [
        {"event": "task_continued", "data": {"audio": b"A1".hex()}},
        {"event": "task_continued", "data": {"audio": b"A2".hex()}, "is_final": True},
        {"event": "task_continued", "data": {"audio": b"B1".hex()}, "is_final": True},
        {"event": "task_finished"},
    ]

    async def scenario(mark):
        session = TTSSession()
        session.mark_sentences = mark
        session._ws = _FakeWS(list(script))
        session._receiver = asyncio.create_task(session._recv_loop())
        chunks = [c async for c in session.audio_chunks()]
        await session.close()
        return chunks

    assert _run(scenario(True)) == [b"A1", b"A2", b"", b"B1", b""]
    assert _run(scenario(False)) == [b"A1", b"A2", b"B1"], "默认行为不变（微信语音等调用方）"


def test_default_model_emotion_and_speed_scale(monkeypatch):
    monkeypatch.delenv("MINIMAX_TTS_MODEL", raising=False)
    monkeypatch.delenv("MINIMAX_TTS_SPEED", raising=False)
    assert TTSSession().model == "speech-2.8-turbo"
    monkeypatch.setenv("MINIMAX_TTS_MODEL", "speech-02-turbo")
    assert TTSSession().model == "speech-02-turbo", "配置开关可切回旧模型"
    calm = TTSSession(emotion="calm", speed=1.2, speed_scale=0.95)
    assert calm.emotion == "calm" and calm.speed == 1.14
    assert TTSSession(emotion="whisper").emotion is None, "非通用情绪不下发"
    assert TTSSession(speed=1.9, speed_scale=1.2).speed == 2.0


def test_task_start_carries_emotion(monkeypatch):
    monkeypatch.setenv("MINIMAX_API_KEY", "test-key")
    fake = _FakeWS([{"event": "connected_success"}, {"event": "task_started"}])

    async def fake_connect(*_args, **_kwargs):
        return fake

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    async def scenario():
        session = TTSSession(emotion="happy")
        await session.connect()
        await session.close()

    _run(scenario())
    start = fake.sent[0]
    assert start["event"] == "task_start"
    assert start["voice_setting"]["emotion"] == "happy"
