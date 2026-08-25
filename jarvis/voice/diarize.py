"""说话人分离（离线）：会议「对方」声道 wav → 按说话人标注的句子列表。

实时识别全线不支持分离（官方能力矩阵），可行路径是录音文件识别三段式：
1) GET /api/v1/uploads?action=getPolicy 领临时存储凭证（300 秒有效）；
2) multipart 表单 POST 到 upload_host，得到 oss:// 临时 URL（48 小时有效）；
3) POST /api/v1/services/audio/asr/transcription（paraformer-v2 +
   diarization_enabled + X-DashScope-Async/OssResourceResolve 头）→ 轮询
   /api/v1/tasks/{id} → 下载 transcription_url，读 sentences[].speaker_id。
全程只需出站 HTTP + DASHSCOPE_API_KEY；任何失败抛 DiarizeError，
上层降级为不分说话人的原始转写（分离是增强，不是必需品）。
"""
import logging
import os
import time
from pathlib import Path

import httpx

log = logging.getLogger("jarvis")

_BASE = "https://dashscope.aliyuncs.com/api/v1"
_MODEL = "paraformer-v2"
_TIMEOUT = 30
DEFAULT_POLL_TIMEOUT = 180.0
_MIN_WAV_BYTES = 320_000       # <10s@16k 的「对方」音频不值得跑分离


class DiarizeError(RuntimeError):
    pass


def _key() -> str:
    key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    if not key:
        raise DiarizeError("说话人分离未配置（缺 DASHSCOPE_API_KEY）")
    return key


def _auth() -> dict:
    return {"Authorization": f"Bearer {_key()}"}


def upload_temp(path: str, *, http=None) -> str:
    """本地 wav → 百炼临时存储，返回 oss:// URL（48 小时有效）。"""
    http = http or httpx
    policy = http.get(f"{_BASE}/uploads", params={"action": "getPolicy", "model": _MODEL},
                      headers=_auth(), timeout=_TIMEOUT, trust_env=False)
    policy.raise_for_status()
    data = policy.json().get("data") or {}
    for field in ("policy", "signature", "upload_dir", "upload_host", "oss_access_key_id"):
        if not data.get(field):
            raise DiarizeError("临时存储凭证不完整")
    name = Path(path).name
    key = f"{data['upload_dir']}/{name}"
    with open(path, "rb") as handle:
        form = {
            "OSSAccessKeyId": data["oss_access_key_id"],
            "policy": data["policy"],
            "Signature": data["signature"],
            "key": key,
            "x-oss-object-acl": data.get("x_oss_object_acl", "private"),
            "x-oss-forbid-overwrite": data.get("x_oss_forbid_overwrite", "true"),
            "success_action_status": "200",
        }
        upload = http.post(data["upload_host"], data=form,
                           files={"file": (name, handle, "audio/wav")},
                           timeout=120, trust_env=False)
    if upload.status_code not in (200, 204):
        raise DiarizeError("音频上传临时存储失败")
    return f"oss://{key}"


def submit(oss_url: str, *, http=None) -> str:
    http = http or httpx
    response = http.post(
        f"{_BASE}/services/audio/asr/transcription",
        headers={**_auth(), "Content-Type": "application/json",
                 "X-DashScope-Async": "enable",
                 "X-DashScope-OssResourceResolve": "enable"},
        json={"model": _MODEL, "input": {"file_urls": [oss_url]},
              "parameters": {"diarization_enabled": True}},
        timeout=_TIMEOUT, trust_env=False)
    response.raise_for_status()
    task_id = ((response.json().get("output") or {}).get("task_id") or "").strip()
    if not task_id:
        raise DiarizeError("转写任务提交失败")
    return task_id


def poll(task_id: str, *, timeout: float = DEFAULT_POLL_TIMEOUT,
         interval: float = 3.0, http=None, sleep=time.sleep) -> list[dict]:
    """等任务完成并下载结果，返回 sentences（含 begin_time/end_time/speaker_id/text）。"""
    http = http or httpx
    deadline = time.monotonic() + timeout
    while True:
        response = http.get(f"{_BASE}/tasks/{task_id}", headers=_auth(),
                            timeout=_TIMEOUT, trust_env=False)
        response.raise_for_status()
        output = response.json().get("output") or {}
        status = output.get("task_status", "")
        if status == "SUCCEEDED":
            results = output.get("results") or []
            url = results[0].get("transcription_url", "") if results else ""
            if not url:
                raise DiarizeError("转写结果地址缺失")
            body = http.get(url, timeout=_TIMEOUT, trust_env=False)
            body.raise_for_status()
            transcripts = body.json().get("transcripts") or []
            sentences = []
            for item in transcripts:
                sentences.extend(item.get("sentences") or [])
            return sentences
        if status in ("FAILED", "CANCELED"):
            raise DiarizeError("转写任务失败")
        if time.monotonic() >= deadline:
            raise DiarizeError("转写任务超时")
        sleep(interval)


def diarize_wav(path: str, *, http=None, timeout: float = DEFAULT_POLL_TIMEOUT,
                sleep=time.sleep) -> list[dict]:
    """一条龙：上传 → 提交 → 轮询。返回 [{start_ms, end_ms, speaker, text}]。

    speaker 是 0 起的整数编号；音频太短直接抛 DiarizeError（不值得烧一次任务）。
    """
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise DiarizeError("会议音频不存在") from exc
    if size < _MIN_WAV_BYTES:
        raise DiarizeError("对方发言太短，跳过说话人分离")
    try:
        oss_url = upload_temp(path, http=http)
        task_id = submit(oss_url, http=http)
        sentences = poll(task_id, timeout=timeout, http=http, sleep=sleep)
    except DiarizeError:
        raise
    except Exception as exc:
        log.warning("diarize failed: %s", type(exc).__name__)
        raise DiarizeError("说话人分离失败") from exc
    out = []
    for s in sentences:
        if not isinstance(s, dict):
            continue
        text = " ".join(str(s.get("text", "")).split())
        if not text:
            continue
        out.append({
            "start_ms": int(s.get("begin_time") or 0),
            "end_ms": int(s.get("end_time") or 0),
            "speaker": int(s.get("speaker_id") or 0),
            "text": text,
        })
    return out
