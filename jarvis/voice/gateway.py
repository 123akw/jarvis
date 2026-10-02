"""语音通话网关：/api/voice/call WebSocket 路由。

上行：
- JSON {"type": "init", "csrf": "...", "thread_id": "voice"}  连接后第一条；web 会话必须带 CSRF
- 二进制帧：麦克风 PCM 音频（16-bit 小端、单声道、16kHz），转发百炼流式识别
- JSON {"type": "user_text", "text": "..."}  浏览器识别降级通道的转写文本；在途回合立即被打断
- JSON {"type": "interrupt", "played_ms": 1234}  打断在途回合，并丢弃未定稿的识别文字；
  played_ms（可选）= 本回合音频实际已播放的毫秒数，网关据此算出主人听到哪一句
- JSON {"type": "ping"}  心跳

下行：
- JSON 文本帧：ready / asr_partial（识别中增量，字幕灰字）/ asr_final（断句定稿）/
  asr_fallback（服务端识别不可用，前端切浏览器识别）/ turn_start / token /
  tool_start / tool_result / filler（工具慢时的垫话，只出声不入记录）/ audio_start /
  tts_error / latency / cut（被打断：heard=主人大概听到的回答前缀，字幕在此截断）/
  turn_end / error / pong
  （latency：回合分段耗时，毫秒，自定稿/user_text 到达网关起算；前端可忽略，只作观测）
- 二进制帧：TTS PCM 音频块（16-bit 小端、单声道，采样率见 audio_start）

识别链路：二进制帧经 _AsrPipeline 转发百炼（jarvis/voice/asr.py），增量结果实时下发
字幕，断句定稿自动开回合；百炼连不上/无 key → 一次 asr_fallback，前端退回
浏览器 Web Speech API，转写走 user_text，通话不中断。

延迟与体验（实测数据见本轮提交说明；复测 scripts/voice_smoke.py --live --turns 2、
scripts/asr_smoke.py --live --vad --wav x.wav [--max-silence 500]）：
- 判停：通话用 500ms 静音断句（百炼缺省 800ms），「说完→定稿」省 ~300ms；
- 续说不抢答：定稿后用户又开口、而本回合还没出声 → 立即取消本回合等用户说完，
  迟迟等不到新定稿则按原话重开（兜底，回合不丢）；
- 开口即预热：每句话的第一个识别增量到达时，后台预热该用户的 agent 运行时；
- 回声抑制：播放中识别到的文字若与本回合正在念的 TTS 文本高度重合，判为回声，
  不出字幕、不触发前端打断、不开回合。

说人话（jarvis/voice/spoken.py）：
- 本回合 system 指令 = 场景规则 + 口语规则 + 语气感知 + 「上一句被打断在哪」；
- 每句送 TTS 前过 to_spoken()（去 Markdown/表情/网址，时间日期温度按中文口语）；
- 工具 0.7s 还没回来、模型也还没开口 → 先说一句垫话（几种轮换、偶尔不说、每回合至多一次）；
- 被打断：按前端回报的已播放时长 + TTS 句子边界，算出主人听到哪儿（cut 帧 + 下一回合提示）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import threading
import time
import uuid

from langchain_core.messages import AIMessageChunk, RemoveMessage, SystemMessage, ToolMessage
from starlette.websockets import WebSocket, WebSocketDisconnect

from jarvis.graph import heal_dangling_tool_calls, thread_turn
from jarvis.tenancy import TenantMigrationError, tenant_scope
from jarvis.voice import asr as asr_mod
from jarvis.voice import spoken
from jarvis.voice import tts as tts_mod
from jarvis.voice.emotion import EMOTION_LABELS, detect_emotion, pcm_to_wav, tts_style_for
from jarvis.voice.segment import FirstFastSegmenter

CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_REQUEST = 4400
_INIT_TIMEOUT = 15.0
_TTS_DRAIN_TIMEOUT = 120.0
_ASR_BUFFER_CAP = 320_000  # 连接建立前最多攒 ~10s@16kHz PCM16，超了丢最旧的
_EMOTION_TAIL_CAP = 480_000     # 情绪检测取本句最后 ~15s 音频
_EMOTION_MIN_PCM_BYTES = 12_800  # 不足 ~0.4s 的音频不值得送情绪检测
ASR_FALLBACK_MESSAGE = "服务端语音识别暂不可用，已切换浏览器识别"
_PCM_BYTES_PER_MS = 32           # 16kHz × 16bit 单声道

# 通话判停静音阈值（ms）。百炼缺省 800；实测 800→500 把「说完→定稿」从 1163ms 降到 863ms。
# 会议转写不走这里（meeting_gateway 保持服务端缺省，宁慢勿碎）。
CALL_ASR_SILENCE_MS = 500
_RESUME_GRACE_S = 2.5            # 续说取消后，用户静默这么久仍无新定稿 → 按原话重开
_ECHO_TAIL_S = 1.0               # 估算播放结束后继续防回声的余量（混响 + 识别滞后）
_ECHO_AFTER_BARGE_S = 1.5        # 前端打断停播后，在途的回声识别结果还会陆续到
_ECHO_TEXT_CAP = 400             # 回声比对只看本回合最近念出的这么多字
_ECHO_BIGRAM_RATIO = 0.6
_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)

# 垫话：工具调用发出后这么久还没结果、模型也还没开口，就先说一句（真人管家的「我查一下」）。
# 几种轮换、不连续重复；_FILLER_SKIP_RATE 的概率干脆不说，免得每次都一个腔调。
_FILLER_AFTER_S = 0.7
_FILLER_SKIP_RATE = 0.25
FILLERS = ("好，我查一下。", "稍等哈。", "我看看。", "嗯，我查查。", "马上，稍等一下。")

log = logging.getLogger("jarvis.voice")

# 语音回合注入的一次性应答规则：唯一出处在 scenes.py 的「管家模式」（默认场景），
# 这里只是兼容别名——调措辞去 scenes.py 改，不要在两处各维护一份中文散文。
from jarvis.voice.scenes import scene_prompt as _scene_prompt  # noqa: E402

VOICE_STYLE_PROMPT = _scene_prompt("butler")

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
def _call_silence_ms() -> int:
    raw = os.getenv("DASHSCOPE_ASR_MAX_SILENCE_MS", "").strip()
    try:
        return int(raw) if raw else CALL_ASR_SILENCE_MS
    except ValueError:
        return CALL_ASR_SILENCE_MS


def _call_asr_session():
    """通话专用识别会话：短静音判停（可用 DASHSCOPE_ASR_MAX_SILENCE_MS 调，200–6000）。"""
    return asr_mod.ASRSession(max_sentence_silence=_call_silence_ms())


# 测试可整体替换为假会话工厂；生产即百炼 paraformer WSS 客户端
create_asr_session = _call_asr_session


def looks_like_echo(heard: str, spoken: str) -> bool:
    """识别文字是否像「麦克风收回来的 TTS 播放声」：与正在念的文本高度重合。
    短于 4 字的看是否为原文子串；更长的看字二元组命中率（容忍识别错字）。"""
    h = _NON_WORD.sub("", heard).lower()
    s = _NON_WORD.sub("", spoken).lower()
    if not h or not s:
        return False
    if len(h) < 4:
        return h in s
    grams = [h[i:i + 2] for i in range(len(h) - 1)]
    hits = sum(1 for g in grams if g in s)
    return hits / len(grams) >= _ECHO_BIGRAM_RATIO


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
        self._utter = bytearray()        # 本句音频尾部缓冲：定稿后送情绪检测
        self._sent_bytes = 0             # 已送进当前识别连接的音频字节（换算音频时间轴）

    async def feed(self, chunk: bytes) -> None:
        """收一帧麦克风音频。第一帧触发建连；降级后静默丢弃。"""
        if self.failed or not chunk:
            return
        self._utter.extend(chunk)
        if len(self._utter) > _EMOTION_TAIL_CAP:
            del self._utter[:len(self._utter) - _EMOTION_TAIL_CAP]
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
            self._sent_bytes += len(chunk)
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
        # 先按序补发积压帧再发布 session：发布过早会让新帧插到旧帧前面，
        # 建连窗口内说的第一句话以乱序 PCM 进识别（补发期间新帧仍走缓冲）。
        try:
            while self._buffer:
                chunk = self._buffer.pop(0)
                self._buffered -= len(chunk)
                await session.send_audio(chunk)
                self._sent_bytes += len(chunk)
        except asr_mod.ASRError:
            self._buffer.clear()
            self._buffered = 0
            await self._fallback()
            return
        self.session = session
        self._reader = asyncio.create_task(self._read_results(session))

    async def _read_results(self, session) -> None:
        try:
            async for result in session.results():
                if (result.text or "").strip() and self.call.is_echo(result.text):
                    # 播放中的 TTS 被麦克风收回来又被识别：不出字幕、不打断、不开回合
                    if result.is_final:
                        self._utter.clear()
                        await self.discard_pending()
                    continue
                if result.is_final:
                    self._pending_partial = ""
                    utter_pcm = bytes(self._utter)
                    self._utter.clear()
                    text = result.text.strip()
                    if not _NON_WORD.sub("", text):
                        # 只有标点（噪声被识别成「。」之类）：不开空回合，清掉灰字即可
                        await self.call.send_json({"type": "asr_partial", "text": ""}, best_effort=True)
                        continue
                    if text:
                        if len(utter_pcm) >= _EMOTION_MIN_PCM_BYTES:
                            self.call.spawn_emotion(utter_pcm)
                        await self.call.send_json(
                            {"type": "asr_final", "text": text}, best_effort=True)
                        await self.call.start_turn(text, vad_wait_ms=self.vad_wait_ms(result))
                elif result.text:
                    starting = not self._pending_partial
                    self._pending_partial = result.text
                    await self.call.send_json(
                        {"type": "asr_partial", "text": result.text}, best_effort=True)
                    await self.call.on_speech(starting)
        except asr_mod.ASRError:
            await self._fallback()

    def vad_wait_ms(self, result) -> int | None:
        """「说完→定稿」判停等待：定稿到达时已上行的音频时长 − 末字结束时刻。"""
        end_ms = getattr(result, "end_ms", None)
        if end_ms is None:
            return None
        wait = int(self._sent_bytes / _PCM_BYTES_PER_MS) - int(end_ms)
        return wait if 0 <= wait <= 10_000 else None

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
        await self.call.restart_resumed()  # 续说取消的那句话不能因识别断线而丢掉


class _Said:
    """送进 TTS 的一句：原文（字幕口径）+ 已收到的音频字节数 + 是否合成完毕。"""

    __slots__ = ("text", "audio", "done", "filler")

    def __init__(self, text: str, filler: bool = False) -> None:
        self.text = text
        self.audio = 0
        self.done = False
        self.filler = filler


class _Turn:
    """一个通话回合：agent 流（线程）→ 切句 → TTS → 音频下行。"""

    def __init__(self, call: "_CallSession", text: str, vad_wait_ms: int | None = None) -> None:
        self.call = call
        self.text = text
        self.t0 = time.monotonic()
        self.marks: dict[str, int] = {}
        if vad_wait_ms is not None:
            self.marks["vad_wait"] = vad_wait_ms
        self.stop = threading.Event()
        self.queue: asyncio.Queue = asyncio.Queue()
        self.loop = asyncio.get_running_loop()
        self.tts: tts_mod.TTSSession | None = None
        self.tts_open: asyncio.Task | None = None
        self.forward: asyncio.Task | None = None
        self.tts_failed = False
        self.interrupted = False
        self.said_text = False
        self.said: list[_Said] = []        # 送进 TTS 的句子（按序），音频按句子边界记账
        self._audio_idx = 0                # 正在收音频的那一句
        self.played_bytes: int | None = None   # 被打断时前端回报/网关估算的已播放字节
        self.sample_rate = tts_mod.SAMPLE_RATE
        self._filler_due: float | None = None
        self._filler_used = False

    @property
    def committed(self) -> bool:
        """已经开口（音频已下行；TTS 坏了则以文字已下行为准）：此后用户再说话算打断，不算续说。"""
        return "first_audio" in self.marks or (self.tts_failed and self.said_text)

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
            style_prompt = self.call.take_style_prompt()
            # TTS 建连（~450ms）与 LLM 首 token（600–1900ms）并行，不在关键路径上；
            # 先放 agent 线程起跑（实测把建连提前反而让 agent 晚起 5–10ms）
            self.tts_open = asyncio.create_task(self._open_tts())
            worker = threading.Thread(
                target=self._agent_thread, args=(checkpoint_id, style_prompt), daemon=True)
            worker.start()
            self._mark("agent_start")
            while True:
                item = await self._next_event()
                if item is None:           # 垫话到点：工具还没回来、模型也还没开口
                    await self._say_filler()
                    continue
                kind, payload = item
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
            if self.interrupted and "first_audio" in self.marks:   # 纯文字降级时字幕全看得到，不截
                await self._report_cut()
            await self._teardown_tts()
            await self._report_latency()
            await self.call.send_json(
                {"type": "turn_end", "interrupted": self.interrupted}, best_effort=True)

    async def _next_event(self):
        """取 agent 流的下一件事；有垫话排着时最多等到点，到点返回 None。"""
        if self._filler_due is None:
            return await self.queue.get()
        timeout = self._filler_due - time.monotonic()
        if timeout > 0:
            try:
                return await asyncio.wait_for(self.queue.get(), timeout)
            except asyncio.TimeoutError:
                pass
        self._filler_due = None
        return None

    # ---- 分段延迟观测 ----

    def _mark(self, name: str) -> None:
        """记一个里程碑（同名只记第一次），毫秒，自回合创建（定稿到达网关）起算。"""
        if name not in self.marks:
            self.marks[name] = int((time.monotonic() - self.t0) * 1000)

    async def _report_latency(self) -> None:
        if not self.marks:
            return
        extra = ""
        if "vad_wait" in self.marks and "first_audio" in self.marks:
            # 端到端：用户说完最后一个字 → 第一块音频下行
            extra = f" e2e={self.marks['vad_wait'] + self.marks['first_audio']}"
        log.info("voice turn latency interrupted=%s %s%s", self.interrupted,
                 " ".join(f"{k}={v}" for k, v in self.marks.items()), extra)
        await self.call.send_json(
            {"type": "latency", "interrupted": self.interrupted, **self.marks}, best_effort=True)

    # ---- agent 流（在线程里跑同步生成器，stop 事件负责打断） ----

    def _agent_thread(self, checkpoint_id: str, style_prompt: str) -> None:
        style_id = f"voice-style-{uuid.uuid4().hex}"
        try:
            # 回合锁：与网页文字聊天等共用同一 checkpoint 线程时不并发写（见 graph.thread_turn）
            with tenant_scope(self.call.user_id), thread_turn(checkpoint_id):
                with self.call.bundle_for(self.call.user_id) as bundle:
                    heal_dangling_tool_calls(bundle.agent, checkpoint_id)
                    config = {"configurable": {"thread_id": checkpoint_id}}
                    try:
                        stream = bundle.agent.stream(
                            {"messages": [
                                SystemMessage(content=style_prompt, id=style_id),
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

    async def _handle_chunk(self, chunk, seg: FirstFastSegmenter, seen_calls: set[str]) -> None:
        if isinstance(chunk, ToolMessage):
            self._mark("tool_end")
            self._filler_due = None        # 工具及时回来了：不用垫话
            await self.call.send_json({"type": "tool_result", "name": chunk.name})
            return
        if not isinstance(chunk, AIMessageChunk):
            return
        for tc in chunk.tool_call_chunks or []:
            name, cid = tc.get("name"), tc.get("id")
            if name and cid and cid not in seen_calls:
                seen_calls.add(cid)
                self._mark("tool_start")
                self._arm_filler()
                event = {"type": "tool_start", "name": name}
                try:   # 插件工具（含第三方）：附所属插件的图标与名字，前端没收录时显示它
                    from jarvis.plugins import tool_display
                    label = tool_display(name)
                except Exception:
                    label = None
                if label:
                    event["label"] = label
                await self.call.send_json(event)
        text = self.call.chunk_text(chunk.content)
        if text:
            self._mark("llm_first_token")
            self.said_text = True
            self._filler_due = None
            await self.call.send_json({"type": "token", "text": text})
            for sentence in seg.push(text):
                await self._speak(sentence)

    # ---- 垫话 ----

    def _arm_filler(self) -> None:
        """工具调用发出：模型还没开口、本回合没垫过话 → 排一句垫话，_FILLER_AFTER_S 后到点。"""
        if self._filler_used or self.said_text or self.tts_failed or self._filler_due is not None:
            return
        self._filler_due = time.monotonic() + _FILLER_AFTER_S

    async def _say_filler(self) -> None:
        if self._filler_used or self.said_text or self.tts_failed:
            return
        self._filler_used = True           # 同一回合至多一次（含「这次决定不说」）
        text = self.call.pick_filler()
        if not text:
            return
        self._mark("filler")
        await self.call.send_json({"type": "filler", "text": text}, best_effort=True)
        await self._speak(text, filler=True)

    # ---- TTS 管道（连接失败/中途失败 → 一次 tts_error，纯文字继续） ----

    async def _open_tts(self) -> None:
        try:
            prefs = {**tts_prefs_for(self.call.user_id), **self.call.tts_style()}
            # 无偏好时保持零参调用：测试注入的假工厂不必接受 kwargs
            session = create_tts_session(**prefs) if prefs else create_tts_session()
            session.mark_sentences = True   # 句子边界：打断时据此算主人听到哪儿
            await session.connect()
        except tts_mod.TTSError:
            await self._tts_down()
            return
        if self.stop.is_set():
            await session.close()
            return
        self._mark("tts_ready")
        self.tts = session
        self.sample_rate = session.sample_rate or tts_mod.SAMPLE_RATE
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

    async def _speak(self, sentence: str, filler: bool = False) -> None:
        if not filler:
            self._mark("first_segment")
        if self.tts_failed:
            return
        if self.tts_open is not None:
            await self.tts_open
        if self.tts is None or self.tts_failed:
            return
        clean = spoken.to_spoken(sentence)
        if not clean:
            return
        try:
            await self.tts.speak(clean)
            self.said.append(_Said(sentence, filler))
            if not filler:
                self._mark("first_tts_send")
            self.call.note_spoken(clean)
        except tts_mod.TTSError:
            await self._tts_down()

    async def _forward_audio(self, session: tts_mod.TTSSession) -> None:
        try:
            async for chunk in session.audio_chunks():
                if not chunk:              # 句子边界：这一句合成完了
                    if self._audio_idx < len(self.said):
                        self.said[self._audio_idx].done = True
                    self._audio_idx += 1
                    continue
                self._mark("first_audio")
                if self._audio_idx < len(self.said):
                    self.said[self._audio_idx].audio += len(chunk)
                self.call.note_audio(len(chunk), session.sample_rate)
                await self.call.send_bytes(chunk)
        except tts_mod.TTSError:
            await self._tts_down()

    # ---- 被打断：主人听到哪儿 ----

    def heard_text(self, played_bytes: int) -> str:
        """已播放字节 → 主人大概听到的回答前缀（字幕口径，不含垫话）。
        整句播完的算全听到；正在播的那句按字节比例截取（语速均匀的近似）。"""
        out = []
        for said in self.said:
            if played_bytes <= 0 or said.audio <= 0:   # 这句还没出声：一个字也没听到
                break
            if played_bytes < said.audio:
                if not said.filler:
                    out.append(said.text[:int(len(said.text) * played_bytes / said.audio)])
                break
            if not said.filler:
                out.append(said.text)      # 整句播完（合成中的句子：收到的都播完了，按整句近似）
            played_bytes -= said.audio
            if not said.done:
                break
        return "".join(out)

    async def _report_cut(self) -> None:
        played = self.played_bytes
        if played is None:
            played = self.call.estimate_played_bytes(self)
        heard = self.heard_text(played)
        self.call.note_cut(heard)
        await self.call.send_json({"type": "cut", "heard": heard}, best_effort=True)

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
        self._turn: _Turn | None = None
        self.asr = _AsrPipeline(self)
        self._warm_task: asyncio.Task | None = None
        self._resume_text = ""            # 续说取消的原话（等新定稿；等不到就重开）
        self._resume_watch: asyncio.Task | None = None
        self._last_speech = 0.0
        self._spoken = ""                 # 本回合已送 TTS 的文字（回声比对）
        self._play_end = 0.0              # 估算的客户端播放结束时刻（monotonic）
        self._echo_until = 0.0
        self.scene_id = "butler"
        self.last_emotion = ""
        self._emotion_task: asyncio.Task | None = None
        self._cut_heard: str | None = None   # 上一回合被打断时主人听到的前缀（只用一次）
        self._last_filler = ""
        self._rng = random.Random()

    def style_prompt(self) -> str:
        """本回合注入的应答规则：场景化规则 + 口语规则 + 语气感知 + 上一句被打断在哪（若有）。"""
        from jarvis.voice import scenes
        parts = [scenes.scene_prompt(self.scene_id), spoken.SPOKEN_RULES,
                 spoken.emotion_hint(self.last_emotion)]
        if self._cut_heard is not None:
            parts.append(spoken.interrupted_hint(self._cut_heard))
        return "".join(part for part in parts if part)

    def take_style_prompt(self) -> str:
        """取本回合的应答规则；「被打断」提示只跟下一回合，取完即清。"""
        prompt = self.style_prompt()
        self._cut_heard = None
        return prompt

    def tts_style(self) -> dict:
        """本回合 TTS 语气：场景自带（如晚安电台更慢更柔）为底，主人情绪微调语速；
        场景已定语气标签时不被情绪覆盖。"""
        from jarvis.voice import scenes
        style = scenes.scene_tts(self.scene_id)
        mood = tts_style_for(self.last_emotion)
        if mood:
            style.setdefault("emotion", mood["emotion"])
            style["speed_scale"] = round(style.get("speed_scale", 1.0) * mood["speed_scale"], 3)
        return style

    def pick_filler(self) -> str:
        """挑一句垫话：偶尔干脆不说；不和上一次重复。"""
        if self._rng.random() < _FILLER_SKIP_RATE:
            return ""
        choices = [f for f in FILLERS if f != self._last_filler] or list(FILLERS)
        self._last_filler = self._rng.choice(choices)
        return self._last_filler

    def note_cut(self, heard: str) -> None:
        self._cut_heard = heard

    def estimate_played_bytes(self, turn: "_Turn") -> int:
        """前端没回报已播放时长时的估算：已下行音频 − 估计还没播完的部分。"""
        total = sum(s.audio for s in turn.said)
        unplayed = max(0.0, self._play_end - time.monotonic()) * 2 * max(1, turn.sample_rate)
        return max(0, int(total - unplayed))

    def spawn_emotion(self, pcm: bytes) -> None:
        """情绪检测最多一件在途（只有最新结果有意义），并持有引用防 GC 半途回收。"""
        if self._emotion_task is not None and not self._emotion_task.done():
            return
        self._emotion_task = asyncio.create_task(self.check_emotion(pcm))

    def cancel_emotion(self) -> None:
        if self._emotion_task is not None and not self._emotion_task.done():
            self._emotion_task.cancel()

    async def check_emotion(self, pcm: bytes) -> None:
        """把刚定稿的一句话送情绪检测（异步旁路，绝不拖慢回合）。"""
        try:
            result = await asyncio.to_thread(detect_emotion, pcm_to_wav(pcm))
        except Exception:
            return
        if not result:
            return
        self.last_emotion = result
        await self.send_json({"type": "emotion", "emotion": result,
                              "label": EMOTION_LABELS.get(result, result)}, best_effort=True)

    def set_scene(self, scene_id: str) -> dict | None:
        """切换场景（下一回合生效）并保存为用户偏好；未知场景返回 None。"""
        from jarvis.voice import scenes
        scene = scenes.scene_by_id(scene_id)
        if scene is None:
            return None
        self.scene_id = scene["id"]
        try:
            from jarvis.tenancy import TenantStore
            with tenant_scope(self.user_id):
                TenantStore().set_pref("voice_scene", None if scene["id"] == "butler" else scene["id"])
        except Exception:
            pass  # 偏好存不上不影响本通电话
        return scene

    def load_scene_pref(self) -> None:
        try:
            from jarvis.tenancy import TenantStore
            from jarvis.voice import scenes
            with tenant_scope(self.user_id):
                saved = TenantStore().get_pref("voice_scene")
            if saved and scenes.scene_by_id(saved) is not None:
                self.scene_id = saved
        except Exception:
            pass

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

    async def start_turn(self, text: str, vad_wait_ms: int | None = None) -> None:
        turn = _Turn(self, text, vad_wait_ms)   # 先建回合：计时从定稿到达算起
        await self.interrupt()  # 新语音到达 → 立即取消在途回合（打断）
        self._clear_resume()
        self._reset_echo()      # 前端收到定稿/发出 user_text 时已停掉旧音频
        self._turn = turn
        self._turn_task = asyncio.create_task(turn.run())

    # ---- 开口事件：预热 + 续说不抢答 ----

    async def on_speech(self, starting: bool) -> None:
        """识别到用户在说话（非回声的增量字幕）。starting=本句第一个增量。"""
        self._last_speech = time.monotonic()
        if not starting:
            return
        self.prewarm_agent()
        turn, task = self._turn, self._turn_task
        if turn is not None and task is not None and not task.done() and not turn.committed:
            # 刚定稿的回合还没出声，用户又接着说了：多半是句中停顿被判停。
            # 立即取消，别抢话；新定稿到达时开新回合（上一句已在对话记录里，上下文连贯）。
            self._resume_text = turn.text
            await self.interrupt()
            if self._resume_watch is None or self._resume_watch.done():
                self._resume_watch = asyncio.create_task(self._resume_watchdog())

    async def _resume_watchdog(self) -> None:
        """兜底：续说取消后用户静默 _RESUME_GRACE_S 仍无新定稿 → 按原话重开，回合不丢。"""
        while self._resume_text:
            await asyncio.sleep(0.25)
            if self._resume_text and time.monotonic() - self._last_speech >= _RESUME_GRACE_S:
                self._resume_watch = None   # 自己不能被 start_turn 里的清理取消
                await self.restart_resumed()
                return

    async def restart_resumed(self) -> None:
        text, self._resume_text = self._resume_text, ""
        if text:
            await self.start_turn(text)

    def _clear_resume(self) -> None:
        self._resume_text = ""
        task, self._resume_watch = self._resume_watch, None
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()

    def prewarm_agent(self) -> None:
        """后台预热该用户的 agent 运行时（冷启动首回合省 ~170ms）；已在预热则跳过。"""
        if self._warm_task is not None and not self._warm_task.done():
            return
        self._warm_task = asyncio.create_task(asyncio.to_thread(self._warm_agent))

    def _warm_agent(self) -> None:
        try:
            with tenant_scope(self.user_id):
                with self.bundle_for(self.user_id):
                    pass
        except Exception:
            pass  # 预热失败无害：回合里会照常再取一次，并按原路径报错

    # ---- 回声抑制：估算客户端播放窗口 + 文本比对 ----

    def note_spoken(self, text: str) -> None:
        self._spoken = (self._spoken + text)[-_ECHO_TEXT_CAP:]

    def note_audio(self, nbytes: int, sample_rate: int) -> None:
        now = time.monotonic()
        self._play_end = max(now, self._play_end) + nbytes / (2 * max(1, sample_rate or 1))
        self._echo_until = self._play_end + _ECHO_TAIL_S

    def note_barge_in(self, played_ms=None) -> None:
        """前端开口打断已停播：记下本回合实际播到哪（主人听到哪儿）；
        回声窗口收短，但停播前收进去的回声还会被识别出来。"""
        turn = self._turn
        if turn is not None and self._turn_task is not None and not self._turn_task.done():
            try:
                ms = float(played_ms)
            except (TypeError, ValueError):
                ms = None
            if ms is not None and 0 <= ms <= 3_600_000:
                turn.played_bytes = int(ms / 1000 * 2 * max(1, turn.sample_rate))
            else:
                turn.played_bytes = self.estimate_played_bytes(turn)
        self._play_end = 0.0
        self._echo_until = min(self._echo_until, time.monotonic() + _ECHO_AFTER_BARGE_S)

    def _reset_echo(self) -> None:
        self._spoken = ""
        self._play_end = 0.0
        self._echo_until = 0.0

    def is_echo(self, text: str) -> bool:
        return time.monotonic() < self._echo_until and looks_like_echo(text, self._spoken)

    async def close(self) -> None:
        self.cancel_emotion()
        self._clear_resume()
        if self._warm_task is not None and not self._warm_task.done():
            self._warm_task.cancel()
        await self.interrupt()
        await self.asr.close()

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
                {"type": "error", "code": "csrf", "message": "页面已过期，请刷新后重试"}, ensure_ascii=False))
            await ws.close(code=CLOSE_UNAUTHORIZED)
            return

        alias = str(init.get("thread_id") or "voice")[:64]
        session = _CallSession(
            ws, principal, alias, bundle_for=bundle_for, tenant_store=tenant_store,
            chunk_text=chunk_text, public_error=public_error, count_chat=count_chat)
        session.load_scene_pref()
        init_scene = session.set_scene(str(init.get("scene", ""))) if init.get("scene") else None
        from jarvis.voice import scenes as scenes_mod
        current = init_scene or scenes_mod.scene_by_id(session.scene_id)
        await session.send_json({
            "type": "ready", "scene": current["id"], "scene_name": current["name"],
            "opening": current.get("opening", ""),
        })
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
                    session.note_barge_in(data.get("played_ms"))
                    await session.interrupt()
                    await session.asr.discard_pending()
                elif mtype == "scene":
                    scene = session.set_scene(str(data.get("scene", "")))
                    if scene is not None:
                        await session.send_json({
                            "type": "scene", "scene": scene["id"], "scene_name": scene["name"],
                            "opening": scene.get("opening", ""),
                        }, best_effort=True)
                elif mtype == "ping":
                    await session.send_json({"type": "pong"}, best_effort=True)
        except WebSocketDisconnect:
            pass
        finally:
            await session.close()
