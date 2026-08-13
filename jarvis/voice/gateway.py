"""语音通话网关：/api/voice/call WebSocket 路由。

上行（JSON 文本帧）：
- {"type": "init", "csrf": "...", "thread_id": "voice"}  连接后第一条；web 会话必须带 CSRF
- {"type": "user_text", "text": "..."}  一次说话的转写文本；在途回合立即被打断
- {"type": "interrupt"}  只打断，不开新回合
- {"type": "ping"}  心跳

下行：
- JSON 文本帧：ready / turn_start / token / tool_start / tool_result /
  audio_start / tts_error / turn_end / error / pong
- 二进制帧：PCM 音频块（16-bit 小端、单声道，采样率见 audio_start）

音频上行：国内站没有服务端 ASR（任务 0 实测），收到二进制帧回 asr_unavailable，
转写由浏览器 Web Speech API 完成后走 user_text。
"""
from __future__ import annotations

import asyncio
import json
import threading

from langchain_core.messages import AIMessageChunk, ToolMessage
from starlette.websockets import WebSocket, WebSocketDisconnect

from jarvis.graph import heal_dangling_tool_calls
from jarvis.tenancy import TenantMigrationError, tenant_scope
from jarvis.voice import tts as tts_mod
from jarvis.voice.segment import SentenceSegmenter, speakable

CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_REQUEST = 4400
_INIT_TIMEOUT = 15.0
_TTS_DRAIN_TIMEOUT = 120.0

# 测试可整体替换为假会话工厂；生产即 MiniMax WSS 客户端
create_tts_session = tts_mod.TTSSession


class _Turn:
    """一个通话回合：agent 流（线程）→ 切句 → TTS → 音频下行。"""

    def __init__(self, call: "_CallSession", text: str) -> None:
        self.call = call
        self.text = text
        self.stop = threading.Event()
        self.queue: asyncio.Queue = asyncio.Queue()
        self.loop = asyncio.get_running_loop()
        self.tts: tts_mod.TTSSession | None = None
        self.tts_open: asyncio.Task | None = None
        self.forward: asyncio.Task | None = None
        self.tts_failed = False
        self.interrupted = False

    async def run(self) -> None:
        seg = SentenceSegmenter()
        seen_calls: set[str] = set()
        try:
            await self.call.send_json({"type": "turn_start"})
            self.call.count_chat()
            try:
                checkpoint_id = await asyncio.to_thread(self.call.upsert_thread, self.text)
            except TenantMigrationError:
                await self.call.send_json({"type": "error", "message": "个人数据迁移失败"})
                return
            self.tts_open = asyncio.create_task(self._open_tts())
            worker = threading.Thread(target=self._agent_thread, args=(checkpoint_id,), daemon=True)
            worker.start()
            while True:
                kind, payload = await self.queue.get()
                if kind == "chunk":
                    await self._handle_chunk(payload, seg, seen_calls)
                elif kind == "error":
                    await self.call.send_json(
                        {"type": "error", "message": self.call.public_error(payload)})
                    break
                else:  # done
                    tail = seg.flush()
                    if tail:
                        await self._speak(tail)
                    break
            await self._drain_tts()
        except asyncio.CancelledError:
            self.interrupted = True
            raise
        finally:
            self.stop.set()
            await self._teardown_tts()
            await self.call.send_json(
                {"type": "turn_end", "interrupted": self.interrupted}, best_effort=True)

    # ---- agent 流（在线程里跑同步生成器，stop 事件负责打断） ----

    def _agent_thread(self, checkpoint_id: str) -> None:
        try:
            with tenant_scope(self.call.user_id):
                with self.call.bundle_for(self.call.user_id) as bundle:
                    heal_dangling_tool_calls(bundle.agent, checkpoint_id)
                    stream = bundle.agent.stream(
                        {"messages": [{"role": "user", "content": self.text}]},
                        config={"configurable": {"thread_id": checkpoint_id}},
                        stream_mode="messages")
                    for chunk, _meta in stream:
                        if self.stop.is_set():
                            break
                        self._emit("chunk", chunk)
        except Exception as exc:  # 不把上游细节带回前端，run() 里统一转公开文案
            self._emit("error", exc)
            return
        self._emit("done", None)

    def _emit(self, kind: str, payload) -> None:
        try:
            self.loop.call_soon_threadsafe(self.queue.put_nowait, (kind, payload))
        except RuntimeError:
            pass  # 事件循环已关闭

    async def _handle_chunk(self, chunk, seg: SentenceSegmenter, seen_calls: set[str]) -> None:
        if isinstance(chunk, ToolMessage):
            await self.call.send_json({"type": "tool_result", "name": chunk.name})
            return
        if not isinstance(chunk, AIMessageChunk):
            return
        for tc in chunk.tool_call_chunks or []:
            name, cid = tc.get("name"), tc.get("id")
            if name and cid and cid not in seen_calls:
                seen_calls.add(cid)
                await self.call.send_json({"type": "tool_start", "name": name})
        text = self.call.chunk_text(chunk.content)
        if text:
            await self.call.send_json({"type": "token", "text": text})
            for sentence in seg.push(text):
                await self._speak(sentence)

    # ---- TTS 管道（连接失败/中途失败 → 一次 tts_error，纯文字继续） ----

    async def _open_tts(self) -> None:
        try:
            session = create_tts_session()
            await session.connect()
        except tts_mod.TTSError:
            await self._tts_down()
            return
        if self.stop.is_set():
            await session.close()
            return
        self.tts = session
        await self.call.send_json({
            "type": "audio_start", "format": session.audio_format,
            "sample_rate": session.sample_rate, "channels": tts_mod.CHANNELS,
        }, best_effort=True)
        self.forward = asyncio.create_task(self._forward_audio(session))

    async def _tts_down(self) -> None:
        if not self.tts_failed:
            self.tts_failed = True
            await self.call.send_json(
                {"type": "tts_error", "message": "语音合成暂不可用，本回合降级为纯文字"},
                best_effort=True)

    async def _speak(self, sentence: str) -> None:
        if self.tts_failed:
            return
        if self.tts_open is not None:
            await self.tts_open
        if self.tts is None or self.tts_failed:
            return
        clean = speakable(sentence)
        if not clean:
            return
        try:
            await self.tts.speak(clean)
        except tts_mod.TTSError:
            await self._tts_down()

    async def _forward_audio(self, session: tts_mod.TTSSession) -> None:
        try:
            async for chunk in session.audio_chunks():
                await self.call.send_bytes(chunk)
        except tts_mod.TTSError:
            await self._tts_down()

    async def _drain_tts(self) -> None:
        if self.tts_open is not None:
            await self.tts_open
        if self.tts is None:
            return
        await self.tts.finish()
        if self.forward is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self.forward), _TTS_DRAIN_TIMEOUT)
            except asyncio.TimeoutError:
                self.forward.cancel()

    async def _teardown_tts(self) -> None:
        for task in (self.tts_open, self.forward):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except BaseException:
                    pass
        if self.tts is not None:
            try:
                await self.tts.close()
            except Exception:
                pass


