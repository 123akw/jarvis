"""夜间记忆蒸馏：睡觉时把最近一天的对话浓缩进长期画像。

每天到点（默认 03:00，此时「最近一天」= 昨天醒着的对话）取 Owner 最近 24 小时
更新过的日常对话线程，让模型提炼「值得长期记住的稳定事实」（≤5 条），逐条写入
tenant_profile（与 profile_remember 工具同一存储，内容级去重）。当日无对话不烧
模型；蒸馏失败当日不重试只 log；distill_last_run 记账保证同日重跑零新条目。
随 JARVIS_REMINDERS_ENABLED 总开关起停（与晨报/提醒同属主动线程）。
"""
import datetime
import logging
import os
import threading

from jarvis.tenancy import TenantStore, tenant_scope

log = logging.getLogger("jarvis")

_FMT = "%Y-%m-%d %H:%M"
DEFAULT_TIME = "03:00"
WINDOW_HOURS = 2        # 到点 2 小时内可补跑；停机过窗就等明天，不翻旧账
MAX_FACTS = 5
PASS_TOKEN = "PASS"

DISTILL_PROMPT = (
    "以下是主人最近一天与你的对话摘录。请提炼「值得长期记住的关于主人的稳定事实」："
    "偏好、习惯、背景、人际关系、长期在推进的事。每条一句话、每行一条、不带编号符号，"
    f"最多 {MAX_FACTS} 条；对话里没有值得长期记住的内容就只输出 {PASS_TOKEN}。\n"
    "一次性的待办/日程/临时情绪不算稳定事实。\n对话摘录：\n{transcript}"
)


def distill_time() -> str:
    """蒸馏时刻，环境变量可调（主要给实测用），格式 HH:MM。"""
    value = (os.getenv("JARVIS_DISTILL_TIME") or DEFAULT_TIME).strip()
    try:
        datetime.datetime.strptime(value, "%H:%M")
        return value
    except ValueError:
        return DEFAULT_TIME


def parse_facts(raw: str) -> list[str]:
    """模型输出 → 事实清单：去空行去符号头，PASS 即空；硬上限 MAX_FACTS。"""
    facts = []
    for line in (raw or "").splitlines():
        text = line.strip().lstrip("-•*0123456789. ").strip()
        if not text or text.upper() == PASS_TOKEN:
            continue
        facts.append(text)
    return facts[:MAX_FACTS]


class NightlyDistiller:
    """到点取对话 → 模型提炼 → 写画像；依赖全注入，pytest 可确定性直测。"""

    def __init__(self, *, owner_getter=None, collect=None, compose=None,
                 remember=None, store_factory=None, now_fn=None, interval: float = 60.0):
        self._owner_getter = owner_getter
        self._collect = collect
        self._compose = compose
        self._remember = remember
        self._store_factory = store_factory or TenantStore
        self._now = now_fn or datetime.datetime.now
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _mark_done(self, owner, today: str) -> None:
        try:
            with tenant_scope(owner.user_id):
                self._store_factory().set_pref("distill_last_run", today)
        except Exception:
            pass

    def scan_once(self) -> int:
        """跑一轮，返回本轮新写入画像条数；任何异常只告警不外抛。"""
        if not self._owner_getter or not self._collect or not self._compose or not self._remember:
            return 0
        try:
            owner = self._owner_getter()
        except Exception:
            return 0
        if owner is None:
            return 0
        now = self._now()
        today = now.strftime("%Y-%m-%d")
        try:
            with tenant_scope(owner.user_id):
                store = self._store_factory()
                if store.get_pref("distill_last_run") == today:
                    return 0                    # 同日只跑一次：幂等的第一道闸
                due = datetime.datetime.strptime(f"{today} {distill_time()}", _FMT)
                if now < due:
                    return 0
                if (now - due).total_seconds() > WINDOW_HOURS * 3600:
                    self._mark_done(owner, today)   # 过窗作罢，明天再见
                    return 0
        except Exception as exc:
            log.warning("distill schedule check failed: %s", type(exc).__name__)
            return 0
        try:
            transcript = (self._collect(owner) or "").strip()
        except Exception as exc:
            log.warning("distill collect failed: %s", type(exc).__name__)
            self._mark_done(owner, today)       # 失败当日不重试
            return 0
        if not transcript:
            self._mark_done(owner, today)       # 当日无对话：不烧模型
            return 0
        try:
            raw = self._compose(owner, transcript)
        except Exception as exc:
            log.warning("distill compose failed: %s", type(exc).__name__)
            self._mark_done(owner, today)       # 生成失败也记账，绝不成本螺旋
            return 0
        written = 0
        for fact in parse_facts(raw):
            try:
                if self._remember(owner, fact):
                    written += 1
            except Exception as exc:
                log.warning("distill remember failed: %s", type(exc).__name__)
        self._mark_done(owner, today)
        if written:
            log.info("distill wrote %d profile fact(s)", written)
        return written

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            self.scan_once()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="jarvis-distill")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread = None
