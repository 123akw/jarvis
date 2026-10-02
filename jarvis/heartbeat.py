"""Heartbeat 主动唤醒：管家定期看一眼关注清单，该开口时才开口。

data/HEARTBEAT.md 是一份纯文本「关注清单」——主人手写（或让贾维斯代记）想被盯着
的事。后台线程每 JARVIS_HEARTBEAT_INTERVAL 秒（默认 30 分钟）醒一次：文件存在且
非空才把内容连同当前时间交给模型判断「现在该不该主动说点什么」；该说则经微信主动
推送（复用「提醒发给我」绑定通道），并投递一份进桌面/网页 pending 领取箱。模型判
轮空（只答 PASS）就保持沉默。JARVIS_HEARTBEAT_ENABLED=0 时线程根本不启动。

两道克制闸门（第十一轮）：
- 静默时段（默认 23:00–08:00，JARVIS_HEARTBEAT_QUIET_HOURS 可改/关）：整轮跳过，连模型都不调；
  日程到点提醒走 reminders.py，不受影响。
- 24 小时去重：同一内容（或只差标点、语气词的高度相似内容）推过一次就不再推；推送记录落盘
  （data/heartbeat-sent.json），服务重启后仍然有效。数字不同（时间、金额、数量）一律视为不同提醒。

服务端注入 deliver 时（jarvis/delivery.py 的 Notifier），送达改按账号的渠道设置走，并遵守账号
自己的免打扰：期间产生的消息先攒着，结束后合并成一条（不注入时保持微信 + 领取箱的老路径）。
"""
import datetime
import difflib
import json
import logging
import math
import os
import re
import threading
import time

from jarvis import config
from jarvis.periodic import PeriodicWorker

log = logging.getLogger("jarvis")

HEARTBEAT_FILE = "HEARTBEAT.md"
DEFAULT_INTERVAL = 30 * 60.0   # 30 分钟一轮；打扰过频改这里，不必关开关
MIN_INTERVAL = 60.0           # 配置护栏：设成 0 曾让模型调用陷入死循环（0.5 秒 74 万次）
MAX_INTERVAL = 86400.0        # Event.wait 不接受 inf，且一天一轮已是下限频率
MAX_PENDING_PER_USER = 20     # 领取箱上限：长期无人领取时只留最新的，旧的先进先出
PASS_TOKEN = "PASS"
DEFAULT_QUIET_HOURS = (datetime.time(23, 0), datetime.time(8, 0))
DEDUP_WINDOW_SECONDS = 24 * 3600.0
DEDUP_SIMILARITY = 0.8         # 归一化后 SequenceMatcher 相似度达到它即视为同一条提醒
SENT_LOG_FILE = "heartbeat-sent.json"
MAX_SENT_RECORDS = 200
_QUIET_OFF = frozenset(("off", "none", "0", "false", "no"))
_DIGITS = re.compile(r"\d+")

HEARTBEAT_PROMPT = (
    "你在做后台巡检，主人此刻并没有发问。下面是主人手写的关注清单与当前时间。"
    "只有当清单里有「此刻确实该提醒或跟进」的事项时，才输出一条要主动发给主人的话："
    "口语化、一到三句、不用 Markdown 符号；除此之外的一切情况只输出 PASS。\n"
    "当前时间：{now}\n关注清单：\n{content}"
)


def heartbeat_path():
    return config.data_dir() / HEARTBEAT_FILE


def parse_quiet_hours(raw: str | None):
    """'23:00-08:00' → (time(23,0), time(8,0))；off/none/0 → None（不设静默）；未设置或空 → 默认。

    起止相同视为不设静默；起点晚于终点表示跨午夜。格式不对抛 ValueError。"""
    value = (raw or "").strip().lower()
    if not value:
        return DEFAULT_QUIET_HOURS
    if value in _QUIET_OFF:
        return None
    parts = re.split(r"\s*[-~–—]\s*", value)
    if len(parts) != 2:
        raise ValueError(raw)
    start, end = (_parse_clock(part) for part in parts)
    return None if start == end else (start, end)


