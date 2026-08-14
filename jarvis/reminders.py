"""日程主动提醒：到点扫描 + 多通道推送。

「记了日程却从不开口」是管家的失职。本模块补上主动性：
- 后台线程每 interval 秒扫一次唯一 active Owner 的日程，到点且未超过宽限期的条目
  经微信桥主动推送（联系人先发「提醒发给我」绑定，见 jarvis/wechat.py）。
- 网页与桌面端各自轮询 GET /api/reminders/pending 领取并弹提示（server.py）。
每个 (owner, 日程, when, 通道) 只提醒一次，记录在 accounts.sqlite3 的
tenant_reminders_sent；重启不重复轰炸，改期后的同一日程会按新时间再提醒。
"""
import datetime
import logging
import threading

from jarvis.tenancy import TenantStore, tenant_scope

_FMT = "%Y-%m-%d %H:%M"
GRACE_MINUTES = 30   # 过点超过 30 分钟不再补提醒（避免停机重启后翻旧账）

log = logging.getLogger("jarvis")


def reminder_window(now: datetime.datetime) -> tuple[str, str]:
    """返回 (floor, ceiling)：floor < when_at <= ceiling 视为到点待提醒。"""
    floor = (now - datetime.timedelta(minutes=GRACE_MINUTES)).strftime(_FMT)
    return floor, now.strftime(_FMT)


def format_reminder(item: dict) -> str:
    return f"⏰ 日程提醒：{item['when']} {item['title']}"


RADIO_WINDOW_HOURS = 2   # 配置时间过后 2 小时内可补发；再晚就等明天，不翻旧账
RADIO_PROMPT = (
    "现在是晨报电台时间。请生成一份今日晨报：先用 weather_here 报天气并给一句穿衣/带伞建议，"
    "再报今日日程与未完成待办；最后给一句今日建议。"
    "要求：口语化、适合朗读，不用 URL、代码、表格和 Markdown 符号，总长 250 字以内。"
)


class MorningRadio:
    """晨报电台：每天到点用 Agent 生成晨报，经微信推送（语音条+文字）。

    只服务唯一 active Owner（与微信桥一致）。为控制成本：
    - 推送通道不可用（桥没连 / 没绑「提醒发给我」）时根本不生成；
    - 生成后推送失败也记为当日已发，绝不反复烧模型和 TTS。
    """

    def __init__(self, *, owner_getter=None, compose=None, push_voice=None,
                 push_available=None, store_factory=None, now_fn=None, interval: float = 60.0):
        self._owner_getter = owner_getter
        self._compose = compose
        self._push_voice = push_voice
        self._push_available = push_available or (lambda: True)
        self._store_factory = store_factory or TenantStore
        self._now = now_fn or datetime.datetime.now
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def scan_once(self) -> bool:
        if not self._owner_getter or not self._compose or not self._push_voice:
            return False
        try:
            owner = self._owner_getter()
        except Exception:
            return False
        if owner is None:
            return False
        now = self._now()
        today = now.strftime("%Y-%m-%d")
        try:
            with tenant_scope(owner.user_id):
                store = self._store_factory()
                radio_time = (store.get_pref("radio_time") or "").strip()
                if not radio_time or store.get_pref("radio_last_sent") == today:
                    return False
                due = datetime.datetime.strptime(f"{today} {radio_time}", _FMT)
                if now < due:
                    return False
                if (now - due).total_seconds() > RADIO_WINDOW_HOURS * 3600:
                    store.set_pref("radio_last_sent", today)  # 窗口已过：今天作罢
                    return False
        except Exception as exc:
            log.warning("radio schedule check failed: %s", type(exc).__name__)
            return False
        try:
            if not self._push_available():
                return False   # 通道不通就不烧模型，下一轮再看
        except Exception:
            return False
        try:
            briefing = self._compose(owner)
        except Exception as exc:
            log.warning("radio compose failed: %s", type(exc).__name__)
            return False
        if not briefing or not briefing.strip():
            return False
        sent = False
        try:
            sent = bool(self._push_voice(briefing))
        except Exception as exc:
            log.warning("radio push failed: %s", type(exc).__name__)
        try:
            with tenant_scope(owner.user_id):
                # 无论推送成败都记当日已发：生成已经花了钱，不允许成本螺旋
                self._store_factory().set_pref("radio_last_sent", today)
        except Exception:
            pass
        return sent

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            self.scan_once()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="jarvis-radio")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread = None


class ReminderScanner:
    """微信通道的到点扫描线程；store/owner/push/now 全部可注入，便于确定性测试。"""

    def __init__(self, *, store_factory=None, owner_getter=None, push_wechat=None,
                 now_fn=None, interval: float = 30.0):
        self._store_factory = store_factory or TenantStore
        self._owner_getter = owner_getter
        self._push_wechat = push_wechat
        self._now = now_fn or datetime.datetime.now
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def scan_once(self) -> int:
        """扫一轮微信通道，返回本轮成功推送条数；任何异常只告警不外抛。"""
        if not self._owner_getter or not self._push_wechat:
            return 0
        try:
            owner = self._owner_getter()
        except Exception:
            return 0
        if owner is None:
            return 0
        floor, ceiling = reminder_window(self._now())
        sent = 0
        try:
            with tenant_scope(owner.user_id):
                store = self._store_factory()
                due = store.due_reminders(floor=floor, ceiling=ceiling, channel="wechat")
                for item in due:
                    ok = False
                    try:
                        ok = bool(self._push_wechat(format_reminder(item)))
                    except Exception as exc:
                        log.warning("reminder wechat push failed: %s", type(exc).__name__)
                    if ok:
                        store.mark_reminded(item["id"], item["when"], "wechat")
                        sent += 1
        except Exception as exc:
            log.warning("reminder scan failed: %s", type(exc).__name__)
        return sent

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            self.scan_once()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="jarvis-reminders")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread = None
