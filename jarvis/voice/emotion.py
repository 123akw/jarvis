"""语音情绪识别：一段 wav → 7 类情绪标签（qwen3-asr-flash 固定附带，零额外配置）。

与 wechat_voice.DashScopeASR 同一端点同一模型：识别文字我们不要，只读响应里
output.choices[0].message.annotations[0].emotion（surprised/neutral/happy/sad/
disgusted/angry/fearful）。无 key 或任何失败都安静返回空串——情绪是锦上添花，
绝不拖垮通话主链路。
"""
import base64
import logging
import os

import httpx

from jarvis.wechat_voice import pcm_to_wav as _shared_pcm_to_wav

log = logging.getLogger("jarvis")

_ENDPOINT = ("https://dashscope.aliyuncs.com/api/v1/services/aigc/"
             "multimodal-generation/generation")
_TIMEOUT_SECONDS = 30
_MAX_WAV_BYTES = 2_000_000   # ~60s@16k，单句语音远小于此

EMOTION_LABELS = {
    "happy": "开心", "sad": "低落", "angry": "生气", "surprised": "惊讶",
    "fearful": "紧张", "disgusted": "嫌弃", "neutral": "平静",
}


def pcm_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes:
    """复用 wechat_voice 的同一实现（wav 头逻辑只维护一份）。"""
    return _shared_pcm_to_wav(pcm, sample_rate)


def extract_emotion(payload: dict) -> str:
    try:
        annotations = payload["output"]["choices"][0]["message"]["annotations"]
    except (KeyError, IndexError, TypeError):
        return ""
    for item in annotations if isinstance(annotations, list) else []:
        if isinstance(item, dict) and item.get("emotion"):
            emotion = str(item["emotion"]).strip().lower()
            return emotion if emotion in EMOTION_LABELS else ""
    return ""


def detect_emotion(wav_bytes: bytes, *, http_post=None) -> str:
    """同步调用（放线程里跑）；返回情绪英文标签或空串，绝不抛异常。"""
    key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    if not key or not wav_bytes or len(wav_bytes) > _MAX_WAV_BYTES:
        return ""
    body = {
        "model": os.getenv("JARVIS_DASHSCOPE_ASR_MODEL", "qwen3-asr-flash"),
        "input": {"messages": [
            {"role": "system", "content": [{"text": ""}]},
            {"role": "user", "content": [{
                "audio": "data:audio/wav;base64,"
                         + base64.b64encode(wav_bytes).decode("ascii"),
            }]},
        ]},
        "parameters": {"asr_options": {"enable_lid": True, "enable_itn": False}},
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        if http_post is not None:
            payload = http_post(_ENDPOINT, headers=headers, json=body)
        else:
            response = httpx.post(_ENDPOINT, timeout=_TIMEOUT_SECONDS, trust_env=False,
                                  headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:
        log.warning("emotion detect failed: %s", type(exc).__name__)
        return ""
    return extract_emotion(payload if isinstance(payload, dict) else {})