class _CallSession:
    """一条通话连接：管当前回合的生命周期与下行帧序。"""

    def __init__(self, ws: WebSocket, principal, thread_alias: str, *, bundle_for,
                 tenant_store, chunk_text, public_error, count_chat) -> None:
        self.ws = ws
        self.user_id = principal.user_id
        self.thread_alias = thread_alias
        self.bundle_for = bundle_for
        self.tenant_store = tenant_store
        self.chunk_text = chunk_text
        self.public_error = public_error
        self.count_chat = count_chat
        self._send_lock = asyncio.Lock()
        self._turn_task: asyncio.Task | None = None

    def upsert_thread(self, first_message: str) -> str:
        with tenant_scope(self.user_id):
            thread = self.tenant_store().upsert_thread(self.thread_alias, first_message)
        return thread.checkpoint_thread_id

    async def send_json(self, obj: dict, best_effort: bool = False) -> None:
        try:
            async with self._send_lock:
                await self.ws.send_text(json.dumps(obj, ensure_ascii=False))
        except Exception:
            if not best_effort:
                raise

    async def send_bytes(self, data: bytes) -> None:
        try:
            async with self._send_lock:
                await self.ws.send_bytes(data)
        except Exception:
            pass  # 客户端掉线由主循环统一收尾

    async def start_turn(self, text: str) -> None:
        await self.interrupt()  # 新语音到达 → 立即取消在途回合（打断）
        self._turn_task = asyncio.create_task(_Turn(self, text).run())

    async def interrupt(self) -> None:
        task, self._turn_task = self._turn_task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass


def register_voice(app, *, cookie_name: str, accounts, bundle_for, tenant_store,
                   chunk_text, public_error, count_chat=lambda: None) -> None:
    """在 FastAPI 应用上挂 /api/voice/call；依赖全部由 server.py 注入。"""

    def _principal_for(ws: WebSocket):
        cookie = ws.cookies.get(cookie_name, "")
        if cookie:
            return accounts.principal_for_token(cookie, "web")
        token = ws.headers.get("x-jws-token", "")
        if token:
            return accounts.principal_for_token(token, "desktop")
        return None

    @app.websocket("/api/voice/call")
    async def voice_call(ws: WebSocket) -> None:
        principal = _principal_for(ws)
        await ws.accept()
        if principal is None:
            await ws.send_text(json.dumps(
                {"type": "error", "code": "unauthorized", "message": "未登录"}, ensure_ascii=False))
            await ws.close(code=CLOSE_UNAUTHORIZED)
            return
        try:
            init = json.loads(await asyncio.wait_for(ws.receive_text(), _INIT_TIMEOUT))
        except WebSocketDisconnect:
            return
        except Exception:
            await ws.close(code=CLOSE_BAD_REQUEST)
            return
        if not isinstance(init, dict) or init.get("type") != "init":
            await ws.close(code=CLOSE_BAD_REQUEST)
            return
        if principal.transport == "web" and not accounts.csrf_valid(
                principal, ws.cookies.get(cookie_name, ""), str(init.get("csrf", ""))):
            await ws.send_text(json.dumps(
                {"type": "error", "code": "csrf", "message": "CSRF 校验失败"}, ensure_ascii=False))
            await ws.close(code=CLOSE_UNAUTHORIZED)
            return

        alias = str(init.get("thread_id") or "voice")[:64]
        session = _CallSession(
            ws, principal, alias, bundle_for=bundle_for, tenant_store=tenant_store,
            chunk_text=chunk_text, public_error=public_error, count_chat=count_chat)
        await session.send_json({"type": "ready"})
        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    await session.send_json({
                        "type": "error", "code": "asr_unavailable",
                        "message": "服务端不支持音频转写，请使用浏览器语音识别或文字",
                    }, best_effort=True)
                    continue
                raw = message.get("text")
                if not raw:
                    continue
                try:
                    data = json.loads(raw)
                except ValueError:
                    continue
                mtype = data.get("type") if isinstance(data, dict) else None
                if mtype == "user_text":
                    utterance = str(data.get("text", "")).strip()
                    if utterance:
                        await session.start_turn(utterance)
                elif mtype == "interrupt":
                    await session.interrupt()
                elif mtype == "ping":
                    await session.send_json({"type": "pong"}, best_effort=True)
        except WebSocketDisconnect:
            pass
        finally:
            await session.interrupt()
