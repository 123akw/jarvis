"""夜间记忆蒸馏：到点触发、同日幂等、无对话不烧模型、失败不重试、解析护栏。"""
import datetime
from types import SimpleNamespace

import pytest
from jarvis.accounts import AccountStore
from jarvis.distill import MAX_FACTS, NightlyDistiller, parse_facts
from jarvis.tenancy import TenantStore, tenant_scope

IN_WINDOW = datetime.datetime(2026, 8, 19, 3, 30)     # 03:00 后 2 小时窗口内
BEFORE = datetime.datetime(2026, 8, 19, 2, 0)
PAST_WINDOW = datetime.datetime(2026, 8, 19, 5, 30)


@pytest.fixture()
def owner():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    user_id = accounts.list_users()[0]["id"]
    with tenant_scope(user_id):
        yield SimpleNamespace(user_id=user_id)


def _distiller(owner, *, now=IN_WINDOW, collect=None, compose=None, remember=None,
               calls=None):
    calls = calls if calls is not None else {}
    calls.setdefault("collect", []); calls.setdefault("compose", []); calls.setdefault("facts", [])
    def default_collect(o):
        calls["collect"].append(1)
        return "主人：我只喝美式\n贾维斯：记住了"
    def default_compose(o, transcript):
        calls["compose"].append(transcript)
        return "主人喝咖啡只喝美式\n主人在深圳工作"
    def default_remember(o, fact):
        calls["facts"].append(fact)
        return not TenantStore().add_profile(fact, owner_id=o.user_id)["existed"]
    return NightlyDistiller(
        owner_getter=lambda: owner,
        collect=collect or default_collect,
        compose=compose or default_compose,
        remember=remember or default_remember,
        now_fn=lambda: now,
    ), calls


def test_due_run_distills_into_profile(owner):
    d, calls = _distiller(owner)
    assert d.scan_once() == 2
    stored = [x["content"] for x in TenantStore().list_profile(owner_id=owner.user_id)]
    assert "主人喝咖啡只喝美式" in stored and "主人在深圳工作" in stored
    assert calls["compose"] and "只喝美式" in calls["compose"][0]


def test_same_day_rerun_is_idempotent(owner):
    d, calls = _distiller(owner)
    assert d.scan_once() == 2
    assert d.scan_once() == 0                      # 同日重跑：零新条目
    assert len(calls["collect"]) == 1              # 连对话都不再取
    assert len(TenantStore().list_profile(owner_id=owner.user_id)) == 2


def test_no_conversation_never_calls_model(owner):
    d, calls = _distiller(owner, collect=lambda o: "")
    assert d.scan_once() == 0
    assert calls["compose"] == []                  # 不烧模型
    assert d.scan_once() == 0                      # 且当日已记账


def test_outside_schedule_window(owner):
    d, calls = _distiller(owner, now=BEFORE)
    assert d.scan_once() == 0
    assert calls["collect"] == []                  # 没到点：什么都不做
    late, late_calls = _distiller(owner, now=PAST_WINDOW)
    assert late.scan_once() == 0
    assert late_calls["collect"] == []             # 过窗作罢
    with tenant_scope(owner.user_id):
        assert TenantStore().get_pref("distill_last_run") == "2026-08-19"


def test_compose_failure_not_retried_same_day(owner):
    boom = {"n": 0}
    def explode(o, t):
        boom["n"] += 1
        raise RuntimeError("model down")
    d, _ = _distiller(owner, compose=explode)
    assert d.scan_once() == 0
    assert d.scan_once() == 0
    assert boom["n"] == 1                          # 失败当日不重试


def test_parse_facts_guardrails():
    assert parse_facts("PASS") == []
    assert parse_facts("") == []
    raw = "\n".join(f"{i}. 事实{i}" for i in range(1, 8)) + "\n- 带杠的\n\n  \n"
    facts = parse_facts(raw)
    assert len(facts) == MAX_FACTS                 # 硬上限 5
    assert facts[0] == "事实1" and "带杠的" not in facts
