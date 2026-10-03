"""用量、配额与管理告警（第二十轮，归「用量与配额」代理；契约 §5）。

- 记账：模型调用（次数、输入 / 输出 token、估算费用）按账号、按天（服务器本地日期）、按类别
  （chat / flow / compose / voice / other）写 ``usage_daily``；流程运行次数与失败次数同表（kind=flow_run）。
  模型调用由 ``UsageCallback``（挂在 provider_runtime 建的 ChatOpenAI 上，按 bundle 的账号）读
  ``usage_metadata`` 记下；类别取 ``kind_scope`` 的当前值，默认 chat。先记在内存里，后台线程每隔几秒
  攒批落库（进程退出前再刷一次），不拖慢对话；记账出任何错都只记日志。
- 配额：``tenant_quotas`` 每账号每天的模型调用与流程运行上限（null 用环境变量默认值，-1 = 不限，
  Owner 永远不限）；超了在对话 / 流程入口给人话提示，并给管理员发一条告警（每账号每天一次）。
- 告警：定时流程被自动暂停 / 连续失败、渠道（飞书 / 微信）断开超过 5 分钟、配额用尽，写 ``admin_alerts``
  （同类同账号 1 小时内合并成一条）并推给 Owner（Notifier：桌面通知 + 飞书 / 微信按 Owner 的送达设置）。
  告警 kind：quota_model / quota_flow / flow_paused / flow_failing / channel_feishu / channel_wechat。
- 接口：``GET /api/admin/usage``、``PUT /api/admin/quotas/{user_id}``、``GET /api/admin/alerts``、
  ``POST /api/admin/alerts/read``（以上仅 Owner）、``GET /api/usage/me``（任意登录账号）。

其他模块只调 ``register / kind_scope / check_model / check_flow_run / record_flow_run / alert``
（签名不变）；server.py 另用 ``configure``（推送与渠道巡检）、``start_watch`` / ``shutdown``。
"""
from __future__ import annotations

import atexit
import datetime as dt
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Callable

from fastapi import Body, Request
from fastapi.responses import JSONResponse
from langchain_core.callbacks import BaseCallbackHandler

from jarvis import config
from jarvis.tenancy import TenantStore

log = logging.getLogger(__name__)

# ---------- 类别 ----------

KIND_LABELS = {"chat": "对话", "flow": "流程", "compose": "一句话生成", "voice": "语音", "other": "后台任务"}
MAIN_KINDS = ("chat", "flow", "compose", "voice")   # 后台总在 by_kind 里列出的类别（没用量也给 0）
FLOW_RUN = "flow_run"
_KIND_RE = re.compile(r"^[a-z][a-z0-9_]{0,19}$")
_KIND: ContextVar[str] = ContextVar("jarvis_usage_kind", default="chat")

MODEL_QUOTA_MESSAGE = "今天的用量到上限了，明天再来，或请管理员调高"
FLOW_QUOTA_MESSAGE = "今天跑流程的次数到上限了，明天再来，或请管理员调高"


class QuotaExceeded(RuntimeError):
    """入口在拿模型前发现配额用完时抛出（如语音通话）；message 就是给用户看的人话。"""

    def __init__(self, message: str = MODEL_QUOTA_MESSAGE) -> None:
        super().__init__(message)
        self.message = message

# 管理后台「最近活跃」不看后台服务线程（心跳 / 晨报 / 记忆整理 / 会议纪要每次都会刷新它们）
_SERVICE_ALIASES = ("radio", "heartbeat", "distill", "meeting")


def _clean_kind(kind) -> str:
    value = str(kind or "").strip().lower()
    if not _KIND_RE.match(value) or value == FLOW_RUN:
        return "other"
    return value


@contextmanager
def kind_scope(kind: str):
    """把这段代码里的模型调用记到某个类别（flow / compose / voice …）；默认 chat。

    contextvar：同线程、asyncio 任务、copy_context 提交的线程池里都跟着走；
    裸 ``threading.Thread`` / 普通 ``ThreadPoolExecutor.submit`` 不会继承，要在新线程里再包一层。"""
    token = _KIND.set(_clean_kind(kind))
    try:
        yield
    finally:
        _KIND.reset(token)


def current_kind() -> str:
    return _KIND.get()


# ---------- 时间 ----------

_clock: Callable[[], dt.datetime] = dt.datetime.now   # 本地时间；测试可替换


def _today() -> dt.date:
    return _clock().date()


def _utc(moment: dt.datetime | None = None) -> dt.datetime:
    return (moment or _clock()).astimezone(dt.timezone.utc)


def _iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def _local_midnight_utc(day: dt.date) -> str:
    return _iso(dt.datetime.combine(day, dt.time()).astimezone())


# ---------- 价格（估算） ----------

