"""日程主动提醒：到点扫描 + 多通道推送 + 「稍后 / 完成」。

「记了日程却从不开口」是管家的失职。本模块补上主动性：
- 后台线程每 interval 秒扫一次：唯一 active Owner 经微信桥推送（联系人先发「提醒发给我」绑定，
  见 jarvis/wechat.py）；绑定了飞书的每个账号经飞书机器人私聊推送。
- 网页与桌面端各自轮询 GET /api/reminders/pending 领取并弹提示（server.py）。
- 每个账号可在设置里关掉某些渠道（jarvis/delivery.py），关掉的渠道不推也不记账。
每个 (owner, 日程, 响铃时刻, 通道) 只提醒一次，记录在 accounts.sqlite3 的
tenant_reminders_sent；重启不重复轰炸，改期后的同一日程会按新时间再提醒。

可操作的提醒（F5）：网页弹条 / 桌面通知上的「稍后 10 分钟」「完成」走 /api/reminders/{id}/…，
微信 / 飞书里在提醒发出后 REPLY_WINDOW_MINUTES 分钟内回「稍后」「20分钟后再提醒」「好了」也行。
任一渠道处理过，同一次提醒其他渠道不再催；「稍后」只排一次再响，日程本身的时间不动。
"""
import datetime
import logging
import re

from jarvis import delivery
from jarvis.periodic import PeriodicWorker
from jarvis.tenancy import TenantStore, tenant_scope

_FMT = "%Y-%m-%d %H:%M"
GRACE_MINUTES = 30   # 过点超过 30 分钟不再补提醒（避免停机重启后翻旧账）
SNOOZE_MINUTES = 10
MAX_SNOOZE_MINUTES = 180
REPLY_WINDOW_MINUTES = 30   # 微信 / 飞书回复短语只在提醒发出后这么久内生效，之后一律当普通聊天
PUSH_HINT = "（回「稍后」推迟 10 分钟，回「好了」表示已处理）"

log = logging.getLogger("jarvis")


def reminder_window(now: datetime.datetime) -> tuple[str, str]:
    """返回 (floor, ceiling)：floor < when_at <= ceiling 视为到点待提醒。"""
    floor = (now - datetime.timedelta(minutes=GRACE_MINUTES)).strftime(_FMT)
    return floor, now.strftime(_FMT)


def format_reminder(item: dict) -> str:
    """微信 / 飞书推送文案；「稍后」排的再响标成「再次提醒」，末尾附回复提示。"""
    again = item.get("at") and item["at"] != item["when"]
    head = "⏰ 再次提醒" if again else "⏰ 日程提醒"
    return f"{head}：{item['when']} {item['title']}{PUSH_HINT}"


# ---------- 回复短语：只认确定的几种说法，拿不准就交给模型正常对话 ----------

_CN_DIGITS = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_PUNCT = re.compile(r"[\s，。！!？?、,.~～…]+")
_DONE_WORDS = frozenset({"好了", "好啦", "完成", "完成了", "已完成", "做完了", "搞定", "搞定了", "办完了", "弄完了"})
_LATER_WORDS = frozenset({"稍后", "稍后提醒", "稍后再提醒", "稍后提醒我", "稍后再提醒我", "等会儿", "等会", "等一下",
                          "晚点", "晚点提醒", "晚点再提醒", "待会", "待会儿", "过会儿", "推迟", "延后"})
_LATER_RE = re.compile(r"^(?:过|等)?(半|[0-9]{1,3}|[零一二两三四五六七八九十]{1,3})(?:个)?(分钟|小时|钟头)(?:之|以)?后?(?:再)?提醒(?:我)?$")


def _cn_number(text: str) -> int | None:
    if text.isdigit():
        return int(text)
    if text == "十":
        return 10
    if "十" in text:
        tens, _, ones = text.partition("十")
        if (tens and tens not in _CN_DIGITS) or (ones and ones not in _CN_DIGITS):
            return None
        return (_CN_DIGITS[tens] if tens else 1) * 10 + (_CN_DIGITS[ones] if ones else 0)
    if len(text) == 1 and text in _CN_DIGITS:
        return _CN_DIGITS[text]
    return None


