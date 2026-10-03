"""定时运行（第十八轮，契约 §3.4 ``GET|PUT /api/flows/{id}/trigger`` 与后台调度）。

- 触发器存在 ``tenant_flow_triggers``（schema v7）：每个流程至多一个；``config`` 是 JSON：
  ``{schedule: {repeat, time, weekday}, inputs, notify: {feishu, desktop}, origin, fail_streak, paused_reason, last_error}``
  （引擎的流程列表按 ``config.schedule`` 用 ``store.trigger_label`` 生成「每个工作日 08:00」）；
- 时间按服务器本地时区算：``next_run_at`` 在库里存 UTC ISO（便于按字符串比较到点），接口返回本地时区的 ISO；
  「每个工作日」跳过法定节假日、调休上班日照常（节假日数据来自「日期工作日」插件，没收录的年份按周一到周五）；
- :class:`FlowScheduler` 每 ~30 秒查一次到点的触发器：先把 next_run_at 排到下一次（防重复触发），再在线程池里
  ``runtime().run_headless(...)``；``busy`` 顺延 1 分钟；过期超过 1 小时的不补跑；跑完写 last_run_at / last_status，
  按 notify 推送（飞书 / 桌面通知）：流程名 + 结果摘要 + 结果网页链接；
- 连续失败 5 次自动暂停（enabled 置 0），按 notify 通知一次，``paused_reason`` 写明原因；成功一次清零。
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from jarvis.tenancy import TenantStore

log = logging.getLogger("jarvis")

KINDS = ("manual", "schedule")
REPEATS = ("daily", "weekdays", "weekly")
TICK_SECONDS = 30.0
STARTUP_DELAY = 5.0
BUSY_RETRY = dt.timedelta(minutes=1)
STALE_AFTER = dt.timedelta(hours=1)
MAX_FAIL_STREAK = 5
MAX_INPUTS = 8
MAX_INPUT_CHARS = 2000
SUMMARY_CHARS = 300
UPCOMING = 3
WEEKDAY_NAMES = "一二三四五六日"
DEFAULT_SCHEDULE = {"repeat": "daily", "time": "08:00", "weekday": 1}
DEFAULT_NOTIFY = {"feishu": False, "desktop": True}
LOCAL_TZ = None   # None = 服务器本地时区（测试可换成固定时区）
_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


class TriggerError(ValueError):
    """触发器设置不合法；message 直接给用户看。"""


# ---------- 时间 ----------

def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def to_iso(value: dt.datetime | None) -> str | None:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="seconds") if value is not None else None


def from_iso(value) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=dt.timezone.utc)


def local(value: dt.datetime) -> dt.datetime:
    return value.astimezone(LOCAL_TZ)


def _default_workday(day: dt.date) -> bool:
    try:
        from jarvis.plugins.packs.workday_calc.tools import is_workday
        return bool(is_workday(day))
    except Exception:   # 插件不在：按周一到周五
        return day.weekday() < 5


def parse_time(text) -> tuple[int, int]:
    match = _TIME.match(str(text or "").strip())
    if not match:
        raise TriggerError("时间要写成「08:00」这样的 24 小时制")
    return int(match.group(1)), int(match.group(2))


def matches(schedule: dict, day: dt.date, workday=_default_workday) -> bool:
    repeat = schedule.get("repeat")
    if repeat == "daily":
        return True
    if repeat == "weekdays":
        return workday(day)
    if repeat == "weekly":
        return day.isoweekday() == int(schedule.get("weekday") or 1)
    return False


def next_run(schedule: dict, now: dt.datetime, *, workday=_default_workday) -> dt.datetime:
    """``now`` 之后（不含）最近一次运行的时刻（带本地时区）。"""
    hour, minute = parse_time(schedule.get("time"))
    today = local(now).date()
    for offset in range(0, 40):   # 春节最长连休 9 天，40 天足够
        day = today + dt.timedelta(days=offset)
        if not matches(schedule, day, workday):
            continue
        naive = dt.datetime.combine(day, dt.time(hour, minute))
        candidate = naive.replace(tzinfo=LOCAL_TZ) if LOCAL_TZ is not None else naive.astimezone()
        if candidate > now:
            return candidate
    raise TriggerError("排不出下一次运行时间，换个重复方式试试")


def upcoming(schedule: dict, now: dt.datetime, count: int = UPCOMING, *, workday=_default_workday) -> list:
    out, cursor = [], now
    for _ in range(count):
        cursor = next_run(schedule, cursor, workday=workday)
        out.append(cursor)
    return out


def label(schedule: dict) -> str:
    """「每天 08:00」「每个工作日 08:00」「每周三 08:00」（与引擎的流程列表同一个函数）。"""
    from jarvis.flows.store import trigger_label
    return trigger_label({"schedule": schedule})


def when_label(moment: dt.datetime, now: dt.datetime) -> str:
    """「今天 08:00」「明天（周六）08:00」「10月8日（周四）08:00」。"""
    moment, now = local(moment), local(now)
    days = (moment.date() - now.date()).days
    clock = moment.strftime("%H:%M")
    weekday = f"（周{WEEKDAY_NAMES[moment.weekday()]}）"
    if days == 0:
        return f"今天 {clock}"
    if days == 1:
        return f"明天{weekday}{clock}"
    if days == 2:
        return f"后天{weekday}{clock}"
    return f"{moment.month}月{moment.day}日{weekday}{clock}"


# ---------- 设置的规整与校验 ----------

def _bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise TriggerError("开关只能是开或关")


def normalize(body: dict, previous: dict | None = None) -> dict:
    """请求体 → {kind, enabled, schedule, inputs, notify}；不合法抛 :class:`TriggerError`。没给的项沿用上次的设置。"""
    previous = previous or {}
    if not isinstance(body, dict):
        raise TriggerError("定时设置的格式不对")
    kind = body.get("kind") if body.get("kind") is not None else previous.get("kind", "schedule")
    if kind not in KINDS:
        raise TriggerError("运行方式只能是「手动」或「定时」")
    enabled = _bool(body.get("enabled"), previous.get("enabled", kind == "schedule"))
    raw = body.get("schedule") if body.get("schedule") is not None else previous.get("schedule", DEFAULT_SCHEDULE)
    if not isinstance(raw, dict):
        raise TriggerError("定时设置的格式不对")
    repeat = raw.get("repeat") or "daily"
    if repeat not in REPEATS:
        raise TriggerError("重复方式只能是每天、每个工作日或每周")
    hour, minute = parse_time(raw.get("time") or DEFAULT_SCHEDULE["time"])
    schedule = {"repeat": repeat, "time": f"{hour:02d}:{minute:02d}"}
    weekday = raw.get("weekday")
    if repeat == "weekly":
        if isinstance(weekday, bool) or not isinstance(weekday, (int, str)) or not str(weekday).strip().isdigit() \
                or not 1 <= int(weekday) <= 7:
            raise TriggerError("每周要选星期几（周一到周日）")
        schedule["weekday"] = int(weekday)
    inputs_raw = body.get("inputs") if body.get("inputs") is not None else previous.get("inputs", {})
    if not isinstance(inputs_raw, dict):
        raise TriggerError("预填的输入格式不对")
    inputs = {}
    for key, value in inputs_raw.items():
        if not isinstance(key, str) or not re.match(r"^[a-z][a-z0-9_]{0,23}$", key):
            continue
        if value is None or value == "":
            continue
        if isinstance(value, dict):
            raise TriggerError("定时运行没法带文件，文件这一项会留空")
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise TriggerError("预填的输入只能是文字或数字")
        if isinstance(value, str):
            value = value.replace("\r\n", "\n").strip()
            if len(value) > MAX_INPUT_CHARS:
                raise TriggerError(f"预填的输入每项最多 {MAX_INPUT_CHARS} 个字")
        inputs[key] = value
    if len(inputs) > MAX_INPUTS:
        raise TriggerError(f"预填的输入最多 {MAX_INPUTS} 项")
    notify_raw = body.get("notify") if body.get("notify") is not None else previous.get("notify", DEFAULT_NOTIFY)
    if not isinstance(notify_raw, dict):
        raise TriggerError("通知设置的格式不对")
    notify = {"feishu": _bool(notify_raw.get("feishu"), False), "desktop": _bool(notify_raw.get("desktop"), False)}
    return {"kind": kind, "enabled": bool(enabled and kind == "schedule"), "schedule": schedule, "inputs": inputs,
            "notify": notify}


def check_inputs(settings: dict, graph: dict) -> dict:
    """按流程开始节点的输入核对预填值：去掉不认识的、数字 / 选项要合法；开着定时时必填项不能空、不能要求上传文件。"""
    start = next((n for n in (graph or {}).get("nodes") or [] if n.get("id") == "start"), None)
    fields = [f for f in ((start or {}).get("data") or {}).get("fields") or [] if isinstance(f, dict)]
    by_key = {f.get("key"): f for f in fields}
    inputs = {}
    for key, value in settings["inputs"].items():
        field = by_key.get(key)
        if field is None or field.get("type") == "file":
            continue
        label_text = field.get("label") or key
        if field.get("type") == "number":
            try:
                number = float(str(value).replace(",", "").strip())
            except ValueError:
                raise TriggerError(f"「{label_text}」要填数字") from None
            value = int(number) if number.is_integer() else number
        elif field.get("type") == "select" and str(value) not in (field.get("options") or []):
            raise TriggerError(f"「{label_text}」只能从选项里选：{'、'.join(field.get('options') or [])}")
        inputs[key] = value
    settings = {**settings, "inputs": inputs}
    if settings["enabled"]:
        files = [f.get("label") or f.get("key") for f in fields if f.get("type") == "file" and f.get("required")]
        if files:
            raise TriggerError(f"这个流程开头要上传「{'、'.join(files)}」，定时运行没法自动上传文件："
                               "把它改成可选，或换成文字输入再开定时")
        missing = [f.get("label") or f.get("key") for f in fields
                   if f.get("required") and f.get("type") != "file" and f.get("key") not in inputs
                   and f.get("default") in (None, "")]
        if missing:
            raise TriggerError(f"定时运行时没人填，先在这里填好：{'、'.join(missing)}")
    return settings


# ---------- 存取 ----------

def _loads(raw) -> dict:
    try:
        value = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


class TriggerStore:
    """tenant_flow_triggers 读写（连接与迁移复用 TenantStore）。owner_id 显式传入：调度线程没有租户上下文。"""

    def __init__(self, tenant_factory=TenantStore):
        self.tenant_factory = tenant_factory

    def _connect(self):
        return self.tenant_factory()._connect()

    @staticmethod
    def _row(row) -> dict | None:
        if row is None:
            return None
        data = dict(row)
        data["config"] = _loads(data.get("config"))
        data["enabled"] = bool(data.get("enabled"))
        return data

    def get(self, owner_id: str, flow_id: str) -> dict | None:
        with self._connect() as c:
            row = c.execute("SELECT * FROM tenant_flow_triggers WHERE owner_id=? AND flow_id=?",
                            (owner_id, flow_id)).fetchone()
        return self._row(row)

    def save(self, owner_id: str, flow_id: str, *, kind: str, enabled: bool, config: dict,
             next_run_at: str | None) -> dict:
        now = to_iso(utc_now())
        with self._connect() as c:
            c.execute("INSERT INTO tenant_flow_triggers(owner_id, flow_id, kind, config, enabled, next_run_at, updated_at)"
                      " VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id, flow_id) DO UPDATE SET kind=excluded.kind,"
                      " config=excluded.config, enabled=excluded.enabled, next_run_at=excluded.next_run_at,"
                      " updated_at=excluded.updated_at",
                      (owner_id, flow_id, kind, json.dumps(config, ensure_ascii=False), int(enabled), next_run_at, now))
        return self.get(owner_id, flow_id)

    def delete(self, owner_id: str, flow_id: str) -> None:
        with self._connect() as c:
            c.execute("DELETE FROM tenant_flow_triggers WHERE owner_id=? AND flow_id=?", (owner_id, flow_id))

    def due(self, now_iso: str) -> list[dict]:
        """到点且开着的定时触发器（跨账号），带流程名；流程已删的 flow_name 为 None。"""
        with self._connect() as c:
            rows = c.execute(
                "SELECT t.*, f.name AS flow_name FROM tenant_flow_triggers t LEFT JOIN tenant_flows f"
                " ON f.owner_id=t.owner_id AND f.id=t.flow_id"
                " WHERE t.enabled=1 AND t.kind='schedule' AND t.next_run_at IS NOT NULL AND t.next_run_at<=?"
                " ORDER BY t.next_run_at", (now_iso,)).fetchall()
        return [self._row(r) for r in rows]

    def reschedule(self, owner_id: str, flow_id: str, next_run_at: str | None, *, expect: str | None = None) -> bool:
        """改下次运行时间；给了 expect 就只在没被别人改过时才改（用户刚好在改设置不覆盖）。"""
        sql = "UPDATE tenant_flow_triggers SET next_run_at=? WHERE owner_id=? AND flow_id=? AND enabled=1"
        args: list = [next_run_at, owner_id, flow_id]
        if expect is not None:
            sql += " AND next_run_at=?"
            args.append(expect)
        with self._connect() as c:
            return bool(c.execute(sql, args).rowcount)

    def finish(self, owner_id: str, flow_id: str, *, ok: bool, error: str, at: str) -> dict | None:
        """写这次的结果；连续失败到上限就暂停。返回更新后的行（触发器已被删掉时返回 None）。"""
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                row = c.execute("SELECT * FROM tenant_flow_triggers WHERE owner_id=? AND flow_id=?",
                                (owner_id, flow_id)).fetchone()
                if row is None:
                    c.rollback()
                    return None
                config = _loads(row["config"])
                enabled, next_run_at = bool(row["enabled"]), row["next_run_at"]
                if ok:
                    config.update(fail_streak=0, last_error="")
                else:
                    config["fail_streak"] = int(config.get("fail_streak") or 0) + 1
                    config["last_error"] = error[:200]
                    if enabled and config["fail_streak"] >= MAX_FAIL_STREAK:
                        enabled, next_run_at = False, None
                        config["paused_reason"] = (f"连续 {config['fail_streak']} 次没跑成，已暂停定时。"
                                                   f"最近一次的原因：{error[:120] or '流程出错了'}")
                c.execute("UPDATE tenant_flow_triggers SET config=?, enabled=?, next_run_at=?, last_run_at=?,"
                          " last_status=? WHERE owner_id=? AND flow_id=?",
                          (json.dumps(config, ensure_ascii=False), int(enabled), next_run_at, at,
                           "ok" if ok else "error", owner_id, flow_id))
                c.commit()
            except Exception:
                c.rollback()
                raise
        return self.get(owner_id, flow_id)


# ---------- 接口视图 ----------

def settings_of(row: dict | None) -> dict:
    if row is None:
        return {"kind": "manual", "enabled": False, "schedule": dict(DEFAULT_SCHEDULE), "inputs": {},
                "notify": dict(DEFAULT_NOTIFY)}
    config = row["config"]
    schedule = config.get("schedule") if isinstance(config.get("schedule"), dict) else dict(DEFAULT_SCHEDULE)
    return {"kind": row["kind"] if row["kind"] in KINDS else "schedule", "enabled": row["enabled"],
            "schedule": schedule, "inputs": config.get("inputs") if isinstance(config.get("inputs"), dict) else {},
            "notify": config.get("notify") if isinstance(config.get("notify"), dict) else dict(DEFAULT_NOTIFY)}


def view(row: dict | None, now: dt.datetime | None = None) -> dict:
    """接口返回的 trigger：契约字段 + next_run_label / upcoming / note / last_error / paused_reason。"""
    now = now or utc_now()
    settings = settings_of(row)
    schedule = settings["schedule"]
    config = (row or {}).get("config") or {}
    out = {**settings, "schedule": {"repeat": schedule.get("repeat") or "daily",
                                    "time": schedule.get("time") or DEFAULT_SCHEDULE["time"],
                                    "weekday": int(schedule.get("weekday") or 1)}}
    out["label"] = label(schedule) if settings["kind"] == "schedule" else "手动运行"
    next_at = from_iso((row or {}).get("next_run_at")) if settings["enabled"] else None
    out["next_run_at"] = local(next_at).isoformat(timespec="seconds") if next_at else None
    out["next_run_label"] = when_label(next_at, now) if next_at else ""
    try:
        out["upcoming"] = [local(x).isoformat(timespec="seconds") for x in upcoming(schedule, now)] \
            if settings["enabled"] else []
    except TriggerError:
        out["upcoming"] = []
    out["note"] = "法定节假日不跑，调休上班的周末照常跑" if schedule.get("repeat") == "weekdays" else ""
    last = from_iso((row or {}).get("last_run_at"))
    out["last_run_at"] = local(last).isoformat(timespec="seconds") if last else None
    out["last_status"] = (row or {}).get("last_status") or ""
    out["last_error"] = config.get("last_error") or ""
    out["paused_reason"] = "" if settings["enabled"] else (config.get("paused_reason") or "")
    return out


def apply(store: TriggerStore, owner_id: str, flow_id: str, settings: dict, *, origin: str = "",
          now: dt.datetime | None = None) -> dict:
    """保存设置（PUT）：清掉连续失败次数与暂停原因（用户已经处理过）；返回新行。"""
    now = now or utc_now()
    previous = store.get(owner_id, flow_id)
    config = dict((previous or {}).get("config") or {})
    config.update(schedule=settings["schedule"], inputs=settings["inputs"], notify=settings["notify"])
    config.pop("label", None)
    if origin.startswith(("http://", "https://")):
        config["origin"] = origin.rstrip("/")
    config.update(fail_streak=0, paused_reason="")   # 用户动过设置（重新开启或改成手动）：暂停原因与失败计数都清掉
    next_at = to_iso(next_run(settings["schedule"], now)) if settings["enabled"] else None
    return store.save(owner_id, flow_id, kind=settings["kind"], enabled=settings["enabled"], config=config,
                      next_run_at=next_at)


# ---------- 通知 ----------

def _absolute(url: str, origin: str) -> str:
    if not url:
        return ""
    if url.startswith(("http://", "https://")):
        return url
    base = os.getenv("JARVIS_PUBLIC_URL", "").strip().rstrip("/") or origin
    return f"{base}{url}" if base.startswith(("http://", "https://")) and url.startswith("/") else ""


def _summary(text: str) -> str:
    from jarvis.flows.steps import clip, plain_text
    return clip(plain_text(text or "").strip(), SUMMARY_CHARS)


def message(flow_name: str, result: dict, config: dict, *, paused: bool = False) -> tuple[str, str]:
    """(完整消息, 一行标题)：飞书发完整消息，桌面通知用标题。"""
    name = flow_name or "流程"
    if paused:
        reason = config.get("paused_reason") or "连续几次没跑成"
        text = f"⏸️ 定时流程「{name}」{reason}\n到「我的流程」里看看哪一步出了问题，修好后重新开启定时。"
        return text, f"「{name}」的定时运行已暂停"
    if result.get("status") != "ok":
        error = result.get("error") or "流程出错了"
        text = f"⚠️ 定时流程「{name}」这次没跑成：{error}\n打开「我的流程」看看是哪一步出了问题。"
        return text, f"「{name}」这次没跑成：{error}"[:80]
    output = result.get("output") or {}
    summary = _summary(output.get("text") or "")
    link = _absolute(output.get("page_url") or "", config.get("origin") or "")
    parts = [f"⏰ 定时流程「{name}」跑完了", summary]
    if link:
        parts.append(f"结果网页：{link}")
    elif output.get("page_url"):
        parts.append("结果网页在「我的流程」的运行记录里")
    text = "\n\n".join(p for p in parts if p)
    lines = [x.strip(" •") for x in summary.splitlines()
             if x.strip(" •") and not re.fullmatch(r"【[^】]*】", x.strip())]   # 跳过「【小标题】」行
    first = lines[0] if lines else "已完成"
    return text, f"「{name}」跑完了：{first}"[:80]


def deliver(*, owner_id: str, notify: dict, text: str, title: str, deps=None, notifier=None,
            now: dt.datetime | None = None) -> list[str]:
    """按触发器自己的 notify 送达（用户亲手设的定时，不受免打扰与全局渠道开关影响）；返回送达了的渠道。"""
    sent = []
    if notify.get("feishu") and deps is not None:
        try:
            if deps.feishu_ready(owner_id) and deps.push_feishu(owner_id, text):
                sent.append("feishu")
        except Exception as exc:
            log.warning("flow trigger feishu push failed: %s", type(exc).__name__)
    if notify.get("desktop") and notifier is not None:
        when = local(now or utc_now()).strftime("%Y-%m-%d %H:%M")
        try:
            push = getattr(notifier, "push_desktop", None)
            if push is not None:
                push(owner_id, title, when)
                sent.append("desktop")
            else:   # delivery.Notifier 的网页 / 桌面领取箱（与巡检消息同一出口）
                outbox = getattr(notifier, "_outbox", None)
                if outbox is not None:
                    outbox.put(owner_id, title, when)
                    sent.append("desktop")
        except Exception as exc:
            log.warning("flow trigger desktop notify failed: %s", type(exc).__name__)
    return sent


# ---------- 后台调度 ----------

class FlowScheduler:
    """每 ~30 秒查一次到点的触发器并执行；``sync=True`` 时在当前线程里跑（测试用）。"""

    thread_name = "jarvis-flow-scheduler"

    def __init__(self, *, runtime, notifier=None, store: TriggerStore | None = None, interval: float = TICK_SECONDS,
                 now_fn=utc_now, sync: bool = False, max_workers: int = 4, startup_delay: float = STARTUP_DELAY):
        self._runtime = runtime
        self.notifier = notifier
        self.store = store or TriggerStore()
        self.interval = interval
        self.now_fn = now_fn
        self.sync = sync
        self.startup_delay = startup_delay
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._pool = None if sync else ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="jarvis-flow-cron")
        self._inflight: set[tuple[str, str]] = set()
        self._lock = threading.Lock()

    # ---- 生命周期 ----

    def start(self) -> "FlowScheduler":
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name=self.thread_name, daemon=True)
            self._thread.start()
        return self

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _loop(self) -> None:
        if self._stop.wait(self.startup_delay):
            return
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as exc:   # 一轮出错不能让调度线程死掉
                log.exception("flow scheduler tick failed: %s", type(exc).__name__)
            if self._stop.wait(self.interval):
                return

    # ---- 一轮 ----

    def runtime(self):
        try:
            return self._runtime() if callable(self._runtime) else self._runtime
        except Exception:
            return None

    def tick(self, now: dt.datetime | None = None) -> int:
        """查到点的触发器并派发；返回这轮开跑的个数。"""
        now = now or self.now_fn()
        runtime = self.runtime()
        if runtime is None or not hasattr(runtime, "run_headless"):
            return 0
        started = 0
        for row in self.store.due(to_iso(now)):
            owner_id, flow_id = row["owner_id"], row["flow_id"]
            key = (owner_id, flow_id)
            with self._lock:
                if key in self._inflight:
                    continue
            if row.get("flow_name") is None:   # 流程已经删了：触发器一并清掉
                self.store.delete(owner_id, flow_id)
                continue
            settings = settings_of(row)
            due_at = from_iso(row["next_run_at"]) or now
            try:
                following = next_run(settings["schedule"], now)
            except TriggerError:
                self.store.reschedule(owner_id, flow_id, None)
                continue
            if not self.store.reschedule(owner_id, flow_id, to_iso(following), expect=row["next_run_at"]):
                continue   # 用户刚改过设置：以新设置为准
            if now - due_at > STALE_AFTER:   # 服务停了太久：错过的不补跑，直接排下一次
                log.info("flow trigger %s missed %s, next %s", flow_id, row["next_run_at"], to_iso(following))
                continue
            with self._lock:
                self._inflight.add(key)
            started += 1
            job = (owner_id, flow_id, row.get("flow_name") or "", settings, following)
            if self._pool is None:
                self._run(*job)
            else:
                self._pool.submit(self._run, *job)
        return started

    def _run(self, owner_id: str, flow_id: str, flow_name: str, settings: dict, following: dt.datetime) -> None:
        try:
            runtime = self.runtime()
            try:
                result = runtime.run_headless(owner_id, flow_id, dict(settings["inputs"]))
            except Exception as exc:
                log.exception("flow trigger run failed: %s", type(exc).__name__)
                result = {"status": "error", "error": "流程运行出了点问题，请稍后再试"}
            if not isinstance(result, dict):
                result = {"status": "error", "error": "流程运行出了点问题，请稍后再试"}
            status = result.get("status")
            if status == "busy":   # 这个账号正在跑别的流程：顺延一分钟（不晚于下一次正常运行）
                retry = min(self.now_fn() + BUSY_RETRY, following)
                self.store.reschedule(owner_id, flow_id, to_iso(retry), expect=to_iso(following))
                return
            ok = status == "ok"
            error = "" if ok else str(result.get("error") or "流程出错了")
            before = self.store.get(owner_id, flow_id)
            row = self.store.finish(owner_id, flow_id, ok=ok, error=error, at=to_iso(self.now_fn()))
            if row is None:
                return
            paused = bool(before and before["enabled"]) and not row["enabled"] and not ok
            config = row["config"] if isinstance(row["config"], dict) else _loads(row["config"])
            streak = int(config.get("fail_streak") or 0) if not ok else 0
            if not ok and not paused and streak > 1:   # 连续失败只在第一次和暂停时各通知一次，中间几次不打扰
                return
            notify = settings_of(row)["notify"]
            text, title = message(flow_name, result, row["config"], paused=paused)
            deps = getattr(runtime, "deps", None)
            deliver(owner_id=owner_id, notify=notify, text=text, title=title, deps=deps, notifier=self.notifier,
                    now=self.now_fn())
        except Exception as exc:
            log.exception("flow trigger finish failed: %s", type(exc).__name__)
        finally:
            with self._lock:
                self._inflight.discard((owner_id, flow_id))