DEFAULT_PRICE_INPUT = 2.0     # 元 / 百万 token；参考 DeepSeek 公开价（默认模型是 DeepSeek）
DEFAULT_PRICE_OUTPUT = 3.0
CACHED_INPUT_RATIO = 0.1      # 命中缓存的输入按输入价的一成算（DeepSeek：0.2 / 2 元）


def _env_price(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        log.warning("%s=%r 不是数字，按默认价 %s 估算", name, raw, default)
        return default
    if not 0 <= value <= 100000:
        log.warning("%s=%r 超出范围，按默认价 %s 估算", name, raw, default)
        return default
    return value


def pricing() -> dict:
    price_in = _env_price("JARVIS_PRICE_INPUT_PER_M", DEFAULT_PRICE_INPUT)
    price_out = _env_price("JARVIS_PRICE_OUTPUT_PER_M", DEFAULT_PRICE_OUTPUT)
    price_cached = _env_price("JARVIS_PRICE_CACHED_INPUT_PER_M", round(price_in * CACHED_INPUT_RATIO, 6))
    note = (f"费用是估算：每百万 token 输入 {price_in:g} 元（命中缓存的部分 {price_cached:g} 元）、输出 {price_out:g} 元，"
            "实际以模型服务商的账单为准。默认价参考 DeepSeek 公开价，可用环境变量 "
            "JARVIS_PRICE_INPUT_PER_M / JARVIS_PRICE_OUTPUT_PER_M 调整。")
    return {"input_per_m": price_in, "output_per_m": price_out, "cached_input_per_m": price_cached,
            "currency": "CNY", "note": note}


def cost_micros(input_tokens: int, output_tokens: int, cached_tokens: int = 0, *, prices: dict | None = None) -> int:
    """估算费用，单位百万分之一元：token 数 × 每百万 token 的元价，正好就是「微元」。"""
    p = prices or pricing()
    cached = max(0, min(int(cached_tokens), int(input_tokens)))
    fresh = max(0, int(input_tokens) - cached)
    return int(round(fresh * p["input_per_m"] + cached * p["cached_input_per_m"]
                     + max(0, int(output_tokens)) * p["output_per_m"]))


def _yuan(micros: int) -> float:
    return round(int(micros or 0) / 1_000_000, 4)


# ---------- 内存账本：攒批落库 ----------

FLUSH_SECONDS = 5.0
FLUSH_BATCH = 200      # 待落库的格子（账号 × 天 × 类别）超过这么多就提前刷
_FIELDS = ("calls", "input_tokens", "output_tokens", "failures", "cost_micros")
_UPSERT = (
    "INSERT INTO usage_daily(owner_id, day, kind, calls, input_tokens, output_tokens, failures, cost_micros) "
    "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id, day, kind) DO UPDATE SET "
    "calls=calls+excluded.calls, input_tokens=input_tokens+excluded.input_tokens, "
    "output_tokens=output_tokens+excluded.output_tokens, failures=failures+excluded.failures, "
    "cost_micros=cost_micros+excluded.cost_micros"
)


class _Ledger:
    """待落库的用量：键 (库路径, 账号, 日期, 类别) → [calls, input, output, failures, cost_micros]。

    记一笔只是内存里加几个数；后台线程每 FLUSH_SECONDS 秒（或攒够 FLUSH_BATCH 格）批量 UPSERT。
    库被锁等临时错误整批放回去下次再写；账号已删（外键失败）的那几格丢掉。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: dict[tuple[str, str, str, str], list[int]] = {}
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def add(self, path: str, owner: str, day: str, kind: str, values: tuple[int, ...]) -> None:
        with self._lock:
            row = self._pending.setdefault((path, owner, day, kind), [0] * len(_FIELDS))
            for index, value in enumerate(values):
                row[index] += int(value)
            size = len(self._pending)
        self._ensure_thread()
        if size >= FLUSH_BATCH:
            self._wake.set()

    def pending(self, path: str, owner: str, day: str) -> dict[str, list[int]]:
        with self._lock:
            return {key[3]: list(values) for key, values in self._pending.items()
                    if key[0] == path and key[1] == owner and key[2] == day}

    def flush(self) -> int:
        with self._lock:
            batch, self._pending = self._pending, {}
        if not batch:
            return 0
        by_path: dict[str, list] = {}
        for (path, owner, day, kind), values in batch.items():
            by_path.setdefault(path, []).append(((owner, day, kind), values))
        written = 0
        for path, items in by_path.items():
            if not Path(path).exists():    # 库已不在（测试的临时目录）：不凭空建库
                continue
            try:
                written += self._write(path, items)
            except Exception as exc:
                log.warning("usage flush failed, will retry: %s", type(exc).__name__)
                with self._lock:
                    for (owner, day, kind), values in items:
                        row = self._pending.setdefault((path, owner, day, kind), [0] * len(_FIELDS))
                        for index, value in enumerate(values):
                            row[index] += value
        return written

    @staticmethod
    def _write(path: str, items: list) -> int:
        written = 0
        with TenantStore(Path(path))._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                for (owner, day, kind), values in items:
                    try:
                        c.execute(_UPSERT, (owner, day, kind, *values))
                        written += 1
                    except sqlite3.IntegrityError:
                        log.info("usage row dropped: account no longer exists")
                c.commit()
            except Exception:
                c.rollback()
                raise
        return written

    def _ensure_thread(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="jarvis-usage-flush", daemon=True)
            self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(FLUSH_SECONDS)
            self._wake.clear()
            try:
                self.flush()
            except Exception as exc:   # 记账线程不能死
                log.warning("usage flush loop error: %s", type(exc).__name__)

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=3)
        self.flush()

    def clear(self) -> None:
        with self._lock:
            self._pending.clear()


_ledger = _Ledger()


def flush() -> int:
    """把内存里的用量立刻写进库（管理后台读之前、进程退出前调用）；返回写了几格。"""
    try:
        return _ledger.flush()
    except Exception as exc:
        log.warning("usage flush failed: %s", type(exc).__name__)
        return 0


atexit.register(flush)


def _store_path() -> str:
    return str(TenantStore().path)


def record_model_call(user_id: str, input_tokens: int = 0, output_tokens: int = 0, cached_tokens: int = 0, *,
                      kind: str | None = None, ok: bool = True) -> None:
    """记一次模型调用（成功记 calls + token + 费用；失败只记 failures，不占配额）。"""
    try:
        if not isinstance(user_id, str) or not user_id:
            return
        kind = _clean_kind(kind) if kind is not None else current_kind()
        input_tokens, output_tokens = max(0, int(input_tokens or 0)), max(0, int(output_tokens or 0))
        if ok:
            values = (1, input_tokens, output_tokens, 0, cost_micros(input_tokens, output_tokens, cached_tokens or 0))
        else:
            values = (0, 0, 0, 1, 0)
        _ledger.add(_store_path(), user_id, _today().isoformat(), kind, values)
    except Exception as exc:
        log.warning("usage record failed: %s", type(exc).__name__)


def record_flow_run(user_id: str, ok: bool) -> None:
    """记一次流程运行（成功 / 失败）。"""
    try:
        if not isinstance(user_id, str) or not user_id:
            return
        _ledger.add(_store_path(), user_id, _today().isoformat(), FLOW_RUN, (1, 0, 0, 0 if ok else 1, 0))
    except Exception as exc:
        log.warning("flow run record failed: %s", type(exc).__name__)


# ---------- 模型回调 ----------

def _as_int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def tokens_from_result(response) -> tuple[int, int, int]:
    """LLMResult → (输入, 输出, 其中命中缓存的输入)。优先 message.usage_metadata，没有再看 llm_output.token_usage。"""
    total_in = total_out = total_cached = 0
    found = False
    for generations in getattr(response, "generations", None) or []:
        for generation in generations or []:
            meta = getattr(getattr(generation, "message", None), "usage_metadata", None)
            if not meta:
                continue
            found = True
            total_in += _as_int(meta.get("input_tokens"))
            total_out += _as_int(meta.get("output_tokens"))
            total_cached += _as_int((meta.get("input_token_details") or {}).get("cache_read"))
    if found:
        return total_in, total_out, total_cached
    usage = (getattr(response, "llm_output", None) or {}).get("token_usage") or {}
    if not isinstance(usage, dict):
        return 0, 0, 0
    details = usage.get("prompt_tokens_details") or {}
    cached = _as_int(details.get("cached_tokens") if isinstance(details, dict) else 0) \
        or _as_int(usage.get("prompt_cache_hit_tokens"))
    return _as_int(usage.get("prompt_tokens")), _as_int(usage.get("completion_tokens")), cached


class UsageCallback(BaseCallbackHandler):
    """挂在每个账号运行时的模型上：每次模型调用结束记一笔（账号固定，类别取 kind_scope）。"""

    raise_error = False
    run_inline = True     # 异步调用也在当前上下文里同步执行：只是内存里加几个数

    def __init__(self, user_id: str) -> None:
        super().__init__()
        self.user_id = user_id

    def on_llm_end(self, response, **kwargs: Any) -> None:
        try:
            input_tokens, output_tokens, cached = tokens_from_result(response)
            record_model_call(self.user_id, input_tokens, output_tokens, cached)
        except Exception as exc:
            log.warning("usage callback failed: %s", type(exc).__name__)

    def on_llm_error(self, error: BaseException, **kwargs: Any) -> None:
        record_model_call(self.user_id, ok=False)


def stream_usage_enabled() -> bool:
    """流式调用也让服务商回 token 用量（stream_options.include_usage）；个别不支持的服务商可设 JARVIS_STREAM_USAGE=0。"""
    return os.getenv("JARVIS_STREAM_USAGE", "1").strip() != "0"


# ---------- 配额 ----------

QUOTA_FIELDS = ("daily_model_calls", "daily_flow_runs")
UNLIMITED = -1
MAX_QUOTA = 1_000_000


def default_quotas() -> dict:
    return {
        "daily_model_calls": config.env_int("JARVIS_DEFAULT_DAILY_MODEL_CALLS", 300, minimum=0, maximum=MAX_QUOTA),
        "daily_flow_runs": config.env_int("JARVIS_DEFAULT_DAILY_FLOW_RUNS", 100, minimum=0, maximum=MAX_QUOTA),
    }


def quota_view(role: str | None, stored: tuple | None, *, defaults: dict | None = None) -> dict:
    """配额对外视图：两个上限（null = 不限）+ source（custom / default / unlimited）。

    额外给 ``sources``（每项各自的来源）与 ``defaults``（默认值），后台弹层据此回显「不限 / 用默认 / 自定义」。"""
    defaults = defaults or default_quotas()
    if role == "Owner":
        return {"daily_model_calls": None, "daily_flow_runs": None, "source": "unlimited",
                "sources": {field: "unlimited" for field in QUOTA_FIELDS}, "defaults": defaults}
    view: dict[str, Any] = {}
    sources: dict[str, str] = {}
    for field, value in zip(QUOTA_FIELDS, stored or (None, None)):
        if value is None:
            view[field], sources[field] = defaults[field], "default"
        elif int(value) < 0:
            view[field], sources[field] = None, "unlimited"
        else:
            view[field], sources[field] = int(value), "custom"
    kinds = set(sources.values())
    view["source"] = "default" if kinds == {"default"} else "unlimited" if kinds == {"unlimited"} else "custom"
    view["sources"] = sources
    view["defaults"] = defaults
    return view


def _stored_quota(c, owner: str) -> tuple | None:
    row = c.execute("SELECT daily_model_calls, daily_flow_runs FROM tenant_quotas WHERE owner_id=?", (owner,)).fetchone()
    return (row["daily_model_calls"], row["daily_flow_runs"]) if row else None


def _today_counts(c, path: str, owner: str, day: str) -> dict:
    calls = runs = 0
    for row in c.execute("SELECT kind, calls FROM usage_daily WHERE owner_id=? AND day=?", (owner, day)):
        if row["kind"] == FLOW_RUN:
            runs += int(row["calls"])
        else:
            calls += int(row["calls"])
    for kind, values in _ledger.pending(path, owner, day).items():
        if kind == FLOW_RUN:
            runs += values[0]
        else:
            calls += values[0]
    return {"calls": calls, "flow_runs": runs}


def usage_status(user_id: str) -> dict:
    """某账号今天的用量、配额与剩余（/api/usage/me 与配额检查共用）。"""
    store = TenantStore()
    day = _today().isoformat()
    with store._connect() as c:
        row = c.execute("SELECT role FROM users WHERE id=?", (user_id,)).fetchone()
        role = row["role"] if row else None
        quota = quota_view(role, _stored_quota(c, user_id))
        today = _today_counts(c, str(store.path), user_id, day)
    remaining = {
        "calls": None if quota["daily_model_calls"] is None else max(0, quota["daily_model_calls"] - today["calls"]),
        "flow_runs": None if quota["daily_flow_runs"] is None else max(0, quota["daily_flow_runs"] - today["flow_runs"]),
    }
    return {"today": today, "quota": quota, "remaining": remaining, "role": role}


def _check(user_id: str, field: str) -> str | None:
    if not isinstance(user_id, str) or not user_id:
        return None
    try:
        status = usage_status(user_id)
        if status["role"] is None:      # 查不到账号：不归配额管（不拦）
            return None
        limit = status["quota"][field]
        used = status["today"]["calls" if field == "daily_model_calls" else "flow_runs"]
        if limit is None or used < limit:
            return None
    except Exception as exc:            # 配额本身出问题不能把人挡在门外
        log.warning("usage quota check failed: %s", type(exc).__name__)
        return None
    _quota_alert(user_id, field, used, limit)
    return MODEL_QUOTA_MESSAGE if field == "daily_model_calls" else FLOW_QUOTA_MESSAGE


def check_model(user_id: str) -> str | None:
    """今天的模型调用还能不能用：能用返回 None，超了返回给用户看的人话。"""
    return _check(user_id, "daily_model_calls")


def check_flow_run(user_id: str) -> str | None:
    """今天还能不能再跑流程：能跑返回 None，超了返回人话。"""
    return _check(user_id, "daily_flow_runs")


_quota_alerted: set[tuple[str, str, str, str]] = set()
_quota_lock = threading.Lock()


def _quota_alert(user_id: str, field: str, used: int, limit: int) -> None:
    """配额用尽告警：每账号每类每天一次（内存先挡，重启后再查库里今天有没有发过）。"""
    day = _today()
    store = TenantStore()
    key = (str(store.path), user_id, day.isoformat(), field)
    with _quota_lock:
        if key in _quota_alerted:
            return
        _quota_alerted.add(key)
    kind = "quota_model" if field == "daily_model_calls" else "quota_flow"
    try:
        with store._connect() as c:
            row = c.execute("SELECT username FROM users WHERE id=?", (user_id,)).fetchone()
            name = row["username"] if row else user_id[:8]
            if c.execute("SELECT 1 FROM admin_alerts WHERE kind=? AND owner_id=? AND created_at>=?",
                         (kind, user_id, _local_midnight_utc(day))).fetchone():
                return
    except Exception as exc:
        log.warning("quota alert lookup failed: %s", type(exc).__name__)
        return
    what = "模型调用" if field == "daily_model_calls" else "流程运行"
    alert(kind, f"「{name}」今天的{what}次数用完了",
          f"今天已用 {used} 次，上限 {limit} 次。明天自动恢复，也可以在管理后台调高。", owner_id=user_id)


# ---------- 告警 ----------

ALERT_MERGE_SECONDS = 3600
_ALERT_KIND_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_alert_lock = threading.Lock()
_notify: Callable[[str, str], Any] | None = None


def _spawn(work: Callable[[], None]) -> None:
    threading.Thread(target=work, name="jarvis-alert-push", daemon=True).start()


def _clip(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _push(owners: list[str], title: str, detail: str) -> None:
    notify = _notify
    if notify is None or not owners:
        return
    text = f"管理提醒：{title}" + (f"（{_clip(detail, 120)}）" if detail else "")

    def work() -> None:
        for owner in owners:
            try:
                notify(owner, text)
            except Exception as exc:
                log.warning("admin alert push failed: %s", type(exc).__name__)

    _spawn(work)


def alert(kind: str, title: str, detail: str = "", *, owner_id: str | None = None) -> None:
    """记一条管理告警并推给 Owner（同类告警会合并、限频）。

    同 kind、同账号（owner_id，可为空 = 系统级）1 小时内已有一条：更新那条的标题 / 详情并标成未读，不再推送。"""
    try:
        kind = str(kind or "").strip().lower()
        if not _ALERT_KIND_RE.match(kind):
            kind = "other"
        title = _clip(title, 120) or "系统提醒"
        detail = _clip(detail, 1000)
        owner = owner_id if isinstance(owner_id, str) and owner_id else None
        now = _utc()
        cutoff = _iso(now - dt.timedelta(seconds=ALERT_MERGE_SECONDS))
        with _alert_lock, TenantStore()._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                existing = c.execute(
                    "SELECT id FROM admin_alerts WHERE kind=? AND owner_id IS ? AND created_at>=? "
                    "ORDER BY created_at DESC LIMIT 1", (kind, owner, cutoff)).fetchone()
                if existing:
                    c.execute("UPDATE admin_alerts SET title=?, detail=?, read_at=NULL WHERE id=?",
                              (title, detail, existing["id"]))
                else:
                    c.execute("INSERT INTO admin_alerts(id, kind, owner_id, title, detail, created_at) VALUES(?,?,?,?,?,?)",
                              (uuid.uuid4().hex, kind, owner, title, detail, _iso(now)))
                owners = [row["id"] for row in c.execute("SELECT id FROM users WHERE role='Owner' AND active=1")]
                c.commit()
            except Exception:
                c.rollback()
                raise
        if not existing:
            _push(owners, title, detail)
    except Exception as exc:
        log.warning("admin alert failed: %s", type(exc).__name__)


# ---------- 渠道巡检：长连接断开超过 5 分钟告警 ----------

CHANNEL_DOWN_SECONDS = 300
CHANNEL_LABELS = {"feishu": "飞书", "wechat": "微信"}


def feishu_down(status: dict) -> tuple[bool, str]:
    """飞书桥状态 → (断着没有, 原因)。没配置 / 主动停掉的不算。"""
    if not isinstance(status, dict) or not status.get("configured"):
        return False, ""
    if status.get("state") in ("connecting", "reconnecting", "error"):
        return True, str(status.get("error") or "一直连不上飞书")
    return False, ""


def wechat_down(status: dict, failing_seconds: float = 0.0) -> tuple[bool, str]:
    """微信桥状态 → (断着没有, 原因)。用户自己断开（idle 且没有错误）不算；登录态失效、凭据读不了、
    收消息的长轮询一直失败都算。"""
    if not isinstance(status, dict):
        return False, ""
    state, error = status.get("state"), str(status.get("error") or "")
    if state == "error" or (state == "idle" and error):
        return True, error or "微信连接出错"
    if state == "connected" and failing_seconds > 0:
        return True, "收消息一直失败，正在自动重试"
    return False, ""


class ChannelWatch:
    """每分钟看一眼各渠道：连续断开超过 CHANNEL_DOWN_SECONDS 发一条告警；恢复后再断会再发。"""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.channels: dict[str, Callable[[], tuple[bool, str]]] = {}
        self.clock = clock
        self._since: dict[str, float] = {}
        self._alerted: set[str] = set()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def tick(self) -> list[str]:
        now = self.clock()
        fired: list[str] = []
        for name, probe in list(self.channels.items()):
            try:
                down, reason = probe()
            except Exception as exc:
                log.info("channel probe failed (%s): %s", name, type(exc).__name__)
                continue
            if not down:
                self._since.pop(name, None)
                self._alerted.discard(name)
                continue
            since = self._since.setdefault(name, now)
            if now - since >= CHANNEL_DOWN_SECONDS and name not in self._alerted:
                self._alerted.add(name)
                label = CHANNEL_LABELS.get(name, name)
                alert(f"channel_{name}", f"{label}长连接断开超过 5 分钟",
                      f"{_clip(reason, 200)}。这段时间{label}里发给贾维斯的消息收不到，请检查网络或到网页端看连接状态。")
                fired.append(name)
        return fired

    def start(self, interval: float = 60.0) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()

        def loop() -> None:
            while not self._stop.wait(interval):
                try:
                    self.tick()
                except Exception as exc:
                    log.warning("channel watch tick failed: %s", type(exc).__name__)

        self._thread = threading.Thread(target=loop, name="jarvis-channel-watch", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=2)


_watch = ChannelWatch()


def configure(*, notify: Callable[[str, str], Any] | None = None,
              channels: dict[str, Callable[[], tuple[bool, str]]] | None = None) -> None:
    """server.py 注入：notify(owner_user_id, text) 推给 Owner；channels 渠道断线探针 {name: () -> (down, reason)}。"""
    global _notify
    _notify = notify
    if channels is not None:
        _watch.channels = dict(channels)


def start_watch() -> None:
    """起渠道巡检线程（lifespan 里调）；JARVIS_CHANNEL_WATCH_SECONDS=0 关掉。"""
    interval = config.env_int("JARVIS_CHANNEL_WATCH_SECONDS", 60, minimum=0, maximum=3600)
    if interval > 0 and _watch.channels:
        _watch.start(float(interval))


def shutdown() -> None:
    """停巡检与记账线程，并把内存里的用量落库。"""
    _watch.stop()
    try:
        _ledger.stop()
    except Exception as exc:
        log.warning("usage shutdown flush failed: %s", type(exc).__name__)


# ---------- 管理后台统计 ----------

def _bucket() -> dict:
    return {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_micros": 0, "flow_runs": 0, "flow_failures": 0}


def _add_row(bucket: dict, row) -> None:
    if row["kind"] == FLOW_RUN:
        bucket["flow_runs"] += int(row["calls"])
        bucket["flow_failures"] += int(row["failures"])
    else:
        bucket["calls"] += int(row["calls"])
        bucket["input_tokens"] += int(row["input_tokens"])
        bucket["output_tokens"] += int(row["output_tokens"])
        bucket["cost_micros"] += int(row["cost_micros"])


def _public(bucket: dict, *, flows: bool = True) -> dict:
    out = {"calls": bucket["calls"], "input_tokens": bucket["input_tokens"], "output_tokens": bucket["output_tokens"],
           "tokens": bucket["input_tokens"] + bucket["output_tokens"], "cost_yuan": _yuan(bucket["cost_micros"])}
    if flows:
        out.update(flow_runs=bucket["flow_runs"], flow_failures=bucket["flow_failures"])
    return out


def usage_report(days: int, users: list[dict], *, store: TenantStore | None = None) -> dict:
    """GET /api/admin/usage 的内容：最近 days 天（含今天）的合计、每天、按类别、按账号。"""
    flush()
    store = store or TenantStore()
    days = max(1, min(int(days), 90))
    today = _today()
    start = today - dt.timedelta(days=days - 1)
    span = [start + dt.timedelta(days=i) for i in range(days)]
    daily = {day.isoformat(): _bucket() for day in span}
    kinds: dict[str, dict] = {kind: _bucket() for kind in MAIN_KINDS}
    accounts: dict[str, dict] = {}
    today_counts: dict[str, dict] = {}
    with store._connect() as c:
        rows = c.execute("SELECT owner_id, day, kind, calls, input_tokens, output_tokens, failures, cost_micros "
                         "FROM usage_daily WHERE day>=? AND day<=?", (start.isoformat(), today.isoformat())).fetchall()
        quotas = {row["owner_id"]: (row["daily_model_calls"], row["daily_flow_runs"])
                  for row in c.execute("SELECT owner_id, daily_model_calls, daily_flow_runs FROM tenant_quotas")}
        platforms = {row["owner_id"]: {"name": row["name"], "icon": row["icon"]}
                     for row in c.execute("SELECT owner_id, name, icon FROM tenant_platforms")}
        last: dict[str, str] = {}
        marks = ",".join("?" * len(_SERVICE_ALIASES))
        for sql, args in (
            (f"SELECT owner_id, MAX(updated_at) AS at FROM tenant_threads WHERE alias NOT IN ({marks}) GROUP BY owner_id",
             _SERVICE_ALIASES),
            ("SELECT owner_id, MAX(started_at) AS at FROM tenant_flow_runs GROUP BY owner_id", ()),
        ):
            for row in c.execute(sql, args):
                if row["at"] and row["at"] > last.get(row["owner_id"], ""):
                    last[row["owner_id"]] = row["at"]
    totals = _bucket()
    for row in rows:
        _add_row(totals, row)
        _add_row(daily.setdefault(row["day"], _bucket()), row)
        _add_row(accounts.setdefault(row["owner_id"], _bucket()), row)
        if row["kind"] != FLOW_RUN:
            _add_row(kinds.setdefault(row["kind"], _bucket()), row)
        if row["day"] == today.isoformat():
            counts = today_counts.setdefault(row["owner_id"], {"calls": 0, "flow_runs": 0})
            counts["flow_runs" if row["kind"] == FLOW_RUN else "calls"] += int(row["calls"])
    defaults = default_quotas()
    account_rows = []
    for user in users:
        uid = user["id"]
        bucket = accounts.get(uid, _bucket())
        account_rows.append({
            "user_id": uid, "username": user.get("username", ""), "role": user.get("role", ""),
            "active": bool(user.get("active", 1)), "platform": platforms.get(uid),
            **_public(bucket),
            "today": today_counts.get(uid, {"calls": 0, "flow_runs": 0}),
            "quota": quota_view(user.get("role"), quotas.get(uid), defaults=defaults),
            "last_active_at": last.get(uid),
        })
    account_rows.sort(key=lambda item: (-item["cost_yuan"], -item["calls"], -item["flow_runs"], item["username"].lower()))
    active = sum(1 for item in account_rows if item["calls"] or item["flow_runs"])
    return {
        "range": {"days": days, "start": start.isoformat(), "end": today.isoformat()},
        "totals": {**_public(totals), "active_accounts": active},
        "daily": [{"day": day, **_public(bucket)} for day, bucket in sorted(daily.items())],
        "by_kind": [{"kind": kind, "label": KIND_LABELS.get(kind, kind), **_public(bucket, flows=False)}
                    for kind, bucket in kinds.items()
                    if kind in MAIN_KINDS or bucket["calls"]],
        "accounts": account_rows,
        "pricing": pricing(),
    }


# ---------- 配额与告警的读写 ----------

def set_quota(user_id: str, fields: dict, *, store: TenantStore | None = None) -> tuple | None:
    """写某账号的配额：fields 里出现的键覆盖（None = 用默认，-1 = 不限），没出现的保留；两项都默认就删掉这行。"""
    store = store or TenantStore()
    with store._connect() as c:
        c.execute("BEGIN IMMEDIATE")
        try:
            current = list(_stored_quota(c, user_id) or (None, None))
            for index, field in enumerate(QUOTA_FIELDS):
                if field in fields:
                    current[index] = fields[field]
            if current == [None, None]:
                c.execute("DELETE FROM tenant_quotas WHERE owner_id=?", (user_id,))
                stored = None
            else:
                c.execute("INSERT INTO tenant_quotas(owner_id, daily_model_calls, daily_flow_runs, updated_at) "
                          "VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET daily_model_calls=excluded.daily_model_calls, "
                          "daily_flow_runs=excluded.daily_flow_runs, updated_at=excluded.updated_at",
                          (user_id, current[0], current[1], _iso(_utc())))
                stored = tuple(current)
            c.commit()
        except Exception:
            c.rollback()
            raise
    with _quota_lock:   # 调过配额：今天的「用尽」告警可以再发
        for key in [key for key in _quota_alerted if key[1] == user_id]:
            _quota_alerted.discard(key)
    return stored


def list_alerts(limit: int = 50, *, store: TenantStore | None = None) -> dict:
    store = store or TenantStore()
    limit = max(1, min(int(limit), 200))
    with store._connect() as c:
        rows = c.execute(
            "SELECT a.id, a.kind, a.owner_id, a.title, a.detail, a.created_at, a.read_at, u.username "
            "FROM admin_alerts a LEFT JOIN users u ON u.id = a.owner_id "
            "ORDER BY a.created_at DESC, a.id LIMIT ?", (limit,)).fetchall()
        unread = int(c.execute("SELECT COUNT(*) FROM admin_alerts WHERE read_at IS NULL").fetchone()[0])
    return {
        "alerts": [{
            "id": row["id"], "kind": row["kind"], "title": row["title"], "detail": row["detail"],
            "owner": ({"id": row["owner_id"], "username": row["username"] or ""} if row["owner_id"] else None),
            "created_at": row["created_at"], "read": row["read_at"] is not None,
        } for row in rows],
        "unread": unread,
    }


def mark_alerts_read(ids: list[str] | None = None, *, all_: bool = False, store: TenantStore | None = None) -> int:
    store = store or TenantStore()
    now = _iso(_utc())
    with store._connect() as c:
        if all_:
            c.execute("UPDATE admin_alerts SET read_at=? WHERE read_at IS NULL", (now,))
        elif ids:
            marks = ",".join("?" * len(ids))
            c.execute(f"UPDATE admin_alerts SET read_at=? WHERE read_at IS NULL AND id IN ({marks})", (now, *ids))
        return int(c.execute("SELECT COUNT(*) FROM admin_alerts WHERE read_at IS NULL").fetchone()[0])


# ---------- 接口 ----------

def _quota_value_error(field: str, value) -> str | None:
    label = "每天的模型调用次数" if field == "daily_model_calls" else "每天的流程运行次数"
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not (UNLIMITED <= value <= MAX_QUOTA):
        return f"{label}要填 0 到 {MAX_QUOTA} 之间的整数（不限填 -1，用默认填空）"
    return None


def register(app, *, request_principal, panel_write, deny, tenant_store, accounts) -> None:
    def no_store(payload: dict, status: int = 200) -> JSONResponse:
        return JSONResponse(payload, status_code=status, headers={"Cache-Control": "no-store"})

    def owner_read(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return None, deny()
        if not principal.is_owner:
            return None, no_store({"error": "权限不足"}, 403)
        return principal, None

    def owner_write(request: Request):
        principal, error = panel_write(request)
        if error is not None:
            return None, error
        if not principal.is_owner:
            return None, no_store({"error": "权限不足"}, 403)
        return principal, None

    def failed() -> JSONResponse:
        return no_store({"error": "用量数据暂时读不出来，请稍后再试"}, 503)

    def users() -> list[dict]:
        return [dict(row) for row in accounts.list_users()]

    @app.get("/api/admin/usage")
    def admin_usage(request: Request, days: str = "7"):
        _principal, error = owner_read(request)
        if error is not None:
            return error
        try:
            span = int(days)
        except (TypeError, ValueError):
            span = 7
        try:
            return no_store(usage_report(span, users()))
        except Exception as exc:
            log.warning("admin usage report failed: %s", type(exc).__name__)
            return failed()

    @app.put("/api/admin/quotas/{user_id}")
    def admin_quota_put(user_id: str, request: Request, body: Any = Body(None)):
        _principal, error = owner_write(request)
        if error is not None:
            return error
        if not isinstance(body, dict):
            return no_store({"error": "请求格式不对"}, 400)
        fields = {field: body[field] for field in QUOTA_FIELDS if field in body}
        if not fields:
            return no_store({"error": "没有要改的配额"}, 400)
        for field, value in fields.items():
            if problem := _quota_value_error(field, value):
                return no_store({"error": problem}, 400)
        target = next((row for row in users() if row.get("id") == user_id), None)
        if target is None:
            return no_store({"error": "没有这个账号"}, 404)
        if target.get("role") == "Owner":
            return no_store({"error": "管理员账号不限用量，不用设配额"}, 400)
        try:
            stored = set_quota(user_id, fields)
        except Exception as exc:
            log.warning("quota save failed: %s", type(exc).__name__)
            return no_store({"error": "配额没存上，请稍后再试"}, 503)
        return no_store({"user_id": user_id, "quota": quota_view(target.get("role"), stored)})

    @app.get("/api/admin/alerts")
    def admin_alerts(request: Request, limit: str = "50"):
        _principal, error = owner_read(request)
        if error is not None:
            return error
        try:
            count = int(limit)
        except (TypeError, ValueError):
            count = 50
        try:
            return no_store(list_alerts(count))
        except Exception as exc:
            log.warning("admin alerts read failed: %s", type(exc).__name__)
            return failed()

    @app.post("/api/admin/alerts/read")
    def admin_alerts_read(request: Request, body: Any = Body(None)):
        _principal, error = owner_write(request)
        if error is not None:
            return error
        body = body if isinstance(body, dict) else {}
        ids = body.get("ids")
        mark_all = body.get("all") is True
        if not mark_all:
            if not isinstance(ids, list) or not ids or len(ids) > 500 \
                    or not all(isinstance(item, str) and 0 < len(item) <= 64 for item in ids):
                return no_store({"error": "要标记哪几条？传 ids，或 all: true 全部已读"}, 400)
        try:
            unread = mark_alerts_read(None if mark_all else ids, all_=mark_all)
        except Exception as exc:
            log.warning("admin alerts mark failed: %s", type(exc).__name__)
            return failed()
        return no_store({"ok": True, "unread": unread})

    @app.get("/api/usage/me")
    def usage_me(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            status = usage_status(principal.user_id)
        except Exception as exc:
            log.warning("usage me failed: %s", type(exc).__name__)
            return failed()
        status.pop("role", None)
        return no_store(status)
