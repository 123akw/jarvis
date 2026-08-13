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
