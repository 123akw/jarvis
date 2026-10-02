"""会议纪要：会话状态、带说话人的转写记录与桌面指令投递箱（纯逻辑，可确定性直测）。

链路：桌面端双路推流（麦克风=「我」/ 系统回环=「对方」）→ /api/meeting/stream 网关
（jarvis/voice/meeting_gateway.py）→ 本模块 MeetingSession 攒带说话人与时刻的转写 →
结束时 server.py 的 _meeting_finalize 用 Owner 自己的 Agent 总结成纪要 → 入库
tenant_meetings + SMTP 发送到指定邮箱（jarvis/mailer.py）。

「让贾维斯监控会议」走工具 meeting_start/meeting_stop（jarvis/tools/meeting.py）：
往 desktop_commands 领取箱投指令，桌面端约 10 秒内轮询领取并开始/结束采集。
"""
import datetime
import threading
import time
import uuid
import wave

from jarvis import config

SPEAKER_ME = "我"
SPEAKER_OTHERS = "对方"
AUDIO_SAMPLE_RATE = 16000
MAX_AUDIO_BYTES = AUDIO_SAMPLE_RATE * 2 * 3600 * 2   # 「对方」声道最多落盘 2 小时
MAX_TRANSCRIPT_CHARS = 60_000   # 护栏：总结输入上限，超出后丢弃新增（保开头保结构）
MAX_TITLE_CHARS = 60
MAX_COMMANDS = 10               # 领取箱上限：桌面长期离线时旧指令先进先出

MEETING_PROMPT = (
    "你是会议记录员。下面是一场会议的实时语音转写：「我」是主人自己的发言，「对方」是"
    "会议里其他人的发言（若标注为「对方1」「对方2」「对方3」…，那是声纹分离出的不同"
    "说话人，请分别对待）；语音识别可能有错字，请按上下文理解。\n"
    "说话人身份：若转写内容能明确推断某位说话人的称呼或姓名（例如有人喊「张总你看呢」"
    "而下一句是对方2 回应，或说话人自报家门），在纪要中用「对方2（张总）」的形式标注；"
    "推断不出就保持编号，绝不允许猜测或编造身份。\n"
    "只依据转写内容整理一份简洁的中文会议纪要，用 Markdown 输出，不要调用任何工具，"
    "不要添加转写里没有的信息，按下面结构写：\n"
    "# 会议纪要\n"
    "- 会议主题：（一句话概括）\n"
    "- 时间：{date}\n"
    "- 参会人：（我 + 各位对方，能推断出称呼的带上）\n"
    "## 讨论要点\n（3-8 条，每条一句话，多方观点分别归属）\n"
    "## 结论与决定\n（没有就写「无明确结论」）\n"
    "## 待办事项\n（每条「事项 — 负责人 — 期限」，信息缺失的部分留空；没有就写「无」）\n"
    "## 气氛与情绪\n（一两句话：会议节奏与各方情绪状态，如「讨论热烈，双方对技术路线有分歧但氛围务实」；"
    "只依据转写措辞判断，不要过度解读）\n\n"
    "转写开始：\n{transcript}"
)


def extract_todos(minutes: str) -> list[dict]:
    """从纪要「## 待办事项」小节解析条目：[{content, owner, due}]。

    行格式「· 事项 — 负责人 — 期限」（连接符兼容 — / - / –），解析不出的行跳过；
    「无」不算条目。给任务台一键导入用。"""
    lines = []
    in_section = False
    for raw in str(minutes or "").splitlines():
        line = raw.strip()
        if line.startswith("##"):
            in_section = "待办" in line
            continue
        if not in_section or not line:
            continue
        cleaned = line.lstrip("·-•* ").strip()
        if not cleaned or cleaned in ("无", "暂无"):
            continue
        parts = [p.strip() for p in cleaned.replace("—", "|").replace("–", "|").split("|")]
        if len(parts) == 1 and " - " in cleaned:
            parts = [p.strip() for p in cleaned.split(" - ")]
        content = parts[0]
        if not content:
            continue
        lines.append({
            "content": content[:200],
            "owner": parts[1] if len(parts) > 1 else "",
            "due": parts[2] if len(parts) > 2 else "",
        })
    return lines