def parse_quick_reply(text: str) -> tuple[str, int] | None:
    """「稍后」→ ("snooze", 10)；「20分钟后再提醒」→ ("snooze", 20)；「好了」→ ("done", 0)；其余 None。"""
    compact = _PUNCT.sub("", text or "")
    if not compact or len(compact) > 12:
        return None
    if compact in _DONE_WORDS:
        return ("done", 0)
    if compact in _LATER_WORDS:
        return ("snooze", SNOOZE_MINUTES)
    match = _LATER_RE.match(compact)
    if not match:
        return None
    amount, unit = match.group(1), match.group(2)
    if amount == "半":
        minutes = 30 if unit != "分钟" else 0
    else:
        number = _cn_number(amount)
        minutes = (number or 0) * (1 if unit == "分钟" else 60)
    if not 1 <= minutes <= MAX_SNOOZE_MINUTES:
        return None
    return ("snooze", minutes)


def snooze_until(at: str, now: datetime.datetime, minutes: int) -> str:
    """从「现在」起算（提醒晚看到也是再等 N 分钟），按分钟取整。"""
    base = max(now.replace(second=0, microsecond=0), datetime.datetime.strptime(at, _FMT))
    return (base + datetime.timedelta(minutes=minutes)).strftime(_FMT)


def resolve(store, schedule_id: int, at: str, action: str, now: datetime.datetime,
            *, minutes: int = SNOOZE_MINUTES) -> dict:
    """网页 / 桌面 / 微信 / 飞书共用的「稍后 / 完成」：幂等，任一渠道处理过其他渠道不再催。"""
    until = snooze_until(at, now, minutes) if action == "snooze" else None
    return store.ack_reminder(schedule_id, at, action, until=until)


def reply_text(result: dict) -> str:
    title = result.get("title") or "这条日程"
    if result["status"] == "done":
        return f"「{title}」已经标记完成了。" if result.get("already") else f"好的，「{title}」不再提醒。"
    clock = str(result.get("until", ""))[11:16]
    if result.get("already"):
        return f"「{title}」已经推迟到 {clock} 了。" if clock else f"「{title}」已经推迟过了。"
    return f"好的，{clock} 再提醒你「{title}」。"


def handle_quick_reply(store, channel: str, text: str, now: datetime.datetime,
                       *, utc_now: datetime.datetime | None = None) -> str | None:
    """微信 / 飞书回复短语：只作用于该渠道 REPLY_WINDOW_MINUTES 内送达的最近一条提醒。

    返回要回给用户的话；None = 不是回复短语或窗口外，调用方照常交给模型对话。须在 tenant_scope 内调用。"""
    parsed = parse_quick_reply(text)
    if parsed is None:
        return None
    stamp = utc_now or datetime.datetime.now(datetime.timezone.utc)
    since = (stamp - datetime.timedelta(minutes=REPLY_WINDOW_MINUTES)).isoformat()
    item = store.last_reminded(channel, since=since)
    if item is None:
        return None
    action, minutes = parsed
    result = resolve(store, item["id"], item["at"], action, now, minutes=minutes or SNOOZE_MINUTES)
    if result["status"] in ("missing", "stale"):
        return None
    return reply_text(result)


RADIO_WINDOW_HOURS = 2   # 配置时间过后 2 小时内可补发；再晚就等明天，不翻旧账
RADIO_PROMPT = (
    "现在是晨报电台时间。请生成一份今日晨报：先用 weather_here 报天气并给一句穿衣/带伞建议，"
    "再报今日日程与未完成待办；最后给一句今日建议。"
    "要求：口语化、适合朗读，不用 URL、代码、表格和 Markdown 符号，总长 250 字以内。"
)


