"""语音通话网关：/api/voice/call WebSocket 路由。

上行：
- JSON {"type": "init", "csrf": "...", "thread_id": "voice"}  连接后第一条；web 会话必须带 CSRF
- 二进制帧：麦克风 PCM 音频（16-bit 小端、单声道、16kHz），转发百炼流式识别
- JSON {"type": "user_text", "text": "..."}  浏览器识别降级通道的转写文本；在途回合立即被打断
- JSON {"type": "interrupt"}  打断在途回合，并丢弃未定稿的识别文字
- JSON {"type": "ping"}  心跳

下行：
- JSON 文本帧：ready / asr_partial（识别中增量，字幕灰字）/ asr_final（断句定稿）/
  asr_fallback（服务端识别不可用，前端切浏览器识别）/ turn_start / token /
  tool_start / tool_result / audio_start / tts_error / turn_end / error / pong
- 二进制帧：TTS PCM 音频块（16-bit 小端、单声道，采样率见 audio_start）

识别链路：二进制帧经 _AsrPipeline 转发百炼（jarvis/voice/asr.py），增量结果实时下发
字幕，断句定稿自动开回合；百炼连不上/无 key → 一次 asr_fallback，前端退回
浏览器 Web Speech API，转写走 user_text，通话不中断。
"""
from __future__ import annotations

import asyncio
import json
import threading
import uuid

from langchain_core.messages import AIMessageChunk, RemoveMessage, SystemMessage, ToolMessage
from starlette.websockets import WebSocket, WebSocketDisconnect

from jarvis.graph import heal_dangling_tool_calls
from jarvis.tenancy import TenantMigrationError, tenant_scope
from jarvis.voice import asr as asr_mod
from jarvis.voice import tts as tts_mod
from jarvis.voice.segment import FirstFastSegmenter, speakable

CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_REQUEST = 4400
_INIT_TIMEOUT = 15.0
_TTS_DRAIN_TIMEOUT = 120.0
_ASR_BUFFER_CAP = 320_000  # 连接建立前最多攒 ~10s@16kHz PCM16，超了丢最旧的
ASR_FALLBACK_MESSAGE = "服务端语音识别暂不可用，已切换浏览器识别"

# 语音回合注入的一次性应答规则（拍板：≤3 句、先结论、口语化、不念 URL/代码/表格）。
# 只在语音网关注入，回合结束即从 checkpoint 摘除——文字聊天 /api/chat 完全不受影响。
VOICE_STYLE_PROMPT = (
    "【语音通话模式·仅本回合有效】你正在和用户语音通话，回答会被合成语音读出来："
    "最多三句话，第一句先给结论；用自然口语，不要书面腔、不要客套铺垫；"
    "禁止念 URL、代码、表格和 Markdown 符号（如 **、#、`），需要提及时用一句话概括；"
    "数字、时间用中文口语说法。")

# 测试可整体替换为假会话工厂；生产即 MiniMax WSS 客户端
create_tts_session = tts_mod.TTSSession

# 网页「⚙ API → 语音」可选音色目录（MiniMax 系统音色的公开子集）
VOICE_CATALOG = [
    {"id": "male-qn-qingse", "name": "青涩青年（默认）"},
    {"id": "male-qn-jingying", "name": "精英青年"},
    {"id": "male-qn-badao", "name": "霸道青年"},
    {"id": "female-shaonv", "name": "少女"},
    {"id": "female-yujie", "name": "御姐"},
    {"id": "female-chengshu", "name": "成熟女声"},
    {"id": "presenter_male", "name": "男主持"},
    {"id": "presenter_female", "name": "女主持"},
]


def tts_prefs_for(user_id) -> dict:
    """读取该用户的音色/语速偏好；没配置或读取失败都返回空（用环境默认）。"""
    from jarvis.tenancy import TenantStore
    kwargs = {}
    try:
        with tenant_scope(user_id):
            store = TenantStore()
            voice = store.get_pref("tts_voice")
            speed = store.get_pref("tts_speed")
        if voice:
            kwargs["voice_id"] = voice
        if speed:
            kwargs["speed"] = float(speed)
    except Exception:
        return {}
    return kwargs
# 测试可整体替换为假会话工厂；生产即百炼 paraformer WSS 客户端
create_asr_session = asr_mod.ASRSession


