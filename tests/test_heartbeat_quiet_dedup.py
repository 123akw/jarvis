"""Heartbeat 第十一轮：静默时段（默认 23:00–08:00）与 24 小时内相同/高度相似提醒去重。"""
import datetime
import json
import logging
from types import SimpleNamespace

import pytest

from jarvis import heartbeat
from jarvis.heartbeat import (DEFAULT_QUIET_HOURS, HeartbeatScanner, PendingOutbox, SentLog,
                              in_quiet_hours, maybe_create, parse_quiet_hours, similar_messages)

OWNER = SimpleNamespace(user_id="owner-1")
T = datetime.time


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


def _scanner(tmp_path, clock, *, replies=None, pushed=None, outbox=None, owner=OWNER, **kwargs):
    checklist = tmp_path / "HEARTBEAT.md"
    checklist.write_text("盯着下午三点的评审会", encoding="utf-8")
    replies = list(replies or ["该去开评审会了"])
    calls = []

    def compose(_owner, _content, now):
        calls.append(now)
        return replies[min(len(calls), len(replies)) - 1]

    scanner = HeartbeatScanner(
        owner_getter=lambda: owner, compose=compose,
        push_wechat=(lambda text: pushed.append(text) or True) if pushed is not None else None,
        outbox=outbox, path_fn=lambda: checklist, now_fn=clock,
        sent_log=SentLog(lambda: tmp_path / "heartbeat-sent.json"), **kwargs)
    scanner.calls = calls
    return scanner


# ---------- 静默时段 ----------

@pytest.mark.parametrize("raw,expected", [
    (None, DEFAULT_QUIET_HOURS), ("", DEFAULT_QUIET_HOURS), ("  ", DEFAULT_QUIET_HOURS),
    ("22:30-07:00", (T(22, 30), T(7, 0))), ("8-20", (T(8, 0), T(20, 0))),
    ("23:00 ~ 8:30", (T(23, 0), T(8, 30))), ("21：00-24:00", (T(21, 0), T(0, 0))),
    ("off", None), ("OFF", None), ("0", None), ("none", None), ("09:00-09:00", None),
])
def test_parse_quiet_hours(raw, expected):
    assert parse_quiet_hours(raw) == expected


@pytest.mark.parametrize("raw", ["abc", "23:00", "25:00-08:00", "23:61-08:00", "23-08-09"])
def test_parse_quiet_hours_rejects_garbage(raw):
    with pytest.raises(ValueError):
        parse_quiet_hours(raw)


@pytest.mark.parametrize("hhmm,quiet", [((23, 0), True), ((23, 30), True), ((0, 0), True), ((7, 59), True),
                                        ((8, 0), False), ((12, 0), False), ((22, 59), False)])
def test_default_window_wraps_midnight(hhmm, quiet):
    now = datetime.datetime(2026, 10, 2, *hhmm)
    assert in_quiet_hours(now, DEFAULT_QUIET_HOURS) is quiet


def test_same_day_window_and_disabled():
    lunch = (T(12, 0), T(13, 30))
    assert in_quiet_hours(datetime.datetime(2026, 10, 2, 12, 45), lunch)
    assert not in_quiet_hours(datetime.datetime(2026, 10, 2, 13, 30), lunch)
    assert not in_quiet_hours(datetime.datetime(2026, 10, 2, 3, 0), None)


def test_quiet_hours_skip_the_whole_round_without_calling_model(tmp_path):
    pushed, outbox = [], PendingOutbox()
    clock = Clock(datetime.datetime(2026, 10, 2, 23, 40))
    scanner = _scanner(tmp_path, clock, pushed=pushed, outbox=outbox)
    assert scanner.scan_once() is False
    clock.now = datetime.datetime(2026, 10, 3, 6, 0)
    assert scanner.scan_once() is False
    assert scanner.calls == [] and pushed == [] and outbox.drain(OWNER.user_id) == []
    clock.now = datetime.datetime(2026, 10, 3, 8, 0)    # 静默结束后的第一轮照常裁量
    assert scanner.scan_once() is True
    assert pushed == ["🔔 该去开评审会了"]


def test_quiet_hours_can_be_turned_off(tmp_path):
    pushed = []
    scanner = _scanner(tmp_path, Clock(datetime.datetime(2026, 10, 2, 2, 0)), pushed=pushed, quiet_hours=None)
    assert scanner.scan_once() is True and pushed


def test_env_configures_quiet_hours(monkeypatch, caplog):
    monkeypatch.delenv("JARVIS_HEARTBEAT_QUIET_HOURS", raising=False)
    assert maybe_create()._quiet_hours == DEFAULT_QUIET_HOURS
    monkeypatch.setenv("JARVIS_HEARTBEAT_QUIET_HOURS", "21:00-07:30")
    assert maybe_create()._quiet_hours == (T(21, 0), T(7, 30))
    monkeypatch.setenv("JARVIS_HEARTBEAT_QUIET_HOURS", "off")
    assert maybe_create()._quiet_hours is None
    monkeypatch.setenv("JARVIS_HEARTBEAT_QUIET_HOURS", "晚上十一点到早上八点")
    with caplog.at_level(logging.WARNING):
        assert maybe_create()._quiet_hours == DEFAULT_QUIET_HOURS
    assert any("JARVIS_HEARTBEAT_QUIET_HOURS" in r.getMessage() for r in caplog.records)


