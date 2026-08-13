"""微信语音收发：解析/下载/解码/识别/合成/编码/降级全链路（fake 注入，无网络）。"""
import base64
import io
import logging
import math
import struct
import wave
from types import SimpleNamespace

import httpx
import pytest

from jarvis import wechat
from jarvis import wechat_voice
from jarvis.accounts import AccountStore
from jarvis.wechat_voice import (
    DashScopeASR,
    VoiceASRError,
    VoiceDecodeError,
    VoiceDownloadError,
    VoiceSynthesisError,
    build_voice_items,
    decode_to_wav,
    download_voice,
    encode_silk,
    find_voice_item,
    pcm_to_wav,
    synthesize_pcm,
)


class FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self.payload = payload or {}
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", "https://example.test")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("failed", request=request, response=response)

    def json(self):
        return self.payload


class FakeClient:
    """捕获 sendmessage 的完整 item_list，语音/文字都留痕。"""

    def __init__(self):
        self.post_calls = []
        self.item_lists = []
        self.texts = []

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        if url.endswith("/sendmessage"):
            items = kwargs["json"]["msg"]["item_list"]
            self.item_lists.append(items)
            for item in items:
                if item.get("type") == 1:
                    self.texts.append(item["text_item"]["text"])
        return FakeResponse({"ret": 0})

    def close(self):
        pass


class VoiceSendRejectingClient(FakeClient):
    """语音 item 的 sendmessage 网络失败，文字照常——模拟发语音挂、文字兜底。"""

    def post(self, url, **kwargs):
        if url.endswith("/sendmessage"):
            items = kwargs["json"]["msg"]["item_list"]
            if any(item.get("type") != 1 for item in items):
                self.post_calls.append((url, kwargs))
                raise httpx.ConnectError("voice send down")
        return super().post(url, **kwargs)


def make_voice_bridge(tmp_path, client, pipeline, reply="收到"):
    """只替换 iLink/管线边界；状态机、租户与回复链路走真实实现。"""
    agent_calls = []

    class FakeAgent:
        def invoke(self, state, config):
            agent_calls.append(state["messages"][0]["content"])
            return {"messages": [SimpleNamespace(content=reply)]}

    bridge = wechat.WeChatBridge(
        agent_getter=lambda: FakeAgent(),
        chunk_text=lambda content: str(content),
        data_dir_getter=lambda: tmp_path,
        client_factory=lambda: client,
        sleeper=lambda _s: None,
        owner_getter=lambda: (
            AccountStore()._ensure_bootstrap() or AccountStore().unique_active_owner()
        ),
        voice_pipeline=pipeline,
    )
    return bridge, agent_calls


def voice_message(voice_payload, from_id="contact-123456789012@example"):
    return {
        "get_updates_buf": "next",
        "msgs": [{
            "message_type": 5,
            "from_user_id": from_id,
            "context_token": "ctx",
            "item_list": [{"type": 34, "voice_item": voice_payload}],
        }],
    }


def fake_pipeline(
    asr=lambda wav: "今天天气怎么样",
    decoder=lambda data: (b"fake-wav", 1000),
    synthesizer=lambda text: b"\x01\x02" * 64,
    encoder=lambda pcm: (b"fake-silk", 1234),
):
    return wechat_voice.VoicePipeline(
        decoder=decoder, asr=asr, synthesizer=synthesizer, encoder=encoder
    )


EMBEDDED = {"voice_data": base64.b64encode(b"silk-bytes").decode()}


# ---- 任务 1/2 验收：成功路（语音+文字双发） ----

