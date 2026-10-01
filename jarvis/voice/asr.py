"""百炼 paraformer 实时语音识别（WebSocket 直连，不引 dashscope SDK）。

协议（官方文档 paraformer-client-events / paraformer-server-events 核实）：
- 连接 wss 带 `Authorization: bearer <key>` → 发 run-task（model/format/sample_rate）
  → 服务端回 task-started；
- 之后二进制帧直接上行 PCM 音频；识别结果以 result-generated 事件回来，
  payload.output.sentence 携带 text 与 sentence_end（false=识别中增量，true=断句定稿），
  heartbeat=true 的句子是保活占位，直接丢弃；
- 发 finish-task 收尾 → task-finished；出错回 task-failed。

DASHSCOPE_API_KEY 只从环境变量读；异常信息不携带上游细节或凭据。
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import dataclass, field

DEFAULT_WSS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
DEFAULT_MODEL = "paraformer-realtime-v2"
SAMPLE_RATE = 16000
AUDIO_FORMAT = "pcm"
CHANNELS = 1


class ASRError(Exception):
    """语音识别不可用；消息可直接展示给用户，绝不含凭据或上游响应。"""


@dataclass
class ASRResult:
    """一次识别结果：is_final=False 为识别中增量，True 为断句定稿。

    end_ms：本句最后一个字在音频流里的结束时刻（毫秒，自任务开始计；服务端没给则 None）。
    网关拿它和「已上行音频总时长」相减，就是「说完→定稿」的判停等待（不参与相等比较）。"""

    text: str
    is_final: bool
    end_ms: int | None = field(default=None, compare=False)


def _api_key() -> str:
    key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    if not key:
        raise ASRError("语音识别未配置")
    return key


def _sentence_end_ms(sentence: dict) -> int | None:
    """定稿句的说话结束时刻：优先取最后一个字的 end_time（不含句尾静音），否则取句级 end_time。"""
    words = sentence.get("words")
    candidates = []
    if isinstance(words, list) and words and isinstance(words[-1], dict):
        candidates.append(words[-1].get("end_time"))
    candidates.append(sentence.get("end_time"))
    for value in candidates:
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            return int(value)
    return None


class ASRSession:
    """一条识别连接：run-task 一次、二进制音频多帧、结果异步流出。

    max_sentence_silence：VAD 断句的静音阈值（毫秒，百炼允许 200–6000，缺省 800）。
    通话要的是「说完就答」，网关会传更短的值；会议转写不传，沿用服务端默认。"""

    def __init__(self, *, url: str | None = None, model: str | None = None,
                 sample_rate: int = SAMPLE_RATE, audio_format: str = AUDIO_FORMAT,
                 timeout: float = 10.0, max_sentence_silence: int | None = None) -> None:
        self.url = url or os.getenv("DASHSCOPE_ASR_WSS_URL", DEFAULT_WSS_URL)
        self.model = model or os.getenv("DASHSCOPE_ASR_MODEL", DEFAULT_MODEL)
        self.sample_rate = sample_rate
        self.audio_format = audio_format
        self.timeout = timeout
        self.max_sentence_silence = (
            None if max_sentence_silence is None
            else min(6000, max(200, int(max_sentence_silence))))
        self.task_id = uuid.uuid4().hex
        self._ws = None
        self._receiver: asyncio.Task | None = None
        self._results: asyncio.Queue[ASRResult | None | ASRError] = asyncio.Queue()
        self._closed = False

    async def connect(self) -> None:
        """建立连接、发 run-task、等 task-started；任何失败统一抛 ASRError。"""
        import websockets

        key = _api_key()
        parameters = {
            "format": self.audio_format,
            "sample_rate": self.sample_rate,
            "language_hints": ["zh", "en"],
        }
        if self.max_sentence_silence is not None:
            parameters["max_sentence_silence"] = self.max_sentence_silence
        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(
                    self.url,
                    additional_headers={"Authorization": f"bearer {key}"},
                    max_size=None,
                ),
                self.timeout,
            )
            await self._ws.send(json.dumps({
                "header": {
                    "action": "run-task",
                    "task_id": self.task_id,
                    "streaming": "duplex",
                },
                "payload": {
                    "task_group": "audio",
                    "task": "asr",
                    "function": "recognition",
                    "model": self.model,
                    "parameters": parameters,
                    "input": {},
                },
            }))
            started = json.loads(await asyncio.wait_for(self._ws.recv(), self.timeout))
            event = (started.get("header") or {}).get("event")
            if event == "task-failed":
                raise ASRError("语音识别任务启动失败")
            if event != "task-started":
                raise ASRError("语音识别握手失败")
        except ASRError:
            await self.close()
            raise
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception as exc:
            await self.close()
            raise ASRError("语音识别连接失败") from exc
        self._receiver = asyncio.create_task(self._recv_loop())

    async def send_audio(self, chunk: bytes) -> None:
        """上行一帧 PCM 音频；连接已坏时抛 ASRError。"""
        if self._ws is None or self._closed:
            raise ASRError("语音识别会话已关闭")
        try:
            await self._ws.send(chunk)
        except Exception as exc:
            raise ASRError("语音识别发送失败") from exc

    async def finish(self) -> None:
        """声明音频送完；剩余识别结果仍会陆续流出，直到 task-finished。"""
        if self._ws is None or self._closed:
            return
        try:
            await self._ws.send(json.dumps({
                "header": {
                    "action": "finish-task",
                    "task_id": self.task_id,
                    "streaming": "duplex",
                },
                "payload": {"input": {}},
            }))
        except Exception:
            pass

    async def results(self):
        """异步产出 ASRResult，直到会话结束；识别失败/断连抛 ASRError。"""
        while True:
            item = await self._results.get()
            if item is None:
                return
            if isinstance(item, ASRError):
                raise item
            yield item

    async def close(self) -> None:
        """打断/收尾统一走这里：关连接即放弃在途识别。"""
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
                header = msg.get("header") or {}
                event = header.get("event")
                if event == "result-generated":
                    sentence = ((msg.get("payload") or {}).get("output") or {}).get("sentence") or {}
                    if sentence.get("heartbeat"):
                        continue
                    text = str(sentence.get("text") or "")
                    if text:
                        is_final = bool(sentence.get("sentence_end"))
                        self._results.put_nowait(ASRResult(
                            text=text, is_final=is_final,
                            end_ms=_sentence_end_ms(sentence) if is_final else None))
                elif event == "task-failed":
                    self._results.put_nowait(ASRError("语音识别失败"))
                    return
                elif event == "task-finished":
                    self._results.put_nowait(None)
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            self._results.put_nowait(ASRError("语音识别连接中断"))
