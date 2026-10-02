"""今日简报卡：每账号每天最多 1 次模型调用、并发只烧一次、失败退回规则摘要且当天不重试。"""
import datetime
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis import briefing
from jarvis.accounts import AccountStore
from jarvis.briefing import BriefService, fallback_brief, gather_facts, parse_brief
from jarvis.tenancy import TenantStore, tenant_scope

MORNING = datetime.datetime(2026, 10, 2, 8, 30)     # 周五


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    user_id = accounts.list_users()[0]["id"]
    with tenant_scope(user_id):
        store = TenantStore()
        store.add_schedule("项目周会", "2026-10-02 15:00")
        store.add_schedule("晨会", "2026-10-02 08:00")
        store.add_schedule("体检", "2026-10-03 09:30")
        store.add_todo("整理季度汇报材料")
        store.add_todo("给云服务器续费")
        yield user_id


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


def _service(compose, clock=None, weather="26°C 多云，18–27°C"):
    calls = []

    def counted(user_id, prompt):
        calls.append(prompt)
        return compose(user_id, prompt)

    svc = BriefService(compose=counted, weather=lambda loc: weather, now_fn=clock or Clock(MORNING), timeout=5)
    return svc, calls


MODEL_TEXT = "今天 2 个日程，15:00 项目周会前还有 2 个待办没完成；外面 26°C 多云\n先把季度汇报材料收个尾\n明早 09:30 体检，今晚早点睡"


# ---------- 纯函数 ----------

def test_parse_brief_strips_markdown_links_emoji_and_caps_lines():
    raw = ("```\n# 今日简报\n**今天 2 个日程**，☀️ 26°C https://x.cn/a\n"
           "- 15:00 项目周会\n1. 先清「整理季度汇报材料」\n> 明早体检\n多出来的第五行\n```")
    out = parse_brief(raw)
    assert out["headline"] == "今天 2 个日程，26°C"
    assert out["details"] == ["15:00 项目周会", "先清「整理季度汇报材料」", "明早体检"]   # 最多 3 行细节


def test_parse_brief_empty_and_overlong():
    assert parse_brief("") is None and parse_brief("```\n\n```") is None
    long = parse_brief("字" * 200 + "\n" + "细" * 100)
    assert len(long["headline"]) == briefing.HEADLINE_MAX and long["headline"].endswith("…")
    assert len(long["details"][0]) == briefing.DETAIL_MAX


def test_fallback_brief_rules(owner_id):
    facts = gather_facts(TenantStore(), MORNING, "26°C 多云，18–27°C")
    out = fallback_brief(facts)
    assert out["headline"] == "今天 2 个日程，下一项 15:00 项目周会；2 个待办未完成；26°C 多云，18–27°C"
    assert "待办 「整理季度汇报材料」「给云服务器续费」" in out["details"]
    assert "明天 09:30 体检" in out["details"]
    evening = fallback_brief(gather_facts(TenantStore(), MORNING.replace(hour=21), ""))
    assert evening["headline"] == "今天的 2 个日程都已结束；2 个待办未完成"
    empty = fallback_brief({"today": [], "tomorrow": [], "todos": [], "weather": ""})
    assert empty == {"headline": "今天没有日程；待办已清空", "details": []}


def test_prompt_contains_only_local_facts(owner_id):
    prompt = briefing.build_prompt(gather_facts(TenantStore(), MORNING, ""))
    assert "08:00 晨会（已过）；15:00 项目周会" in prompt
    assert "明天的日程：09:30 体检" in prompt
    assert "共 2 项" in prompt and "未知（不要提天气）" in prompt


# ---------- 每天最多一次 ----------

def test_same_day_three_posts_call_model_once(owner_id):
    svc, calls = _service(lambda u, p: MODEL_TEXT)
    first = svc.ensure(owner_id)
    assert first["status"] == "ready" and first["source"] == "model"
    assert first["headline"].startswith("今天 2 个日程") and len(first["details"]) == 2
    assert first["at"] == "08:30"
    svc.ensure(owner_id); svc.ensure(owner_id)
    assert len(calls) == 1
    assert svc.view(owner_id)["headline"] == first["headline"]


def test_concurrent_posts_call_model_once(owner_id):
    gate = threading.Event()

    def slow(u, p):
        gate.wait(2)
        return MODEL_TEXT

    svc, calls = _service(slow)

    def hit(_):
        with tenant_scope(owner_id):
            return svc.ensure(owner_id)

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(hit, i) for i in range(5)]
        time.sleep(0.2)
        gate.set()
        results = [f.result() for f in futures]
    assert len(calls) == 1
    assert {r["source"] for r in results} == {"model"}


def test_next_day_generates_again(owner_id):
    clock = Clock(MORNING)
    svc, calls = _service(lambda u, p: MODEL_TEXT, clock)
    svc.ensure(owner_id)
    clock.now = MORNING + datetime.timedelta(days=1)
    assert svc.view(owner_id)["status"] == "none"
    svc.ensure(owner_id)
    assert len(calls) == 2