def test_voice_message_transcribed_then_voice_and_text_replies(tmp_path):
    """成功路：识别文字进现有回复链路；回两条——先语音 item、后带标注的文字。"""
    client = FakeClient()
    bridge, agent_calls = make_voice_bridge(
        tmp_path, client, fake_pipeline(), reply="外面 28 度，晴。"
    )

    next_buf = bridge._handle_updates_response(
        client, "token", voice_message(EMBEDDED)
    )

    assert next_buf == "next"
    assert agent_calls == ["今天天气怎么样"]
    assert len(client.item_lists) == 2
    voice_items, text_items = client.item_lists
    assert voice_items[0]["type"] == 34
    payload = voice_items[0]["voice_item"]
    assert base64.b64decode(payload["voice_data"]) == b"fake-silk"
    assert payload["format"] == "silk"
    assert payload["duration"] == 1234
    assert text_items[0]["type"] == 1
    text = client.texts[0]
    assert text.startswith("（语音识别）你说的是：「今天天气怎么样」")
    assert "外面 28 度，晴。" in text


def test_voice_reply_uses_complete_ilink_send_contract(tmp_path):
    """语音 sendmessage 也必须带 client_id/base_info，否则 iLink 会静默丢弃。"""
    client = FakeClient()
    bridge, _ = make_voice_bridge(tmp_path, client, fake_pipeline())

    bridge._handle_updates_response(client, "token", voice_message(EMBEDDED))

    voice_send = client.post_calls[0][1]["json"]
    assert voice_send["msg"]["client_id"].startswith("jws-agent:")
    assert voice_send["base_info"] == {
        "channel_version": "2.4.6",
        "bot_agent": "JWS-Agent",
    }


# ---- 任务 1 验收：识别失败 / 解码失败 / 下载失败 三路 ----

def test_asr_failure_replies_not_understood(tmp_path):
    """fake ASR 抛错 → 用户收到固定「没听清」提示，Agent 不被打扰。"""

    def broken_asr(wav):
        raise VoiceASRError("识别服务不可用")

    client = FakeClient()
    bridge, agent_calls = make_voice_bridge(
        tmp_path, client, fake_pipeline(asr=broken_asr)
    )

    bridge._handle_updates_response(client, "token", voice_message(EMBEDDED))

    assert agent_calls == []
    assert client.texts == [wechat.VOICE_NOT_UNDERSTOOD]
    assert len(client.item_lists) == 1


def test_decode_failure_replies_not_understood(tmp_path):
    def broken_decoder(data):
        raise VoiceDecodeError("未知编码")

    client = FakeClient()
    bridge, agent_calls = make_voice_bridge(
        tmp_path, client, fake_pipeline(decoder=broken_decoder)
    )

    bridge._handle_updates_response(client, "token", voice_message(EMBEDDED))

    assert agent_calls == []
    assert client.texts == [wechat.VOICE_NOT_UNDERSTOOD]


def test_download_failure_replies_not_understood(tmp_path):
    """语音负载没有任何可用凭证（结构对不上）也必须有回音，绝不沉默。"""
    client = FakeClient()
    bridge, agent_calls = make_voice_bridge(tmp_path, client, fake_pipeline())

    bridge._handle_updates_response(
        client, "token", voice_message({"unknown_field": 42})
    )

    assert agent_calls == []
    assert client.texts == [wechat.VOICE_NOT_UNDERSTOOD]


# ---- 任务 2 验收：发语音失败降级纯文字 ----

def test_synthesis_failure_degrades_to_text_only(tmp_path, caplog):
    def broken_tts(text):
        raise VoiceSynthesisError("语音合成失败")

    client = FakeClient()
    bridge, agent_calls = make_voice_bridge(
        tmp_path, client, fake_pipeline(synthesizer=broken_tts), reply="好的。"
    )

    with caplog.at_level(logging.WARNING, logger="jarvis.wechat"):
        bridge._handle_updates_response(client, "token", voice_message(EMBEDDED))

    assert agent_calls == ["今天天气怎么样"]
    assert len(client.item_lists) == 1
    assert client.item_lists[0][0]["type"] == 1
    assert "好的。" in client.texts[0]
    assert any(
        "degraded to text (synthesis/encode)" in record.message
        for record in caplog.records
    )


