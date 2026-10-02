"""会议纪要网关：/api/meeting/stream WebSocket 路由。

上行：
- JSON {"type": "init", "csrf": "...", "title": "..."}  连接后第一条；web 会话必须带 CSRF
- 二进制帧：首字节是声道头（0x00=麦克风「我」/ 0x01=系统回环「对方」），
  其余是 PCM 音频（16-bit 小端、单声道、16kHz），双路各转发一条百炼流式识别
- JSON {"type": "stop"}  结束会议：转写定稿 → Agent 总结 → 入库 → 发邮件
- JSON {"type": "ping"}  心跳

下行：
- JSON：ready{meeting_id} / partial{speaker,text}（识别中灰字）/
  segment{speaker,ts,text}（定稿转写行）/ live_points{text}（会中实时要点，节流）/
  asr_unavailable{message}（识别彻底不可用）/
  stopped{segments,empty}（采集结束，开始总结）/ minutes{meeting_id,text,message} /
  mail{ok,to,message} / error / pong

与语音通话网关（gateway.py）的区别：没有回合与 TTS——只攒转写；识别断线不降级
浏览器识别（会议没有降级路），而是自动重建识别会话续传（长会议单条 WSS 会超时），
连续重建超限才宣告不可用。连接断开（桌面端崩溃/合盖）时服务端照样完成
总结与邮件，已录内容不丢。
"""
from __future__ import annotations

import asyncio
import json
import logging

from starlette.websockets import WebSocket, WebSocketDisconnect

from jarvis import meeting as meeting_mod
from jarvis.voice import asr as asr_mod

log = logging.getLogger("jarvis")

CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_REQUEST = 4400
CLOSE_CONFLICT = 4409
_INIT_TIMEOUT = 15.0
_BUFFER_CAP = 320_000       # 每路建连前最多攒 ~10s@16kHz PCM16，超了丢最旧的
_MAX_ASR_RESTARTS = 6       # 每路识别自动重建上限；再坏就宣告不可用
CHANNEL_ME = 0
CHANNEL_OTHERS = 1
ASR_UNAVAILABLE_MESSAGE = "服务端语音识别不可用（请检查 DASHSCOPE_API_KEY），会议无法转写"
LIVE_MIN_SEGMENTS = 6        # 距上次实时要点至少新增 6 段发言才再总结
LIVE_MIN_INTERVAL = 90.0     # 且至少间隔 90 秒（双闸防成本螺旋）
_LIVE_TAIL_CHARS = 3200      # 增量小结只看最近这么多字的转写

# 测试可整体替换为假会话工厂；生产即百炼 paraformer WSS 客户端
create_asr_session = asr_mod.ASRSession