def test_before_five_am_never_generates(owner_id):
    svc, calls = _service(lambda u, p: MODEL_TEXT, Clock(MORNING.replace(hour=4, minute=50)))
    assert svc.view(owner_id)["status"] == "early"
    assert svc.ensure(owner_id)["status"] == "early"
    assert calls == []


def test_model_failure_falls_back_and_never_retries_today(owner_id):
    def boom(u, p):
        raise RuntimeError("provider down")

    svc, calls = _service(boom)
    out = svc.ensure(owner_id)
    assert out["status"] == "ready" and out["source"] == "fallback"
    assert out["headline"].startswith("今天 2 个日程，下一项 15:00 项目周会")
    assert svc.ensure(owner_id)["source"] == "fallback"
    assert len(calls) == 1                                           # 当天不重试


def test_unusable_model_output_falls_back(owner_id):
    svc, calls = _service(lambda u, p: "```\n\n```")
    assert svc.ensure(owner_id)["source"] == "fallback" and len(calls) == 1


def test_model_timeout_falls_back(owner_id):
    svc, calls = _service(lambda u, p: (time.sleep(1.5), MODEL_TEXT)[1])
    svc.timeout = 0.2
    assert svc.ensure(owner_id)["source"] == "fallback"


def test_fallback_is_recomputed_live_but_model_text_is_cached(owner_id):
    svc, _calls = _service(lambda u, p: (_ for _ in ()).throw(RuntimeError("x")))
    svc.ensure(owner_id)
    TenantStore().add_todo("回复设计稿意见")
    assert "3 个待办未完成" in svc.view(owner_id)["headline"]       # 规则摘要不过时
    assert "26°C" in svc.view(owner_id)["headline"]                   # 天气沿用当天那一次


def test_stale_pending_after_crash_is_not_retried(owner_id):
    svc, calls = _service(lambda u, p: MODEL_TEXT)
    TenantStore().set_pref(briefing.PREF_KEY, json.dumps(
        {"date": "2026-10-02", "source": "pending", "started": "2026-10-02T08:20:00"}))
    assert svc.view(owner_id)["source"] == "fallback"                # 10 分钟前开始、早已断掉
    assert svc.ensure(owner_id)["source"] == "fallback"
    assert calls == []
    TenantStore().set_pref(briefing.PREF_KEY, json.dumps(
        {"date": "2026-10-02", "source": "pending", "started": "2026-10-02T08:29:30"}))
    assert svc.view(owner_id) == {"status": "pending", "date": "2026-10-02"}   # 正在生成


def test_brief_uses_prefs_not_new_tables(owner_id):
    """不开新 schema 版本：结果只是一条 tenant_prefs，旧库（v3）直接可用。"""
    svc, _calls = _service(lambda u, p: MODEL_TEXT)
    svc.ensure(owner_id)
    store = TenantStore()
    with store._connect() as c:
        versions = [r[0] for r in c.execute("SELECT version FROM tenant_schema_migrations ORDER BY version")]
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert versions == [1, 2, 3]
    assert not any("brief" in t for t in tables)
    assert json.loads(store.get_pref(briefing.PREF_KEY))["source"] == "model"


# ---------- HTTP ----------

def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


@pytest.fixture()
def patched_service(monkeypatch):
    calls = []

    def compose(user_id, prompt):
        calls.append(user_id)
        return MODEL_TEXT

    svc = briefing.service()
    monkeypatch.setattr(svc, "compose", compose)
    monkeypatch.setattr(svc, "weather", lambda loc: "")
    monkeypatch.setattr(svc, "now", lambda: datetime.datetime.now().replace(hour=9))
    return calls


def test_http_brief_flow_auth_and_isolation(owner_id, patched_service):
    anon = TestClient(server_mod.app)
    assert anon.get("/api/brief").status_code == 401
    assert anon.post("/api/brief").status_code == 401
    owner = _client()
    no_csrf = TestClient(server_mod.app)
    no_csrf.cookies = owner.cookies
    assert no_csrf.post("/api/brief").status_code == 403
    assert owner.get("/api/brief").json()["status"] == "none"
    for _ in range(3):
        body = owner.post("/api/brief").json()
    assert body["source"] == "model" and patched_service == [owner_id]
    assert owner.get("/api/brief").json()["headline"] == body["headline"]
    AccountStore().create_user("member", "member", "Member")
    member = _client("member", "member")
    assert member.get("/api/brief").json()["status"] == "none"      # A 的简报 B 看不到
    member.post("/api/brief")
    assert len(patched_service) == 2 and patched_service[1] != owner_id   # 每个账号各自一次


def test_brief_never_shows_up_as_a_thread(owner_id, patched_service):
    owner = _client()
    owner.post("/api/brief")
    ids = {t["id"] for t in owner.get("/api/threads").json()}
    assert not ids & {"brief", "radio", "heartbeat", "distill", "meeting"}
