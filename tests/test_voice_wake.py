"""语音唤醒送检端点 /api/voice/wake：识别打桩，不联网。"""
import base64

from fastapi.testclient import TestClient

import jarvis.server as server_mod
from jarvis.wechat_voice import VoiceASRError


class _FakeWakeASR:
    text = "贾维斯，在吗"
    fail = False

    def __call__(self, wav_bytes):
        assert wav_bytes, "端点必须把解码后的音频交给识别器"
        if type(self).fail:
            raise VoiceASRError("语音识别未配置（缺 DASHSCOPE_API_KEY）")
        return type(self).text


def _client():
    return TestClient(server_mod.app)


def _login(client):
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    return client.get("/api/session").json()["csrf_token"]


def _check(client, csrf, audio=b"fake-wav"):
    return client.post("/api/voice/wake", headers={"X-JWS-CSRF": csrf},
                       json={"audio_b64": base64.b64encode(audio).decode()})


def test_wake_matching_normalizes_punctuation_and_case(monkeypatch):
    monkeypatch.delenv("JARVIS_WAKE_WORDS", raising=False)
    assert server_mod.wake_matched("贾维斯")
    assert server_mod.wake_matched("喂，贾 维 斯！帮我看看")
    assert server_mod.wake_matched("Hey JARVIS")
    assert server_mod.wake_matched("加维斯在吗")   # 同音兜底
    assert not server_mod.wake_matched("今天天气不错")
    assert not server_mod.wake_matched("")


def test_wake_words_env_override(monkeypatch):
    monkeypatch.setenv("JARVIS_WAKE_WORDS", "小助手, 管家")
    assert server_mod.wake_matched("小助手你好")
    assert not server_mod.wake_matched("贾维斯")


def test_wake_endpoint_matches(monkeypatch):
    monkeypatch.setattr(server_mod, "create_wake_asr", _FakeWakeASR)
    _FakeWakeASR.text = "贾维斯。"
    _FakeWakeASR.fail = False
    client = _client()
    csrf = _login(client)
    data = _check(client, csrf).json()
    assert data == {"ok": True, "matched": True, "text": "贾维斯。"}
    _FakeWakeASR.text = "随便聊两句"
    assert _check(client, csrf).json()["matched"] is False


def test_wake_endpoint_degrades_without_asr(monkeypatch):
    monkeypatch.setattr(server_mod, "create_wake_asr", _FakeWakeASR)
    _FakeWakeASR.fail = True
    try:
        client = _client()
        csrf = _login(client)
        data = _check(client, csrf).json()
    finally:
        _FakeWakeASR.fail = False
    assert data["ok"] is False and data["matched"] is False
    assert data["message"], "识别不可用必须带人话提示"


def test_wake_endpoint_guards():
    client = _client()
    assert client.post("/api/voice/wake", json={"audio_b64": "aGk="}).status_code == 401
    csrf = _login(client)
    oversize = "A" * (server_mod._WAKE_AUDIO_B64_MAX + 1)
    assert client.post("/api/voice/wake", headers={"X-JWS-CSRF": csrf},
                       json={"audio_b64": oversize}).status_code == 422
    assert client.post("/api/voice/wake", headers={"X-JWS-CSRF": csrf},
                       json={"audio_b64": "not-base64!!"}).status_code == 422
    assert client.post("/api/voice/wake", headers={"X-JWS-CSRF": csrf},
                       json={"audio_b64": ""}).status_code == 422
