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
import uuid

SPEAKER_ME = "我"
SPEAKER_OTHERS = "对方"
MAX_TRANSCRIPT_CHARS = 60_000   # 护栏：总结输入上限，超出后丢弃新增（保开头保结构）
MAX_TITLE_CHARS = 60
MAX_COMMANDS = 10               # 领取箱上限：桌面长期离线时旧指令先进先出

MEETING_PROMPT = (
    "你是会议记录员。下面是一场会议的实时语音转写：「我」是主人自己的发言，「对方」是"
    "会议里其他人的发言；语音识别可能有错字，请按上下文理解。只依据转写内容整理一份"
    "简洁的中文会议纪要，用 Markdown 输出，不要调用任何工具，不要添加转写里没有的信息，"
    "按下面结构写：\n"
    "# 会议纪要\n"
    "- 会议主题：（一句话概括）\n"
    "- 时间：{date}\n"
    "## 讨论要点\n（3-8 条，每条一句话）\n"
    "## 结论与决定\n（没有就写「无明确结论」）\n"
    "## 待办事项\n（每条「事项 — 负责人 — 期限」，信息缺失的部分留空；没有就写「无」）\n\n"
    "转写开始：\n{transcript}"
)


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

    def add_segment(self, speaker: str, text: str) -> dict | None:
        cleaned = " ".join(str(text).split())
        if not cleaned:
            return None
        entry = {"ts": self._now().strftime("%H:%M:%S"), "speaker": speaker, "text": cleaned}
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


class CommandOutbox:
    """桌面指令领取箱：按用户暂存、领取即清、线程安全（照 heartbeat.PendingOutbox）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, list[dict]] = {}

    def put(self, user_id: str, command: dict) -> None:
        with self._lock:
            queue = self._items.setdefault(user_id, [])
            queue.append(dict(command))
            while len(queue) > MAX_COMMANDS:
                queue.pop(0)

    def drain(self, user_id: str) -> list[dict]:
        with self._lock:
            return self._items.pop(user_id, [])


# 进程级单例：网关建会话、REST 查状态、工具投指令、桌面轮询领取共用同两个实例
active_meetings = MeetingRegistry()
desktop_commands = CommandOutbox()
