"""视觉理解：图片 / 短视频 → 文字描述（百炼 qwen3-vl-flash，base64 直传零依赖）。

与语音识别同一 multimodal-generation 端点、同一 DASHSCOPE_API_KEY：
消息里 {"image": "data:image/png;base64,..."} 或
{"video": "data:video/mp4;base64,...", "fps": 2}。主对话模型（DeepSeek）不认图，
所以这里先把画面转成详细中文描述，注入对话线程供追问——与文档上传同一模式。
"""
import base64
import logging
import os

import httpx

log = logging.getLogger("jarvis")

_ENDPOINT = ("https://dashscope.aliyuncs.com/api/v1/services/aigc/"
             "multimodal-generation/generation")
_TIMEOUT_SECONDS = 90
DEFAULT_VL_MODEL = "qwen3-vl-flash"
MAX_IMAGE_BYTES = 10 * 1024 * 1024   # 与 /api/upload 的 10MB 上限一致
MAX_VIDEO_BYTES = 7 * 1024 * 1024    # base64 后 <10MB 的官方硬限

IMAGE_MIMES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "bmp": "image/bmp", "heic": "image/heic",
}
VIDEO_MIMES = {"mp4": "video/mp4", "mov": "video/quicktime"}

IMAGE_PROMPT = (
    "用中文详细描述这张图片：先一句话概括，再分点说清画面里的关键内容——"
    "有文字就逐字转录（保留原文语言），有图表就读出数据与结论，"
    "有界面/截图就说明是什么软件和状态。不要编造图里没有的信息。")
VIDEO_PROMPT = (
    "用中文详细描述这段视频：先一句话概括，再按时间顺序说清发生了什么、"
    "出现的人物/物体/文字；画面里的文字要转录出来。注意你听不到声音，"
    "只描述画面。不要编造视频里没有的信息。")


class VisionError(RuntimeError):
    """识别失败；message 是可直接展示给用户的人话。"""


def _call(content: list, http_post=None) -> str:
    key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    if not key:
        raise VisionError("图像识别未配置（缺 DASHSCOPE_API_KEY）")
    body = {
        "model": os.getenv("JARVIS_DASHSCOPE_VL_MODEL", DEFAULT_VL_MODEL),
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": {"result_format": "message"},
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
    except VisionError:
        raise
    except Exception as exc:
        # 上游异常细节可能含请求回显，只留类名，绝不透传。
        log.warning("vision request failed: %s", type(exc).__name__)
        raise VisionError("图像识别请求失败，请稍后重试") from exc
    try:
        parts = payload["output"]["choices"][0]["message"]["content"]
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
    except (KeyError, IndexError, TypeError):
        text = ""
    if not text:
        raise VisionError("识别结果为空")
    return text


def image_extension(name: str) -> str | None:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext if ext in IMAGE_MIMES else None


def video_extension(name: str) -> str | None:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext if ext in VIDEO_MIMES else None


def describe_image(data: bytes, ext: str, *, http_post=None) -> str:
    if len(data) > MAX_IMAGE_BYTES:
        raise VisionError("图片超过 10MB，请压缩后再发")
    uri = f"data:{IMAGE_MIMES[ext]};base64," + base64.b64encode(data).decode("ascii")
    return _call([{"image": uri}, {"text": IMAGE_PROMPT}], http_post)


def describe_video(data: bytes, ext: str, *, http_post=None) -> str:
    if len(data) > MAX_VIDEO_BYTES:
        raise VisionError("视频超过 7MB（base64 直传的上限），请剪短或压缩后再发")
    uri = f"data:{VIDEO_MIMES[ext]};base64," + base64.b64encode(data).decode("ascii")
    return _call([{"video": uri, "fps": 2}, {"text": VIDEO_PROMPT}], http_post)