# ---------- 相似度判定 ----------

@pytest.mark.parametrize("a,b,same", [
    ("该去开评审会了", "该去开评审会了！", True),
    ("该去开评审会了", "🔔 该去开评审会了。", True),
    ("下午三点的评审会快开始了，记得带上电脑", "下午三点的评审会快开始了，记得带电脑", True),
    ("Remember the 3pm review", "remember the 3PM review!", True),
    ("下午3点开会", "下午4点开会", False),
    ("明天交房租 3200 元", "明天交房租 3500 元", False),
    ("该去开评审会了", "记得给妈妈打个电话", False),
    ("该喝水了", "该吃药了", False),
])
def test_similar_messages(a, b, same):
    assert similar_messages(a, b) is same


# ---------- 24 小时去重 ----------

def test_same_reminder_within_24h_is_pushed_once(tmp_path):
    pushed, outbox = [], PendingOutbox()
    clock = Clock(datetime.datetime(2026, 10, 2, 9, 0))
    scanner = _scanner(tmp_path, clock, replies=["该去开评审会了", "该去开评审会了！"], pushed=pushed, outbox=outbox)
    assert scanner.scan_once() is True
    clock.now += datetime.timedelta(minutes=30)
    assert scanner.scan_once() is False          # 只差一个标点：不再推
    assert len(scanner.calls) == 2               # 模型照常裁量（内容未知前无法去重）
    assert pushed == ["🔔 该去开评审会了"]
    assert [x["title"] for x in outbox.drain(OWNER.user_id)] == ["该去开评审会了"]


def test_reminder_can_repeat_after_24h(tmp_path):
    pushed = []
    clock = Clock(datetime.datetime(2026, 10, 2, 9, 0))
    scanner = _scanner(tmp_path, clock, pushed=pushed)
    assert scanner.scan_once() is True
    clock.now += datetime.timedelta(hours=23, minutes=59)
    assert scanner.scan_once() is False
    clock.now += datetime.timedelta(minutes=2)
    assert scanner.scan_once() is True
    assert len(pushed) == 2


def test_different_reminders_are_not_suppressed(tmp_path):
    pushed = []
    clock = Clock(datetime.datetime(2026, 10, 2, 9, 0))
    scanner = _scanner(tmp_path, clock, replies=["下午3点开评审会", "下午4点开复盘会", "记得给妈妈打电话"],
                       pushed=pushed)
    for _ in range(3):
        assert scanner.scan_once() is True
        clock.now += datetime.timedelta(minutes=30)
    assert len(pushed) == 3


def test_dedup_survives_restart(tmp_path):
    clock = Clock(datetime.datetime(2026, 10, 2, 9, 0))
    first, second = [], []
    assert _scanner(tmp_path, clock, pushed=first).scan_once() is True
    clock.now += datetime.timedelta(hours=2)
    assert _scanner(tmp_path, clock, pushed=second).scan_once() is False   # 新实例 = 服务重启
    assert second == []
    saved = json.loads((tmp_path / "heartbeat-sent.json").read_text(encoding="utf-8"))
    assert [row["text"] for row in saved] == ["该去开评审会了"]
    assert (tmp_path / "heartbeat-sent.json").stat().st_mode & 0o777 == 0o600


def test_dedup_is_per_user(tmp_path):
    clock = Clock(datetime.datetime(2026, 10, 2, 9, 0))
    assert _scanner(tmp_path, clock, pushed=[]).scan_once() is True
    other = SimpleNamespace(user_id="owner-2")
    assert _scanner(tmp_path, clock, pushed=[], owner=other).scan_once() is True


def test_undelivered_reminder_is_not_recorded(tmp_path):
    """两个通道都没送达的提醒不算推过，下一轮还能再推。"""
    clock = Clock(datetime.datetime(2026, 10, 2, 9, 0))
    failing = _scanner(tmp_path, clock)
    failing._push_wechat = lambda _text: False
    assert failing.scan_once() is False
    pushed = []
    assert _scanner(tmp_path, clock, pushed=pushed).scan_once() is True and pushed


def test_corrupt_sent_log_fails_open(tmp_path, caplog):
    (tmp_path / "heartbeat-sent.json").write_text("{not json", encoding="utf-8")
    pushed = []
    with caplog.at_level(logging.WARNING):
        assert _scanner(tmp_path, Clock(datetime.datetime(2026, 10, 2, 9, 0)), pushed=pushed).scan_once() is True
    assert pushed and json.loads((tmp_path / "heartbeat-sent.json").read_text(encoding="utf-8"))


def test_sent_log_is_bounded(tmp_path):
    log = SentLog(lambda: tmp_path / "sent.json")
    start = datetime.datetime(2026, 10, 2, 9, 0)
    for i in range(heartbeat.MAX_SENT_RECORDS + 30):
        log.record("u", f"提醒{i}", start + datetime.timedelta(seconds=i))
    rows = json.loads((tmp_path / "sent.json").read_text(encoding="utf-8"))
    assert len(rows) == heartbeat.MAX_SENT_RECORDS and rows[-1]["text"].endswith(str(heartbeat.MAX_SENT_RECORDS + 29))