def test_voice_send_network_failure_still_delivers_text(tmp_path, caplog):
    client = VoiceSendRejectingClient()
    bridge, _ = make_voice_bridge(
        tmp_path, client, fake_pipeline(), reply="好的。"
    )

    with caplog.at_level(logging.WARNING, logger="jarvis.wechat"):
        bridge._handle_updates_response(client, "token", voice_message(EMBEDDED))

    assert client.texts and "好的。" in client.texts[0]
    assert all(item["type"] == 1 for items in client.item_lists for item in items)
    assert any(
        "degraded to text (send)" in record.message for record in caplog.records
    )


def test_group_voice_message_is_ignored(tmp_path):
    client = FakeClient()
    bridge, agent_calls = make_voice_bridge(tmp_path, client, fake_pipeline())

    bridge._handle_updates_response(
        client, "token", voice_message(EMBEDDED, from_id="g@im.chatroom")
    )

    assert agent_calls == []
    assert client.item_lists == []


# ---- 模块单测：解析结构自适应与可配置 ----

def test_find_voice_item_matches_known_and_voiceish_keys():
    known = {"item_list": [{"type": 34, "voice_item": {"voice_url": "https://x"}}]}
    assert find_voice_item(known) == {"voice_url": "https://x"}
    adaptive = {"item_list": [{"type": 99, "wx_voice_msg": {"url": "https://y"}}]}
    assert find_voice_item(adaptive) == {"url": "https://y"}


def test_find_voice_item_never_matches_text_items_or_junk():
    assert find_voice_item({"item_list": [
        {"type": 1, "text_item": {"text": "你好"}},
        {"type": 3},
    ]}) is None
    assert find_voice_item({"item_list": "oops"}) is None
    assert find_voice_item({}) is None


def test_find_voice_item_key_is_configurable(monkeypatch):
    monkeypatch.setenv("JARVIS_WECHAT_VOICE_ITEM_KEYS", "blob")
    message = {"item_list": [{"type": 9, "blob": {"download_url": "https://z"}}]}
    assert find_voice_item(message) == {"download_url": "https://z"}


def test_download_voice_prefers_embedded_data_then_url():
    embedded = {"voice_data": base64.b64encode(b"raw-audio").decode()}
    assert download_voice(embedded) == b"raw-audio"

    fetched = []

    def fake_get(url):
        fetched.append(url)
        return b"downloaded"

    assert download_voice({"voice_url": "https://cdn/v.silk"}, http_get=fake_get) == (
        b"downloaded"
    )
    assert fetched == ["https://cdn/v.silk"]

    with pytest.raises(VoiceDownloadError):
        download_voice({"nothing": "here"})


# ---- 模块单测：真实 silk 编解码往返（pilk） ----

def _sine_pcm(sample_rate=24000, seconds=1.0, freq=440):
    count = int(sample_rate * seconds)
    return b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * t / sample_rate)))
        for t in range(count)
    )


def test_silk_roundtrip_encode_then_decode_to_wav():
    pcm = _sine_pcm()
    silk, duration_ms = encode_silk(pcm, 24000)
    assert silk.startswith(b"\x02#!SILK_V3")
    assert 900 <= duration_ms <= 1100

    wav, decoded_ms = decode_to_wav(silk)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    assert 900 <= decoded_ms <= 1100
    with wave.open(io.BytesIO(wav), "rb") as reader:
        assert reader.getframerate() == wechat_voice.ASR_SAMPLE_RATE
        assert reader.getnframes() > 0


def test_decode_rejects_unknown_and_empty_bytes():
    with pytest.raises(VoiceDecodeError):
        decode_to_wav(b"")
    with pytest.raises(VoiceDecodeError):
        decode_to_wav(b"#!AMR\n....")


def test_decode_passes_wav_through():
    wav = pcm_to_wav(_sine_pcm(16000, 0.5), 16000)
    out, duration_ms = decode_to_wav(wav)
    assert out == wav
    assert 400 <= duration_ms <= 600