LIVE_POINTS_PROMPT = (
    "你是会议记录员，会议还在进行中。下面是最近一段实时转写（「我」是主人，「对方」是"
    "其他与会者，识别可能有错字）。请只依据这段转写，提炼「到目前为止的要点」："
    "3 到 5 条，每条一句话，可含刚敲定的结论或分工；纯文本输出，每条一行、行首用「· 」，"
    "不用 Markdown 标题，不要编造，不要寒暄。信息太少提炼不出时只输出 PASS。\n\n{transcript}"
)


class MeetingAudioRecorder:
    """「对方」声道 PCM 落盘成 wav（供离线说话人分离）：懒打开、封顶、关闭幂等。

    write 跑在网关的事件循环上：帧先攒进内存，每 ~1 秒批量写一次盘，
    避免每 100ms 一次同步磁盘写卡住整个事件循环。"""

    _FLUSH_BYTES = 32_000   # ~1s@16kHz PCM16

    def __init__(self, path) -> None:
        self.path = str(path)
        self.started_at = None
        self._wav = None
        self._bytes = 0
        self._pending = bytearray()

    def write(self, pcm: bytes, now_fn=None) -> None:
        if self._bytes >= MAX_AUDIO_BYTES or not pcm:
            return
        if self._wav is None:
            self._wav = wave.open(self.path, "wb")
            self._wav.setnchannels(1)
            self._wav.setsampwidth(2)
            self._wav.setframerate(AUDIO_SAMPLE_RATE)
            self.started_at = (now_fn or datetime.datetime.now)()
        self._pending.extend(pcm)
        self._bytes += len(pcm)
        if len(self._pending) >= self._FLUSH_BYTES:
            self._wav.writeframes(bytes(self._pending))
            self._pending.clear()

    def close(self) -> None:
        if self._wav is not None:
            try:
                if self._pending:
                    self._wav.writeframes(bytes(self._pending))
                    self._pending.clear()
                self._wav.close()
            except Exception:
                pass
            self._wav = None


