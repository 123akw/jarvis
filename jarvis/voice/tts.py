"""MiniMax 国内站流式 TTS（WebSocket）客户端。

协议（任务 0 实测 + 官方文档 speech-t2a-websocket）：
- 连接 wss 带 Bearer 鉴权 → 服务端发 connected_success；
- 发 task_start（模型/音色/音频参数）→ 服务端发 task_started；
- 每句发 task_continue，音频以 hex 编码回在 task_continued 事件里；
- 发 task_finish 收尾 → task_finished；失败发 task_failed；
- 没有取消事件：打断 = 直接关连接（close()）。

MINIMAX_API_KEY 只从环境变量读，任何异常信息不携带上游细节或凭据。
"""
from __future__ import annotations

import asyncio
import json
import os

DEFAULT_WSS_URL = "wss://api.minimaxi.com/ws/v1/t2a_v2"
DEFAULT_MODEL = "speech-02-turbo"
DEFAULT_VOICE = "male-qn-qingse"
SAMPLE_RATE = 24000
AUDIO_FORMAT = "pcm"
CHANNELS = 1


class TTSError(Exception):
    """语音合成不可用；消息可直接展示给用户，绝不含凭据或上游响应。"""


def _api_key() -> str:
    key = os.getenv("MINIMAX_API_KEY", "").strip()
    if not key:
        raise TTSError("语音合成未配置")
    return key


class TTSSession:
    """一次回合的合成会话：task_start 一次、task_continue 多句、音频异步流出。"""

    def __init__(self, *, url: str | None = None, model: str | None = None,
                 voice_id: str | None = None, sample_rate: int = SAMPLE_RATE,
                 audio_format: str = AUDIO_FORMAT, timeout: float = 10.0) -> None:
        self.url = url or os.getenv("MINIMAX_TTS_WSS_URL", DEFAULT_WSS_URL)
        self.model = model or os.getenv("MINIMAX_TTS_MODEL", DEFAULT_MODEL)
        self.voice_id = voice_id or os.getenv("MINIMAX_TTS_VOICE", DEFAULT_VOICE)
        self.sample_rate = sample_rate
        self.audio_format = audio_format
        self.timeout = timeout
        self._ws = None
        self._receiver: asyncio.Task | None = None
        self._audio: asyncio.Queue[bytes | None | TTSError] = asyncio.Queue()
        self._closed = False

    async def connect(self) -> None:
        """建立连接并完成 task_start 握手；任何失败统一抛 TTSError。"""
        import websockets

        key = _api_key()
        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(
                    self.url,
                    additional_headers={"Authorization": f"Bearer {key}"},
                    max_size=None,
                ),
                self.timeout,
            )
            hello = json.loads(await asyncio.wait_for(self._ws.recv(), self.timeout))
            if hello.get("event") != "connected_success":
                raise TTSError("语音合成握手失败")
            await self._ws.send(json.dumps({
                "event": "task_start",
                "model": self.model,
                "voice_setting": {"voice_id": self.voice_id, "speed": 1.0},
                "audio_setting": {
                    "sample_rate": self.sample_rate,
                    "format": self.audio_format,
                    "channel": CHANNELS,
                },
            }))
            started = json.loads(await asyncio.wait_for(self._ws.recv(), self.timeout))
            if started.get("event") != "task_started":
                raise TTSError("语音合成任务启动失败")
        except TTSError:
            await self.close()
            raise
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception as exc:
            await self.close()
            raise TTSError("语音合成连接失败") from exc
        self._receiver = asyncio.create_task(self._recv_loop())

    async def speak(self, text: str) -> None:
        """送一句文本去合成；连接已坏时抛 TTSError。"""
        if self._ws is None or self._closed:
            raise TTSError("语音合成会话已关闭")
        try:
            await self._ws.send(json.dumps({"event": "task_continue", "text": text}))
        except Exception as exc:
            raise TTSError("语音合成发送失败") from exc

    async def finish(self) -> None:
        """声明本回合不再有新句子；剩余音频仍会陆续流出。"""
        if self._ws is None or self._closed:
            return
        try:
            await self._ws.send(json.dumps({"event": "task_finish"}))
        except Exception:
            pass

    async def audio_chunks(self):
        """异步产出 PCM 字节块，直到本回合结束；失败抛 TTSError。"""
        while True:
            item = await self._audio.get()
            if item is None:
                return
            if isinstance(item, TTSError):
                raise item
            yield item

    async def close(self) -> None:
        """打断/收尾统一走这里：关连接即取消在途合成（协议无取消事件）。"""
        self._closed = True
        if self._receiver is not None:
            self._receiver.cancel()
            try:
                await self._receiver
            except (asyncio.CancelledError, Exception):
                pass
            self._receiver = None
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    async def _recv_loop(self) -> None:
        try:
            while True:
                msg = json.loads(await self._ws.recv())
                event = msg.get("event")
                audio_hex = (msg.get("data") or {}).get("audio") or ""
                if audio_hex:
                    try:
                        self._audio.put_nowait(bytes.fromhex(audio_hex))
                    except ValueError:
                        pass
                if event == "task_failed":
                    self._audio.put_nowait(TTSError("语音合成失败"))
                    return
                if event == "task_finished":
                    self._audio.put_nowait(None)
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            self._audio.put_nowait(TTSError("语音合成连接中断"))