class _AsrPipeline:
    """服务端流式识别管道：二进制帧→百炼，增量下字幕，定稿开回合，坏了降级。"""

    def __init__(self, call: "_CallSession") -> None:
        self.call = call
        self.session = None
        self.failed = False
        self._connecting: asyncio.Task | None = None
        self._reader: asyncio.Task | None = None
        self._buffer: list[bytes] = []   # 识别连接建立前先攒帧，接上后一次性补发
        self._buffered = 0
        self._pending_partial = ""       # 已下发字幕但尚未定稿的识别文字

    async def feed(self, chunk: bytes) -> None:
        """收一帧麦克风音频。第一帧触发建连；降级后静默丢弃。"""
        if self.failed or not chunk:
            return
        if self.session is None:
            self._buffer.append(chunk)
            self._buffered += len(chunk)
            while self._buffered > _ASR_BUFFER_CAP and len(self._buffer) > 1:
                self._buffered -= len(self._buffer.pop(0))
            if self._connecting is None:
                self._connecting = asyncio.create_task(self._connect())
            return
        try:
            await self.session.send_audio(chunk)
        except asr_mod.ASRError:
            await self._fallback()

    async def discard_pending(self) -> None:
        """打断时丢弃未定稿的识别文字：不进回合，并清掉前端灰字字幕。"""
        if self._pending_partial:
            self._pending_partial = ""
            await self.call.send_json({"type": "asr_partial", "text": ""}, best_effort=True)

    async def close(self) -> None:
        for task in (self._connecting, self._reader):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except BaseException:
                    pass
        if self.session is not None:
            try:
                await self.session.close()
            except Exception:
                pass
            self.session = None

    async def _connect(self) -> None:
        try:
            session = create_asr_session()
            await session.connect()
        except asr_mod.ASRError:
            await self._fallback()
            return
        self.session = session
        try:
            for chunk in self._buffer:
                await session.send_audio(chunk)
        except asr_mod.ASRError:
            await self._fallback()
            return
        finally:
            self._buffer.clear()
            self._buffered = 0
        self._reader = asyncio.create_task(self._read_results(session))

    async def _read_results(self, session) -> None:
        try:
            async for result in session.results():
                if result.is_final:
                    self._pending_partial = ""
                    text = result.text.strip()
                    if text:
                        await self.call.send_json(
                            {"type": "asr_final", "text": text}, best_effort=True)
                        await self.call.start_turn(text)
                elif result.text:
                    self._pending_partial = result.text
                    await self.call.send_json(
                        {"type": "asr_partial", "text": result.text}, best_effort=True)
        except asr_mod.ASRError:
            await self._fallback()

    async def _fallback(self) -> None:
        """识别链路任何一环坏掉：一次性告知前端切浏览器识别，此后丢帧。"""
        if self.failed:
            return
        self.failed = True
        self._buffer.clear()
        self._buffered = 0
        self._pending_partial = ""
        await self.call.send_json(
            {"type": "asr_fallback", "message": ASR_FALLBACK_MESSAGE}, best_effort=True)
        if self.session is not None:
            try:
                await self.session.close()
            except Exception:
                pass
            self.session = None


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
        seg = FirstFastSegmenter()
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
        style_id = f"voice-style-{uuid.uuid4().hex}"
        try:
            with tenant_scope(self.call.user_id):
                with self.call.bundle_for(self.call.user_id) as bundle:
                    heal_dangling_tool_calls(bundle.agent, checkpoint_id)
                    config = {"configurable": {"thread_id": checkpoint_id}}
                    try:
                        stream = bundle.agent.stream(
                            {"messages": [
                                SystemMessage(content=VOICE_STYLE_PROMPT, id=style_id),
                                {"role": "user", "content": self.text},
                            ]},
                            config=config, stream_mode="messages")
                        for chunk, _meta in stream:
                            if self.stop.is_set():
                                break
                            self._emit("chunk", chunk)
                    finally:
                        self._scrub_style(bundle.agent, config, style_id)
        except Exception as exc:  # 不把上游细节带回前端，run() 里统一转公开文案
            self._emit("error", exc)
            return
        self._emit("done", None)

    @staticmethod
    def _scrub_style(agent, config: dict, style_id: str) -> None:
        """语音风格指令只服务本回合：回合一结束（含被打断）就从 checkpoint 摘掉，
        后续文字聊天的上下文里零残留。摘除失败无害——指令措辞已限定「仅本回合」，
        且 /api/history 只回放 human/ai 消息，不会出现在网页回放里。"""
        try:
            agent.update_state(config, {"messages": [RemoveMessage(id=style_id)]})
        except Exception:
            pass

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
            prefs = tts_prefs_for(self.call.user_id)
            # 无偏好时保持零参调用：测试注入的假工厂不必接受 kwargs
            session = create_tts_session(**prefs) if prefs else create_tts_session()
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
        self.asr = _AsrPipeline(self)

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
                    await session.asr.feed(message["bytes"])
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
                    await session.asr.discard_pending()
                elif mtype == "ping":
                    await session.send_json({"type": "pong"}, best_effort=True)
        except WebSocketDisconnect:
            pass
        finally:
            await session.interrupt()
            await session.asr.close()