class MeetingSession:
    """一场进行中的会议：线程安全地攒转写段落。"""

    def __init__(self, user_id: str, title: str = "", now_fn=None) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.user_id = user_id
        self.title = " ".join(str(title or "").split())[:MAX_TITLE_CHARS] or "会议"
        self._now = now_fn or datetime.datetime.now
        self.started_at = self._now()
        self.ended_at = None
        self.segments: list[dict] = []
        self.truncated = False
        self._chars = 0
        self._lock = threading.Lock()
        self._recorder: MeetingAudioRecorder | None = None
        self._audio_failed = False

    def add_segment(self, speaker: str, text: str) -> dict | None:
        cleaned = " ".join(str(text).split())
        if not cleaned:
            return None
        at = self._now()
        entry = {"ts": at.strftime("%H:%M:%S"), "speaker": speaker, "text": cleaned, "at": at}
        with self._lock:
            if self._chars >= MAX_TRANSCRIPT_CHARS:
                self.truncated = True
                return None
            self.segments.append(entry)
            self._chars += len(cleaned)
        return entry

    def transcript_text(self) -> str:
        with self._lock:
            lines = [f"[{s['ts']}] {s['speaker']}：{s['text']}" for s in self.segments]
            truncated = self.truncated
        text = "\n".join(lines)
        if truncated:
            text += "\n（会议超长，之后的发言未纳入转写）"
        return text

    def finish(self) -> None:
        if self.ended_at is None:
            self.ended_at = self._now()
        self.close_audio()

    # ---- 「对方」声道录音与说话人分离 ----

    @property
    def audio_path(self) -> str | None:
        return self._recorder.path if self._recorder is not None else None

    @property
    def audio_started_at(self):
        return self._recorder.started_at if self._recorder is not None else None

    def record_others(self, pcm: bytes) -> None:
        """gateway 每收到一帧「对方」音频调用一次；失败静默（录音只服务分离增强）。"""
        if self._audio_failed:
            return
        try:
            if self._recorder is None:
                audio_dir = config.data_dir() / "meeting-audio"
                audio_dir.mkdir(parents=True, exist_ok=True)
                self._recorder = MeetingAudioRecorder(audio_dir / f"{self.id}.wav")
            self._recorder.write(pcm, now_fn=self._now)
        except Exception:
            # 写盘坏了就此打住：若换新文件重录会截掉已录音频并重置对齐基准，
            # 说话人分离会把标签安到错误的句子上——宁可保留半截音频原样收尾。
            self._audio_failed = True
            self.close_audio()

    def close_audio(self) -> None:
        if self._recorder is not None:
            self._recorder.close()

    def relabel_others(self, sentences: list[dict]) -> int:
        """按离线分离结果把「对方」细分为 对方1/对方2…；只有 ≥2 个说话人才动手。

        对齐方式：每个「对方」段落的定稿墙钟时间 → 音频内毫秒偏移 → 命中（或最近的）
        分离句子的 speaker_id。返回分离出的说话人数。
        """
        started = self.audio_started_at
        if not sentences or started is None:
            return 0
        speakers = {s["speaker"] for s in sentences}
        if len(speakers) < 2:
            return len(speakers)
        with self._lock:
            for entry in self.segments:
                if entry["speaker"] != SPEAKER_OTHERS:
                    continue
                at = entry.get("at")
                if at is None:
                    continue
                offset = (at - started).total_seconds() * 1000
                best, best_distance = None, None
                for s in sentences:
                    if s["start_ms"] <= offset <= s["end_ms"] + 2000:
                        best = s
                        break
                    distance = min(abs(offset - s["end_ms"]), abs(offset - s["start_ms"]))
                    if best_distance is None or distance < best_distance:
                        best_distance, best = distance, s
                if best is not None:
                    entry["speaker"] = f"{SPEAKER_OTHERS}{best['speaker'] + 1}"
        return len(speakers)


class MeetingRegistry:
    """每用户至多一场进行中的会议；start 冲突返回 None（由网关拒绝重复连接）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: dict[str, MeetingSession] = {}

    def start(self, user_id: str, title: str = "", now_fn=None) -> MeetingSession | None:
        with self._lock:
            if user_id in self._active:
                return None
            session = MeetingSession(user_id, title, now_fn)
            self._active[user_id] = session
            return session

    def get(self, user_id: str) -> MeetingSession | None:
        with self._lock:
            return self._active.get(user_id)

    def finish(self, user_id: str) -> MeetingSession | None:
        with self._lock:
            session = self._active.pop(user_id, None)
        if session is not None:
            session.finish()
        return session


DESKTOP_ONLINE_SECONDS = 60.0   # 桌面端每 10 秒领一次指令；一分钟内领过就算在线


class CommandOutbox:
    """桌面指令领取箱：按用户暂存、领取即清、线程安全（照 heartbeat.PendingOutbox）。

    顺带记下每个账号最近一次领取的时刻，供「桌面端是否在线」判断（插件市场的 desktop 前置条件）。"""

    def __init__(self, clock=time.monotonic) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, list[dict]] = {}
        self._seen: dict[str, float] = {}
        self._clock = clock

    def put(self, user_id: str, command: dict) -> None:
        with self._lock:
            queue = self._items.setdefault(user_id, [])
            queue.append(dict(command))
            while len(queue) > MAX_COMMANDS:
                queue.pop(0)

    def drain(self, user_id: str) -> list[dict]:
        with self._lock:
            self._seen[user_id] = self._clock()
            return self._items.pop(user_id, [])

    def online(self, user_id: str, within: float = DESKTOP_ONLINE_SECONDS) -> bool:
        with self._lock:
            seen = self._seen.get(user_id)
        return seen is not None and self._clock() - seen <= within


# 进程级单例：网关建会话、REST 查状态、工具投指令、桌面轮询领取共用同两个实例
active_meetings = MeetingRegistry()
desktop_commands = CommandOutbox()