class _ChannelPipeline:
    """一路说话人的流式识别：增量下字幕、定稿进转写；断线自动重建续传。"""

    def __init__(self, conn: "_MeetingConn", speaker: str) -> None:
        self.conn = conn
        self.speaker = speaker
        self.session = None
        self.failed = False
        self.restarts = 0
        self._connecting: asyncio.Task | None = None
        self._reader: asyncio.Task | None = None
        self._buffer: list[bytes] = []
        self._buffered = 0

    async def feed(self, chunk: bytes) -> None:
        if self.failed or not chunk:
            return
        if self.session is None:
            self._buffer.append(chunk)
            self._buffered += len(chunk)
            while self._buffered > _BUFFER_CAP and len(self._buffer) > 1:
                self._buffered -= len(self._buffer.pop(0))
            if self._connecting is None:
                self._connecting = asyncio.create_task(self._connect())
            return
        try:
            await self.session.send_audio(chunk)
        except asr_mod.ASRError:
            await self._restart(self.session)

    async def close(self, flush: bool = False) -> None:
        if flush and self.session is not None and self._reader is not None:
            # 正常 stop：先让识别端冲刷尾句（finish-task），再收摊，最后一句不丢
            try:
                await asyncio.wait_for(self.session.finish(), 3.0)
                await asyncio.wait_for(asyncio.shield(self._reader), 2.0)
            except BaseException:
                pass
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
            await self._restart()
            return
        # 先把积压帧按序补发完再发布 session：发布过早会让 feed() 的新帧
        # 插到未补发的旧帧前面，开场几秒的音频乱序进识别（补发期间新帧仍进缓冲）。
        try:
            while self._buffer:
                chunk = self._buffer.pop(0)
                self._buffered -= len(chunk)
                await session.send_audio(chunk)
        except asr_mod.ASRError:
            self._buffer.clear()
            self._buffered = 0
            try:
                await session.close()
            except Exception:
                pass
            await self._restart()
            return
        self.session = session
        self._reader = asyncio.create_task(self._read_results(session))

    async def _read_results(self, session) -> None:
        try:
            async for result in session.results():
                self.restarts = 0   # 会话真出结果了：重连预算按「连续失败」计，不累计终身
                if result.is_final:
                    text = result.text.strip()
                    if text:
                        entry = self.conn.session.add_segment(self.speaker, text)
                        if entry is not None:
                            await self.conn.send_json({
                                "type": "segment", "speaker": self.speaker,
                                "ts": entry["ts"], "text": entry["text"],
                            }, best_effort=True)
                            self.conn.maybe_live_summary()
                elif result.text:
                    await self.conn.send_json(
                        {"type": "partial", "speaker": self.speaker, "text": result.text},
                        best_effort=True)
        except asr_mod.ASRError:
            await self._restart(session)

    async def _restart(self, failed_session=None) -> None:
        """识别链路坏了：关旧会话、下一帧触发重建；超限才宣告失败（一次性通知）。

        迟到的旧会话报错（重建后孤儿 reader 才炸）不重复计数，否则一次真实断线
        会烧掉两格重连预算，长会议几次例行超时就被误判为「彻底不可用」。"""
        if self.failed:
            return
        if failed_session is not None and failed_session is not self.session:
            return
        current = asyncio.current_task()
        for task in (self._connecting, self._reader):
            if task is not None and task is not current and not task.done():
                task.cancel()
        if self.session is not None:
            try:
                await self.session.close()
            except Exception:
                pass
            self.session = None
        self._connecting = None
        self._reader = None
        self.restarts += 1
        if self.restarts > _MAX_ASR_RESTARTS:
            self.failed = True
            self._buffer.clear()
            self._buffered = 0
            await self.conn.asr_unavailable()


class _MeetingConn:
    """一条会议连接：双路识别管道 + 下行帧序 + 实时要点节流。"""

    def __init__(self, ws: WebSocket, session: meeting_mod.MeetingSession,
                 live_compose=None) -> None:
        self.ws = ws
        self.session = session
        self.live_compose = live_compose
        self._send_lock = asyncio.Lock()
        self._asr_notified = False
        self._live_task: asyncio.Task | None = None
        self._live_last = asyncio.get_running_loop().time()
        self._live_segments = 0
        self.pipelines = {
            CHANNEL_ME: _ChannelPipeline(self, meeting_mod.SPEAKER_ME),
            CHANNEL_OTHERS: _ChannelPipeline(self, meeting_mod.SPEAKER_OTHERS),
        }

    def maybe_live_summary(self) -> None:
        """会中实时要点：新增发言够多且间隔够久才增量小结（双闸防成本螺旋）。"""
        if self.live_compose is None:
            return
        if self._live_task is not None and not self._live_task.done():
            return
        now = asyncio.get_running_loop().time()
        segments = len(self.session.segments)
        if segments - self._live_segments < LIVE_MIN_SEGMENTS:
            return
        if now - self._live_last < LIVE_MIN_INTERVAL:
            return
        self._live_segments = segments
        self._live_last = now
        self._live_task = asyncio.create_task(self._run_live_summary())

    async def _run_live_summary(self) -> None:
        tail = self.session.transcript_text()[-_LIVE_TAIL_CHARS:]
        try:
            text = await asyncio.to_thread(self.live_compose, self.session.user_id, tail)
        except Exception as exc:
            log.warning("meeting live summary failed: %s", type(exc).__name__)
            return
        text = (text or "").strip()
        if not text or text.upper() == "PASS":
            return
        await self.send_json({"type": "live_points", "text": text}, best_effort=True)

    async def send_json(self, obj: dict, best_effort: bool = False) -> None:
        try:
            async with self._send_lock:
                await self.ws.send_text(json.dumps(obj, ensure_ascii=False))
        except Exception:
            if not best_effort:
                raise

    async def asr_unavailable(self) -> None:
        """双路共用一次性通知：识别彻底不可用（如缺 key），录了也转不出字。"""
        if self._asr_notified:
            return
        self._asr_notified = True
        await self.send_json(
            {"type": "asr_unavailable", "message": ASR_UNAVAILABLE_MESSAGE}, best_effort=True)

    async def feed(self, frame: bytes) -> None:
        if len(frame) < 2:
            return
        channel, pcm = frame[0], frame[1:]
        if channel == CHANNEL_OTHERS:
            self.session.record_others(pcm)   # 落盘供离线说话人分离（失败静默）
        pipeline = self.pipelines.get(channel)
        if pipeline is not None:
            await pipeline.feed(pcm)

    async def close_pipelines(self, flush: bool = False) -> None:
        # 两路并行收摊：flush 各自最多等 ~5s，串行会把 stop 延迟翻倍
        await asyncio.gather(*(p.close(flush) for p in self.pipelines.values()))


