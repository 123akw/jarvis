"""百炼实时识别客户端单元测试：不联网，注入假 WebSocket 验证协议处理。"""
import asyncio
import json

import pytest

from jarvis.voice.asr import ASRError, ASRResult, ASRSession


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
        self.sent.append(data)

    async def close(self):
        self.closed = True


def _event(name, sentence=None):
    msg = {"header": {"event": name, "task_id": "t", "attributes": {}}, "payload": {}}
    if sentence is not None:
        msg["payload"] = {"output": {"sentence": sentence}}
    return msg


def _run(coro):
    return asyncio.run(coro)


def test_connect_without_key_raises(monkeypatch):
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    session = ASRSession()
    with pytest.raises(ASRError, match="语音识别未配置"):
        _run(session.connect())


def test_connect_sends_run_task_and_waits_task_started(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    ws = _FakeWS([_event("task-started")])

    async def fake_connect(url, **kwargs):
        assert url.startswith("wss://")
        assert kwargs["additional_headers"]["Authorization"] == "bearer sk-test"
        return ws

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    async def scenario():
        session = ASRSession()
        await session.connect()
        run_task = json.loads(ws.sent[0])
        await session.close()
        return run_task

    run_task = _run(scenario())
    assert run_task["header"]["action"] == "run-task"
    assert run_task["header"]["streaming"] == "duplex"
    payload = run_task["payload"]
    assert payload["model"] == "paraformer-realtime-v2"
    assert payload["task"] == "asr" and payload["function"] == "recognition"
    assert payload["parameters"]["format"] == "pcm"
    assert payload["parameters"]["sample_rate"] == 16000


def test_connect_task_failed_raises(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    ws = _FakeWS([_event("task-failed")])

    async def fake_connect(url, **kwargs):
        return ws

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)
    with pytest.raises(ASRError):
        _run(ASRSession().connect())
    assert ws.closed


def test_results_yield_partials_then_final_until_finished():
    async def scenario():
        session = ASRSession()
        session._ws = _FakeWS([
            _event("result-generated", {"text": "今天", "sentence_end": False}),
            _event("result-generated", {"text": "心跳", "heartbeat": True, "sentence_end": False}),
            _event("result-generated", {"text": "今天天气", "sentence_end": False}),
            _event("result-generated", {"text": "今天天气怎么样？", "sentence_end": True}),
            _event("task-finished"),
        ])
        session._receiver = asyncio.create_task(session._recv_loop())
        results = [r async for r in session.results()]
        await session.close()
        return results

    results = _run(scenario())
    assert results == [
        ASRResult(text="今天", is_final=False),
        ASRResult(text="今天天气", is_final=False),
        ASRResult(text="今天天气怎么样？", is_final=True),
    ], "heartbeat 占位必须丢弃，增量与定稿要按序流出"


def test_task_failed_surfaces_as_asr_error():
    async def scenario():
        session = ASRSession()
        session._ws = _FakeWS([
            _event("result-generated", {"text": "喂", "sentence_end": False}),
            _event("task-failed"),
        ])
        session._receiver = asyncio.create_task(session._recv_loop())
        collected = []
        with pytest.raises(ASRError):
            async for r in session.results():
                collected.append(r)
        await session.close()
        return collected

    assert _run(scenario()) == [ASRResult(text="喂", is_final=False)]


def test_send_audio_binary_and_finish_task_shape():
    async def scenario():
        session = ASRSession()
        ws = _FakeWS([])
        session._ws = ws
        await session.send_audio(b"\x00\x01\x02\x03")
        await session.finish()
        assert ws.sent[0] == b"\x00\x01\x02\x03", "音频必须原样二进制上行"
        finish = json.loads(ws.sent[1])
        assert finish["header"]["action"] == "finish-task"
        assert finish["header"]["task_id"] == session.task_id
        await session.close()
        assert ws.closed
        with pytest.raises(ASRError):
            await session.send_audio(b"\x00")

    _run(scenario())
