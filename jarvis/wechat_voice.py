"""微信语音收发管线：解析/下载/解码/识别（收侧）与合成/编码/打包（发侧）。

协议现状（2026-08-13）：生产探针日志尚无语音报文实样，收发两侧的报文结构
均按「item type 未知 + voice_item 含下载凭证」的自适应结构实现；key 名与
类型号全部可用 JARVIS_WECHAT_VOICE_* 环境变量覆盖，真实样本到位后只需在
本文件顶部的默认值处一处改齐。

对 jarvis/voice 只做只读 import（tts.TTSSession/TTSError/SAMPLE_RATE 与
segment.speakable 的公开接口），一行不改——那是网页语音线的地界。

铁律：任何 API key 只从环境变量读；语音内容与 key 绝不进日志。
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import io
import os
import tempfile
import wave

import httpx

from jarvis.voice.segment import speakable
from jarvis.voice.tts import SAMPLE_RATE as TTS_SAMPLE_RATE
from jarvis.voice.tts import TTSError, TTSSession

# 识别侧统一转成 16k/16bit/单声道 wav：ASR 通用采样率，也方便人耳复听排障。
ASR_SAMPLE_RATE = 16000

# ---- 报文结构（未见实样，全部可配置；实样到位改这里的默认值） ----
DEFAULT_VOICE_ITEM_KEYS = "voice_item,voice_msg_item,voicemsg"
DEFAULT_VOICE_URL_KEYS = "voice_url,url,download_url,cdn_url,file_url"
DEFAULT_VOICE_DATA_KEYS = "voice_data,data,buffer,content"
DEFAULT_SEND_ITEM_TYPE = 34          # 经典微信语音消息类型号；iLink 实测后修正
DEFAULT_SEND_ITEM_KEY = "voice_item"
DEFAULT_SEND_DATA_KEY = "voice_data"
DEFAULT_SEND_FORMAT = "silk"
DEFAULT_MAX_REPLY_CHARS = 280        # 微信语音一条约上限 60s，280 字合成后接近满

_DOWNLOAD_TIMEOUT_SECONDS = 20


class VoiceError(Exception):
    """微信语音链路失败的统一基类；消息可直接进日志，绝不含语音内容或凭据。"""


class VoiceDownloadError(VoiceError):
    """语音数据拿不到：缺下载凭证、网络失败或数据损坏。"""


class VoiceDecodeError(VoiceError):
    """语音字节解不开：未知编码、缺依赖或解码器报错。"""


class VoiceASRError(VoiceError):
    """语音识别不可用或识别结果为空。"""


class VoiceSynthesisError(VoiceError):
    """语音回复合成/编码失败；上层降级纯文字。"""


def _csv_env(name: str, default: str) -> list[str]:
    return [key.strip() for key in os.getenv(name, default).split(",") if key.strip()]


# ---- 收侧：解析 → 下载 → 解码 → 识别 ----

def find_voice_item(message: dict) -> dict | None:
    """在一条消息里找语音负载：非文本 item 下、配置 key（或含 voice 的 key）的 dict。

    结构自适应：先按 JARVIS_WECHAT_VOICE_ITEM_KEYS 精确匹配，再退化为
    「key 名含 voice 且值是 dict」。文本 item（type==1）永远不会被误判。
    """
    if not isinstance(message, dict):
        return None
    items = message.get("item_list")
    if not isinstance(items, list):
        return None
    exact_keys = _csv_env("JARVIS_WECHAT_VOICE_ITEM_KEYS", DEFAULT_VOICE_ITEM_KEYS)
    for item in items:
        if not isinstance(item, dict) or item.get("type") == 1:
            continue
        for key in exact_keys:
            value = item.get(key)
            if isinstance(value, dict):
                return value
        for key, value in item.items():
            if isinstance(value, dict) and "voice" in str(key).lower():
                return value
    return None


def _default_http_get(url: str) -> bytes:
    response = httpx.get(url, timeout=_DOWNLOAD_TIMEOUT_SECONDS, trust_env=False,
                         follow_redirects=True)
    response.raise_for_status()
    return response.content


def download_voice(voice_item: dict, http_get=None) -> bytes:
    """按下载凭证取语音字节：内嵌 base64 数据优先，其次 URL 下载。"""
    if not isinstance(voice_item, dict):
        raise VoiceDownloadError("语音负载不是结构化数据")
    for key in _csv_env("JARVIS_WECHAT_VOICE_DATA_KEYS", DEFAULT_VOICE_DATA_KEYS):
        value = voice_item.get(key)
        if isinstance(value, (bytes, bytearray)) and value:
            return bytes(value)
        if isinstance(value, str) and value:
            try:
                decoded = base64.b64decode(value, validate=True)
            except (binascii.Error, ValueError):
                continue
            if decoded:
                return decoded
    for key in _csv_env("JARVIS_WECHAT_VOICE_URL_KEYS", DEFAULT_VOICE_URL_KEYS):
        url = voice_item.get(key)
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            try:
                data = (http_get or _default_http_get)(url)
            except VoiceError:
                raise
            except Exception as exc:
                raise VoiceDownloadError("语音下载失败") from exc
            if not data:
                raise VoiceDownloadError("语音下载内容为空")
            return bytes(data)
    raise VoiceDownloadError("语音负载缺少可用的下载凭证")


def pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    """裸 PCM（16bit/单声道）包上 wav 头，产出可直接播放/送识别的文件字节。"""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm)
    return buffer.getvalue()


def _pcm_duration_ms(pcm: bytes, sample_rate: int) -> int:
    return max(1, int(len(pcm) / 2 / sample_rate * 1000))


def _wav_duration_ms(data: bytes) -> int:
    try:
        with wave.open(io.BytesIO(data), "rb") as reader:
            frames = reader.getnframes()
            rate = reader.getframerate() or 1
        return max(1, int(frames / rate * 1000))
    except Exception as exc:
        raise VoiceDecodeError("wav 头解析失败") from exc


def _silk_to_wav(data: bytes) -> tuple[bytes, int]:
    try:
        import pilk
    except ImportError as exc:
        raise VoiceDecodeError("缺少 silk 解码依赖 pilk") from exc
    with tempfile.TemporaryDirectory(prefix="jws-wxvoice-") as tmp:
        silk_path = os.path.join(tmp, "in.silk")
        pcm_path = os.path.join(tmp, "out.pcm")
        with open(silk_path, "wb") as handle:
            handle.write(data)
        try:
            pilk.decode(silk_path, pcm_path, pcm_rate=ASR_SAMPLE_RATE)
        except Exception as exc:
            raise VoiceDecodeError("silk 解码失败") from exc
        with open(pcm_path, "rb") as handle:
            pcm = handle.read()
    if not pcm:
        raise VoiceDecodeError("silk 解码无输出")
    return pcm_to_wav(pcm, ASR_SAMPLE_RATE), _pcm_duration_ms(pcm, ASR_SAMPLE_RATE)


def decode_to_wav(data: bytes) -> tuple[bytes, int]:
    """任意来源的语音字节 → (wav 字节, 时长 ms)。认 wav 透传、silk v3 解码。"""
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise VoiceDecodeError("语音数据为空")
    data = bytes(data)
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return data, _wav_duration_ms(data)
    if b"#!SILK_V3" in data[:16]:
        return _silk_to_wav(data)
    raise VoiceDecodeError("未知语音编码（既不是 wav 也不是 silk v3）")


DASHSCOPE_ASR_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/"
    "multimodal-generation/generation"
)
DASHSCOPE_ASR_MODEL = "qwen3-asr-flash"
_ASR_TIMEOUT_SECONDS = 60


class DashScopeASR:
    """阿里云百炼语音识别（wav 字节 → 文本），自带最小 HTTP 调用。

    端点与模型 2026-08-13 用真实 key 实测：multimodal-generation +
    qwen3-asr-flash + base64 data URI 上行 → HTTP 200，识别文字逐字正确
    （候选 qwen-audio-asr 已下线，返回 Model not exist）。key 只从环境变量
    读；无 key 或请求失败抛 VoiceASRError，上层给用户「没听清」降级提示。
    """

    def __init__(self, http_post=None) -> None:
        self._http_post = http_post

    @staticmethod
    def _extract_text(payload: dict) -> str:
        try:
            content = payload["output"]["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            return ""
        if not isinstance(content, list):
            return ""
        parts = [
            part.get("text") for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ]
        return "".join(parts).strip()

    def __call__(self, wav_bytes: bytes) -> str:
        key = os.getenv("DASHSCOPE_API_KEY", "").strip()
        if not key:
            raise VoiceASRError("语音识别未配置（缺 DASHSCOPE_API_KEY）")
        body = {
            "model": os.getenv("JARVIS_DASHSCOPE_ASR_MODEL", DASHSCOPE_ASR_MODEL),
            "input": {"messages": [
                {"role": "system", "content": [{"text": ""}]},
                {"role": "user", "content": [{
                    "audio": "data:audio/wav;base64,"
                             + base64.b64encode(wav_bytes).decode("ascii"),
                }]},
            ]},
            "parameters": {"asr_options": {"enable_lid": True, "enable_itn": False}},
        }
        url = os.getenv("JARVIS_DASHSCOPE_ASR_URL", DASHSCOPE_ASR_URL)
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        try:
            if self._http_post is not None:
                payload = self._http_post(url, headers=headers, json=body)
            else:
                response = httpx.post(
                    url, timeout=_ASR_TIMEOUT_SECONDS, trust_env=False,
                    headers=headers, json=body,
                )
                response.raise_for_status()
                payload = response.json()
        except VoiceError:
            raise
        except Exception as exc:
            # 上游异常细节可能含请求回显，只留类名，绝不透传。
            raise VoiceASRError("语音识别请求失败") from exc
        text = self._extract_text(payload if isinstance(payload, dict) else {})
        if not text:
            raise VoiceASRError("识别结果为空")
        return text


# ---- 发侧：净化 → 合成 → silk 编码 → 打包 sendmessage item ----

def synthesize_pcm(text: str, *, session_factory=None) -> bytes:
    """回答文字 → MiniMax 流式 TTS → PCM(24k/16bit/单声道)。

    同步封装：微信回复在工作池线程里跑，线程内起独立事件循环即可。
    """
    clean = speakable(text or "").strip()
    if not clean:
        raise VoiceSynthesisError("没有可朗读的内容")
    max_chars = int(os.getenv("JARVIS_WECHAT_VOICE_MAX_REPLY_CHARS",
                              str(DEFAULT_MAX_REPLY_CHARS)))
    clean = clean[:max_chars]

    async def _run() -> bytes:
        session = (session_factory or TTSSession)()
        chunks: list[bytes] = []
        try:
            await session.connect()
            await session.speak(clean)
            await session.finish()
            async for chunk in session.audio_chunks():
                chunks.append(chunk)
        finally:
            await session.close()
        return b"".join(chunks)

    try:
        pcm = asyncio.run(_run())
    except TTSError as exc:
        raise VoiceSynthesisError(str(exc)) from exc
    except VoiceError:
        raise
    except Exception as exc:
        raise VoiceSynthesisError("语音合成失败") from exc
    if not pcm:
        raise VoiceSynthesisError("语音合成无音频")
    return pcm


def encode_silk(pcm: bytes, sample_rate: int = TTS_SAMPLE_RATE) -> tuple[bytes, int]:
    """PCM → 微信系 silk v3（tencent 变体）；返回 (silk 字节, 时长 ms)。"""
    if not isinstance(pcm, (bytes, bytearray)) or not pcm:
        raise VoiceSynthesisError("没有可编码的音频")
    try:
        import pilk
    except ImportError as exc:
        raise VoiceSynthesisError("缺少 silk 编码依赖 pilk") from exc
    pcm = bytes(pcm)
    with tempfile.TemporaryDirectory(prefix="jws-wxvoice-") as tmp:
        pcm_path = os.path.join(tmp, "in.pcm")
        silk_path = os.path.join(tmp, "out.silk")
        with open(pcm_path, "wb") as handle:
            handle.write(pcm)
        try:
            pilk.encode(pcm_path, silk_path, pcm_rate=sample_rate, tencent=True)
        except Exception as exc:
            raise VoiceSynthesisError("silk 编码失败") from exc
        with open(silk_path, "rb") as handle:
            silk = handle.read()
    if not silk:
        raise VoiceSynthesisError("silk 编码无输出")
    return silk, _pcm_duration_ms(pcm, sample_rate)


def build_voice_items(silk: bytes, duration_ms: int) -> list[dict]:
    """打包 sendmessage 的语音 item_list；类型号与 key 名可配置，实样到位改默认值。"""
    item_type = int(os.getenv("JARVIS_WECHAT_VOICE_SEND_ITEM_TYPE",
                              str(DEFAULT_SEND_ITEM_TYPE)))
    item_key = os.getenv("JARVIS_WECHAT_VOICE_SEND_ITEM_KEY", DEFAULT_SEND_ITEM_KEY)
    data_key = os.getenv("JARVIS_WECHAT_VOICE_SEND_DATA_KEY", DEFAULT_SEND_DATA_KEY)
    voice_format = os.getenv("JARVIS_WECHAT_VOICE_SEND_FORMAT", DEFAULT_SEND_FORMAT)
    return [{
        "type": item_type,
        item_key: {
            data_key: base64.b64encode(silk).decode("ascii"),
            "format": voice_format,
            "duration": int(duration_ms),
        },
    }]


class VoicePipeline:
    """收/发两侧的一站式管线；每一环都可注入替身，供确定性单测与联调换件。"""

    def __init__(self, *, http_get=None, decoder=None, asr=None,
                 synthesizer=None, encoder=None) -> None:
        self._http_get = http_get
        self._decoder = decoder or decode_to_wav
        self._asr = asr or DashScopeASR()
        self._synthesizer = synthesizer or synthesize_pcm
        self._encoder = encoder or encode_silk

    def transcribe(self, voice_item: dict) -> str:
        """语音负载 → 文本；任何一环失败抛对应 VoiceError 子类。"""
        data = download_voice(voice_item, http_get=self._http_get)
        wav, _duration_ms = self._decoder(data)
        text = self._asr(wav)
        if not isinstance(text, str) or not text.strip():
            raise VoiceASRError("识别结果为空")
        return text.strip()

    def voice_reply_items(self, text: str) -> list[dict]:
        """回答文字 → 可直接放进 sendmessage 的语音 item_list。"""
        pcm = self._synthesizer(text)
        silk, duration_ms = self._encoder(pcm)
        return build_voice_items(silk, duration_ms)