def _parse_clock(text: str) -> datetime.time:
    """'23:00' / '8:30' / '7' → time；'24:00' 按 0 点算。越界抛 ValueError。"""
    match = re.fullmatch(r"(\d{1,2})(?:[:：](\d{2}))?", text)
    if not match:
        raise ValueError(text)
    hour, minute = int(match[1]), int(match[2] or 0)
    if (hour, minute) == (24, 0):
        return datetime.time(0, 0)
    return datetime.time(hour, minute)


def in_quiet_hours(now: datetime.datetime, quiet) -> bool:
    if not quiet:
        return False
    start, end = quiet
    moment = now.time()
    if start < end:
        return start <= moment < end
    return moment >= start or moment < end   # 跨午夜，如 23:00–08:00


def _normalized(text: str) -> str:
    """去掉标点、空白、表情和大小写差异，只留文字与数字。"""
    return "".join(ch for ch in text.casefold() if ch.isalnum())


def similar_messages(a: str, b: str) -> bool:
    """两条心跳是否算「同一条提醒」：归一化后相同，或数字一致且高度相似。"""
    left, right = _normalized(a), _normalized(b)
    if not left or not right:
        return a.strip() == b.strip()
    if left == right:
        return True
    if _DIGITS.findall(a) != _DIGITS.findall(b):
        return False   # 「3 点开会」和「4 点开会」是两件事
    return difflib.SequenceMatcher(None, left, right, autojunk=False).ratio() >= DEDUP_SIMILARITY


def sent_log_path():
    return config.data_dir() / SENT_LOG_FILE


class SentLog:
    """最近 24 小时已推送的心跳记录：按用户去重，落盘以便重启后仍然有效。"""

    def __init__(self, path_fn=sent_log_path, window: float = DEDUP_WINDOW_SECONDS):
        self._path_fn = path_fn
        self._window = window
        self._lock = threading.Lock()

    def _load(self, cutoff: float) -> list[dict]:
        path = self._path_fn()
        if not path.exists():
            return []
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("heartbeat sent-log unreadable, starting fresh: %s", type(exc).__name__)
            return []
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict) and isinstance(row.get("ts"), (int, float))
                and row["ts"] >= cutoff and isinstance(row.get("text"), str)]

    def _save(self, rows: list[dict]) -> None:
        path = self._path_fn()
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(rows[-MAX_SENT_RECORDS:], ensure_ascii=False), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, path)

    def find_similar(self, user_id: str, text: str, now: datetime.datetime) -> dict | None:
        with self._lock:
            rows = self._load(now.timestamp() - self._window)
        for row in reversed(rows):
            if row.get("user") == user_id and similar_messages(row["text"], text):
                return row
        return None

    def record(self, user_id: str, text: str, now: datetime.datetime) -> None:
        stamp = now.timestamp()
        with self._lock:
            rows = self._load(stamp - self._window)
            rows.append({"user": user_id, "ts": stamp, "text": text})
            self._save(rows)