def register_meeting(app, *, cookie_name: str, accounts, finalize, live_compose=None) -> None:
    """在 FastAPI 应用上挂 /api/meeting/stream。

    finalize(user_id, session) 是 server.py 注入的同步回调（线程里跑）：
    总结 → 入库 → 发邮件，返回
    {"ok", "empty"?, "meeting_id"?, "minutes"?, "message"?, "mail"?}。
    live_compose(user_id, transcript_tail) 可选：会中实时要点的增量小结。
    """

    def _principal_for(ws: WebSocket):
        cookie = ws.cookies.get(cookie_name, "")
        if cookie:
            return accounts.principal_for_token(cookie, "web")
        token = ws.headers.get("x-jws-token", "")
        if token:
            return accounts.principal_for_token(token, "desktop")
        return None

    @app.websocket("/api/meeting/stream")
    async def meeting_stream(ws: WebSocket) -> None:
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
                {"type": "error", "code": "csrf", "message": "页面已过期，请刷新后重试"}, ensure_ascii=False))
            await ws.close(code=CLOSE_UNAUTHORIZED)
            return

        session = meeting_mod.active_meetings.start(
            principal.user_id, str(init.get("title", ""))[:meeting_mod.MAX_TITLE_CHARS])
        if session is None:
            await ws.send_text(json.dumps(
                {"type": "error", "code": "busy", "message": "已有一场会议在监控中"},
                ensure_ascii=False))
            await ws.close(code=CLOSE_CONFLICT)
            return
        conn = _MeetingConn(ws, session, live_compose=live_compose)
        graceful = False
        try:
            # ready 也要在 try 里发：此刻客户端可能已掉线，send 抛异常若发生在
            # finally 保护区之外，registry 里这场会议将永远占位（后续全部 4409）。
            await conn.send_json({"type": "ready", "meeting_id": session.id})
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    await conn.feed(message["bytes"])
                    continue
                raw = message.get("text")
                if not raw:
                    continue
                try:
                    data = json.loads(raw)
                except ValueError:
                    continue
                mtype = data.get("type") if isinstance(data, dict) else None
                if mtype == "stop":
                    graceful = True
                    break
                if mtype == "ping":
                    await conn.send_json({"type": "pong"}, best_effort=True)
        except WebSocketDisconnect:
            pass
        finally:
            if conn._live_task is not None and not conn._live_task.done():
                conn._live_task.cancel()
            await conn.close_pipelines(flush=graceful)
            finished = meeting_mod.active_meetings.finish(principal.user_id)
            # 即使桌面端已掉线也要完成总结与邮件（best_effort 下行送不到就算了）
            if finished is not None:
                await conn.send_json({
                    "type": "stopped",
                    "segments": len(finished.segments),
                    "empty": not finished.segments,
                }, best_effort=True)
                try:
                    result = await asyncio.to_thread(finalize, principal.user_id, finished)
                except Exception as exc:
                    log.warning("meeting finalize failed: %s", type(exc).__name__)
                    result = {"ok": False, "message": "纪要生成失败，请稍后在网页端重试"}
                if result.get("empty"):
                    pass  # stopped 帧已带 empty=true，前端有人话提示
                else:
                    await conn.send_json({
                        "type": "minutes",
                        "meeting_id": result.get("meeting_id"),
                        "text": result.get("minutes", ""),
                        "message": result.get("message", ""),
                    }, best_effort=True)
                    mail = result.get("mail")
                    if mail:
                        await conn.send_json({"type": "mail", **mail}, best_effort=True)
            try:
                await ws.close()
            except Exception:
                pass