class MorningRadio(PeriodicWorker):
    """晨报电台：每天到点用 Agent 生成晨报，经微信（语音条+文字）/ 飞书（文字）推送。

    只服务唯一 active Owner（与微信桥一致），渠道按该账号的送达设置取舍。为控制成本：
    - 勾选的推送渠道一个都不通（桥没连 / 没绑「提醒发给我」/ 飞书没绑）时根本不生成；
    - 生成后推送失败也记为当日已发，绝不反复烧模型和 TTS。
    晨报是用户亲手定的时间，不受免打扰影响。
    """

    thread_name = "jarvis-radio"

    def __init__(self, *, owner_getter=None, compose=None, push_voice=None,
                 push_available=None, push_feishu=None, feishu_ready=None,
                 store_factory=None, now_fn=None, interval: float = 60.0):
        self._owner_getter = owner_getter
        self._compose = compose
        self._push_voice = push_voice
        self._push_available = push_available or (lambda: True)
        self._push_feishu = push_feishu
        self._feishu_ready = feishu_ready or (lambda user_id: False)
        self._store_factory = store_factory or TenantStore
        self._now = now_fn or datetime.datetime.now
        super().__init__(interval)

    def _ready(self, check, *args) -> bool:
        try:
            return bool(check(*args))
        except Exception:
            return False

    def scan_once(self) -> bool:
        if not self._owner_getter or not self._compose or not (self._push_voice or self._push_feishu):
            return False
        owner = self._resolve_owner(self._owner_getter)
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
                prefs = delivery.load_prefs(store)
        except Exception as exc:
            log.warning("radio schedule check failed: %s", type(exc).__name__)
            return False
        use_wechat = bool(self._push_voice) and prefs.allows("wechat") and self._ready(self._push_available)
        use_feishu = (bool(self._push_feishu) and prefs.allows("feishu")
                      and self._ready(self._feishu_ready, owner.user_id))
        if not (use_wechat or use_feishu):
            return False   # 通道不通就不烧模型，下一轮再看
        try:
            briefing = self._compose(owner)
        except Exception as exc:
            log.warning("radio compose failed: %s", type(exc).__name__)
            return False
        if not briefing or not briefing.strip():
            return False
        sent = False
        if use_wechat:
            try:
                sent = bool(self._push_voice(briefing))
            except Exception as exc:
                log.warning("radio push failed: %s", type(exc).__name__)
        if use_feishu:
            try:
                sent = bool(self._push_feishu(owner.user_id, f"📻 {briefing}")) or sent
            except Exception as exc:
                log.warning("radio feishu push failed: %s", type(exc).__name__)
        try:
            with tenant_scope(owner.user_id):
                # 无论推送成败都记当日已发：生成已经花了钱，不允许成本螺旋
                self._store_factory().set_pref("radio_last_sent", today)
        except Exception:
            pass
        return sent



class ReminderScanner(PeriodicWorker):
    """推送渠道（微信 / 飞书）的到点扫描线程；依赖全部可注入，便于确定性测试。

    - 微信：只服务唯一 Owner（桥是 Owner 的）；
    - 飞书：feishu_users() 列出的每个已绑定账号，push_feishu(user_id, text) 私聊推送；
    - 每轮顺带把免打扰期间攒下的巡检消息在结束后合并发出（notifier.flush）。
    """

    thread_name = "jarvis-reminders"

    def __init__(self, *, store_factory=None, owner_getter=None, push_wechat=None,
                 push_feishu=None, feishu_users=None, notifier=None,
                 now_fn=None, interval: float = 30.0):
        self._store_factory = store_factory or TenantStore
        self._owner_getter = owner_getter
        self._push_wechat = push_wechat
        self._push_feishu = push_feishu
        self._feishu_users = feishu_users
        self._notifier = notifier
        self._now = now_fn or datetime.datetime.now
        super().__init__(interval)

    def _targets(self) -> dict[str, list]:
        targets: dict[str, list] = {}
        if self._owner_getter and (self._push_wechat or self._notifier):
            owner = self._resolve_owner(self._owner_getter)
            if owner is not None:
                pushes = targets.setdefault(owner.user_id, [])
                if self._push_wechat:
                    pushes.append(("wechat", self._push_wechat))
        if self._push_feishu and self._feishu_users:
            try:
                users = list(self._feishu_users())
            except Exception as exc:
                log.warning("reminder feishu users failed: %s", type(exc).__name__)
                users = []
            for user_id in users:
                targets.setdefault(user_id, []).append(
                    ("feishu", lambda text, u=user_id: self._push_feishu(u, text)))
        return targets

    def scan_once(self) -> int:
        """扫一轮推送渠道，返回本轮成功推送条数；任何异常只告警不外抛。"""
        now = self._now()
        floor, ceiling = reminder_window(now)
        sent = 0
        for user_id, pushes in self._targets().items():
            try:
                with tenant_scope(user_id):
                    store = self._store_factory()
                    prefs = delivery.load_prefs(store)
                    for channel, push in pushes:
                        if not prefs.allows(channel):
                            continue   # 用户关掉的渠道：不推也不记账，重新打开后宽限期内还能补上
                        for item in store.due_reminders(floor=floor, ceiling=ceiling, channel=channel):
                            ok = False
                            try:
                                ok = bool(push(format_reminder(item)))
                            except Exception as exc:
                                log.warning("reminder %s push failed: %s", channel, type(exc).__name__)
                            if ok:
                                store.mark_reminded(item["id"], item["at"], channel)
                                sent += 1
            except Exception as exc:
                log.warning("reminder scan failed: %s", type(exc).__name__)
            if self._notifier is not None:
                try:
                    self._notifier.flush(user_id, now)
                except Exception as exc:
                    log.warning("quiet-hours flush failed: %s", type(exc).__name__)
        return sent