# ---- 模块单测：sendmessage 语音 item 打包可配置 ----

def test_build_voice_items_default_and_env_override(monkeypatch):
    items = build_voice_items(b"abc", 2300)
    assert items == [{
        "type": 34,
        "voice_item": {
            "voice_data": base64.b64encode(b"abc").decode(),
            "format": "silk",
            "duration": 2300,
        },
    }]

    monkeypatch.setenv("JARVIS_WECHAT_VOICE_SEND_ITEM_TYPE", "7")
    monkeypatch.setenv("JARVIS_WECHAT_VOICE_SEND_ITEM_KEY", "audio_item")
    monkeypatch.setenv("JARVIS_WECHAT_VOICE_SEND_DATA_KEY", "payload")
    monkeypatch.setenv("JARVIS_WECHAT_VOICE_SEND_FORMAT", "silkv3")
    overridden = build_voice_items(b"abc", 2300)[0]
    assert overridden["type"] == 7
    assert overridden["audio_item"]["payload"] == base64.b64encode(b"abc").decode()
    assert overridden["audio_item"]["format"] == "silkv3"


# ---- 模块单测：百炼 ASR 客户端（fake http，无网络） ----

def test_dashscope_asr_requires_key(monkeypatch):
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    with pytest.raises(VoiceASRError):
        DashScopeASR()(b"wav-bytes")


def test_dashscope_asr_sends_audio_and_parses_text(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "unit-test-key")
    seen = {}

    def fake_post(url, headers=None, json=None):
        seen["url"] = url
        seen["headers"] = headers
        seen["json"] = json
        return {"output": {"choices": [{"message": {"content": [
            {"text": "帮我记一下"}, {"text": "明早买咖啡"},
        ]}}]}}

    text = DashScopeASR(http_post=fake_post)(b"wav-bytes")

    assert text == "帮我记一下明早买咖啡"
    assert seen["url"].startswith("https://dashscope.aliyuncs.com/")
    assert seen["headers"]["Authorization"] == "Bearer unit-test-key"
    audio = seen["json"]["input"]["messages"][1]["content"][0]["audio"]
    assert audio == "data:audio/wav;base64," + base64.b64encode(b"wav-bytes").decode()


def test_dashscope_asr_maps_failures_to_voice_error(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "unit-test-key")

    def http_500(url, headers=None, json=None):
        raise httpx.ConnectError("down")

    with pytest.raises(VoiceASRError):
        DashScopeASR(http_post=http_500)(b"wav")

    def empty_payload(url, headers=None, json=None):
        return {"output": {"choices": []}}

    with pytest.raises(VoiceASRError):
        DashScopeASR(http_post=empty_payload)(b"wav")


# ---- 模块单测：TTS 同步封装（fake 会话，无网络） ----

class FakeTTSSession:
    last_spoken = []

    def __init__(self, fail=False):
        self.fail = fail

    async def connect(self):
        if self.fail:
            from jarvis.voice.tts import TTSError
            raise TTSError("语音合成连接失败")

    async def speak(self, text):
        type(self).last_spoken.append(text)

    async def finish(self):
        pass

    async def audio_chunks(self):
        yield b"\x00\x01"
        yield b"\x02\x03"

    async def close(self):
        pass


def test_synthesize_pcm_cleans_markdown_and_collects_audio():
    FakeTTSSession.last_spoken.clear()
    pcm = synthesize_pcm("**你好**，见 [链接](https://x)。", session_factory=FakeTTSSession)
    assert pcm == b"\x00\x01\x02\x03"
    assert FakeTTSSession.last_spoken == ["你好，见 链接。"]


def test_synthesize_pcm_rejects_empty_and_maps_tts_error():
    with pytest.raises(VoiceSynthesisError):
        synthesize_pcm("   ", session_factory=FakeTTSSession)
    with pytest.raises(VoiceSynthesisError):
        synthesize_pcm("你好", session_factory=lambda: FakeTTSSession(fail=True))