class PendingOutbox:
    """桌面/网页 pending 通道的心跳投递箱：按用户暂存、领取即清、线程安全。

    桌面与网页轮询同一端点，谁先来谁领走——每条心跳只送达一处，与日程提醒
    「同一通道只提醒一次」的克制口径一致。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._items: dict[str, list[dict]] = {}
        self._seq = 0   # 全局递增：裁剪旧条目后按长度编号会撞 id

    def put(self, user_id: str, title: str, when: str) -> None:
        with self._lock:
            queue = self._items.setdefault(user_id, [])
            self._seq += 1
            queue.append({"id": f"heartbeat-{when}-{self._seq}", "when": when, "title": title})
            del queue[:-MAX_PENDING_PER_USER]

    def drain(self, user_id: str) -> list[dict]:
        with self._lock:
            return self._items.pop(user_id, [])


class HeartbeatScanner(PeriodicWorker):
    """读清单 → 模型裁量 → 双通道推送；依赖全部可注入，pytest 可确定性直测。"""

    thread_name = "jarvis-heartbeat"

    def __init__(self, *, owner_getter=None, compose=None, push_wechat=None,
                 outbox=None, path_fn=heartbeat_path, now_fn=None,
                 interval: float = DEFAULT_INTERVAL, quiet_hours=DEFAULT_QUIET_HOURS,
                 sent_log: SentLog | None = None, deliver=None):
        self._owner_getter = owner_getter
        self._deliver = deliver   # (user_id, message, now) -> bool：送出或已攒下
        self._compose = compose
        self._push_wechat = push_wechat
        self._outbox = outbox
        self._path_fn = path_fn
        self._now = now_fn or datetime.datetime.now
        self._quiet_hours = quiet_hours
        self._sent_log = sent_log or SentLog()
        super().__init__(interval)

    def scan_once(self) -> bool:
        """跑一轮，返回是否真的推送了消息；任何异常只告警不外抛、不崩服务。"""
        if not self._owner_getter or not self._compose:
            return False
        owner = self._resolve_owner(self._owner_getter)
        if owner is None:
            return False
        now = self._now()
        if in_quiet_hours(now, self._quiet_hours):
            return False   # 夜里不打扰，也不烧模型；静默结束后的下一轮会重新裁量
        try:
            path = self._path_fn()
            if not path.exists():
                return False   # 没建清单 = 没开这个功能，不烧模型
            content = path.read_text(encoding="utf-8").strip()
        except Exception as exc:
            log.warning("heartbeat read failed: %s", type(exc).__name__)
            return False
        if not content:
            return False
        try:
            message = (self._compose(owner, content, now) or "").strip()
        except Exception as exc:
            log.warning("heartbeat compose failed: %s", type(exc).__name__)
            return False
        if not message or message.upper() == PASS_TOKEN:
            return False
        try:
            duplicate = self._sent_log.find_similar(owner.user_id, message, now)
        except Exception as exc:   # 去重记录坏了宁可多提醒一次，也不能让心跳停摆
            log.warning("heartbeat dedup check failed: %s", type(exc).__name__)
            duplicate = None
        if duplicate is not None:
            log.info("heartbeat suppressed (same as %s): %s",
                     time.strftime("%m-%d %H:%M", time.localtime(duplicate["ts"])), message[:60])
            return False
        delivered = False
        if self._deliver is not None:
            try:
                delivered = bool(self._deliver(owner.user_id, message, now))
            except Exception as exc:
                log.warning("heartbeat deliver failed: %s", type(exc).__name__)
        if self._deliver is None and self._push_wechat is not None:
            try:
                delivered = bool(self._push_wechat(f"🔔 {message}"))
            except Exception as exc:
                log.warning("heartbeat wechat push failed: %s", type(exc).__name__)
        if self._deliver is None and self._outbox is not None:
            try:
                self._outbox.put(owner.user_id, message, now.strftime("%Y-%m-%d %H:%M"))
                delivered = True
            except Exception as exc:
                log.warning("heartbeat outbox failed: %s", type(exc).__name__)
        if delivered:
            log.info("heartbeat pushed: %s", message[:60])
            try:
                self._sent_log.record(owner.user_id, message, now)
            except Exception as exc:
                log.warning("heartbeat sent-log write failed: %s", type(exc).__name__)
        return delivered



def maybe_create(**kwargs) -> HeartbeatScanner | None:
    """按环境开关建扫描器；JARVIS_HEARTBEAT_ENABLED=0 返回 None，线程根本不存在。"""
    if os.getenv("JARVIS_HEARTBEAT_ENABLED", "1") == "0":
        return None
    try:
        interval = float(os.getenv("JARVIS_HEARTBEAT_INTERVAL", "") or DEFAULT_INTERVAL)
    except ValueError:
        interval = DEFAULT_INTERVAL
    if math.isnan(interval):
        interval = DEFAULT_INTERVAL
    clamped = min(MAX_INTERVAL, max(MIN_INTERVAL, interval))
    if clamped != interval:
        log.warning("JARVIS_HEARTBEAT_INTERVAL=%s 超出 %d–%d 秒，已按 %d 秒执行",
                    os.getenv("JARVIS_HEARTBEAT_INTERVAL"), MIN_INTERVAL, MAX_INTERVAL, clamped)
    raw_quiet = os.getenv("JARVIS_HEARTBEAT_QUIET_HOURS")
    try:
        quiet = parse_quiet_hours(raw_quiet)
    except ValueError:
        log.warning("JARVIS_HEARTBEAT_QUIET_HOURS=%r 格式应为 HH:MM-HH:MM（或 off 关闭），已按默认 23:00-08:00 执行",
                    raw_quiet)
        quiet = DEFAULT_QUIET_HOURS
    return HeartbeatScanner(interval=clamped, quiet_hours=quiet, **kwargs)
