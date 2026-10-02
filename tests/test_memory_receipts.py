"""记忆回执：对话里的结构化回执（SSE）、夜间蒸馏的「昨晚整理了 N 条」、回执总开关。"""
import datetime
import json
from contextlib import contextmanager
from types import SimpleNamespace

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis import memory_receipts
from jarvis.accounts import AccountStore
from jarvis.distill import NightlyDistiller
from jarvis.tenancy import TenantStore, tenant_scope
from jarvis.tools.profile import profile_forget, profile_remember
from langchain_core.messages import AIMessageChunk, ToolMessage

NIGHT = datetime.datetime(2026, 10, 2, 3, 20)


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    user_id = accounts.list_users()[0]["id"]
    with tenant_scope(user_id):
        yield user_id


def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _call(tool, args, call_id="c1"):
    return tool.invoke({"name": tool.name, "args": args, "id": call_id, "type": "tool_call"})


# ---------- 工具回执 ----------

def test_remember_tool_carries_receipt_artifact_but_model_text_unchanged(owner_id):
    msg = _call(profile_remember, {"fact": "主人不喜欢跑步"})
    assert msg.content == "记住了（编号 1）：主人不喜欢跑步"            # 模型看到的仍是一句话
    assert memory_receipts.receipt_of(msg) == {"action": "remember", "id": 1, "content": "主人不喜欢跑步"}


def test_duplicate_remember_has_no_receipt(owner_id):
    _call(profile_remember, {"fact": "主人不喜欢跑步"})
    again = _call(profile_remember, {"fact": "主人不喜欢跑步"}, "c2")
    assert "已经记着了" in again.content
    assert memory_receipts.receipt_of(again) is None                 # 重复记忆不出回执


def test_forget_receipt_carries_original_text_for_undo(owner_id):
    _call(profile_remember, {"fact": "主人住在杭州"})
    msg = _call(profile_forget, {"profile_id": 1})
    assert msg.content == "已忘记编号 1 的画像。"
    assert memory_receipts.receipt_of(msg) == {"action": "forget", "id": 1, "content": "主人住在杭州"}
    missing = _call(profile_forget, {"profile_id": 9}, "c3")
    assert memory_receipts.receipt_of(missing) is None


@pytest.mark.parametrize("artifact", [
    None, "x", {"memory": "x"}, {"memory": {"action": "drop", "id": 1, "content": "a"}},
    {"memory": {"action": "remember", "id": True, "content": "a"}},
    {"memory": {"action": "remember", "id": 0, "content": "a"}},
    {"memory": {"action": "remember", "id": 1, "content": "  "}},
])
def test_receipt_of_rejects_malformed_artifacts(artifact):
    assert memory_receipts.receipt_of(SimpleNamespace(artifact=artifact)) is None
    assert memory_receipts.sse_fields(SimpleNamespace(artifact=artifact)) == {}


class _MemoryAgent:
    def stream(self, _payload, config=None, stream_mode=None):
        yield AIMessageChunk(content="", tool_call_chunks=[
            {"name": "profile_remember", "id": "call-m", "args": "", "index": 0, "type": "tool_call_chunk"},
            {"name": "now", "id": "call-n", "args": "", "index": 1, "type": "tool_call_chunk"},
        ]), {}
        yield ToolMessage(content="记住了（编号 7）：主人不喜欢跑步", name="profile_remember",
                          tool_call_id="call-m",
                          artifact={"memory": {"action": "remember", "id": 7, "content": "主人不喜欢跑步"}}), {}
        yield ToolMessage(content="2026-10-02 10:00", name="now", tool_call_id="call-n"), {}
        yield AIMessageChunk(content="好的，记住了。"), {}


def test_chat_sse_tool_result_carries_memory_receipt(owner_id, monkeypatch):
    @contextmanager
    def fake_bundle(_user_id):
        yield SimpleNamespace(agent=_MemoryAgent())

    monkeypatch.setattr(server_mod, "_bundle_for", fake_bundle)
    c = _client()
    r = c.post("/api/chat", json={"message": "记住我不喜欢跑步", "thread_id": "t-mem"})
    events = [json.loads(x[6:]) for x in r.text.split("\n\n") if x.startswith("data: ")]
    results = [e for e in events if e["type"] == "tool_result"]
    assert results[0]["memory"] == {"action": "remember", "id": 7, "content": "主人不喜欢跑步"}
    assert results[0]["detail"].startswith("记住了")                  # 原有 chip 字段不变
    assert "memory" not in results[1]                                 # 其他工具不带回执


# ---------- 夜间蒸馏批次 ----------

def _distiller(owner_id, facts, now=NIGHT):
    def remember(o, fact):
        return not TenantStore().add_profile(fact, owner_id=o.user_id)["existed"]
    return NightlyDistiller(
        owner_getter=lambda: SimpleNamespace(user_id=owner_id),
        collect=lambda o: "主人：……",
        compose=lambda o, transcript: "\n".join(facts),
        remember=remember,
        now_fn=lambda: now,
    )


def test_distill_records_fresh_batch_and_skips_existing(owner_id):
    TenantStore().add_profile("主人喝咖啡只喝美式")                       # 早就记着的
    assert _distiller(owner_id, ["主人喝咖啡只喝美式", "主人在深圳工作", "主人周五不排会"]).scan_once() == 2
    notice = memory_receipts.fresh_notice(TenantStore(), "2026-10-02")
    assert notice["count"] == 2 and notice["at"] == "03:20"
    contents = {x["id"]: x["content"] for x in TenantStore().list_profile()}
    assert sorted(contents[i] for i in notice["ids"]) == ["主人周五不排会", "主人在深圳工作"]


def test_fresh_notice_is_only_for_today_and_only_living_items(owner_id):
    _distiller(owner_id, ["主人在深圳工作", "主人周五不排会"]).scan_once()
    store = TenantStore()
    assert memory_receipts.fresh_notice(store, "2026-10-03")["count"] == 0   # 隔天不再说「昨晚」
    first = memory_receipts.fresh_notice(store, "2026-10-02")["ids"][0]
    store.delete_profile(first)
    assert memory_receipts.fresh_notice(store, "2026-10-02")["count"] == 1   # 删掉的不算


def test_new_batch_overwrites_old_and_empty_night_keeps_nothing_stale(owner_id):
    _distiller(owner_id, ["主人在深圳工作"]).scan_once()
    _distiller(owner_id, ["主人养了一只猫", "主人在学日语"], now=NIGHT + datetime.timedelta(days=1)).scan_once()
    store = TenantStore()
    assert memory_receipts.fresh_notice(store, "2026-10-03")["count"] == 2
    _distiller(owner_id, ["PASS"], now=NIGHT + datetime.timedelta(days=2)).scan_once()
    assert memory_receipts.fresh_notice(store, "2026-10-04")["count"] == 0


def test_injected_remember_without_store_writes_still_counts(owner_id):
    d = NightlyDistiller(owner_getter=lambda: SimpleNamespace(user_id=owner_id),
                         collect=lambda o: "x", compose=lambda o, t: "主人在深圳工作",
                         remember=lambda o, f: True, now_fn=lambda: NIGHT)
    assert d.scan_once() == 1                                          # 旧注入（只回 True）照常计数
    assert memory_receipts.fresh_notice(TenantStore(), "2026-10-02")["count"] == 0


# ---------- HTTP 接口 ----------

def test_memory_endpoints_auth_and_csrf(owner_id):
    anon = TestClient(server_mod.app)
    assert anon.get("/api/memory").status_code == 401
    assert anon.put("/api/memory/prefs", json={"receipts": False}).status_code == 401
    c = _client()
    no_csrf = TestClient(server_mod.app)
    no_csrf.cookies = c.cookies
    assert no_csrf.post("/api/memory/fresh/dismiss").status_code == 403


def test_receipts_switch_roundtrip_defaults_on(owner_id):
    c = _client()
    assert c.get("/api/memory").json()["receipts"] is True
    assert c.put("/api/memory/prefs", json={"receipts": False}).json() == {"ok": True, "receipts": False}
    assert c.get("/api/memory").json()["receipts"] is False
    c.put("/api/memory/prefs", json={"receipts": True})
    assert c.get("/api/memory").json()["receipts"] is True


def test_fresh_notice_endpoint_and_dismiss(owner_id, monkeypatch):
    today = datetime.datetime.now().strftime("%Y-%m-%d")
    store = TenantStore()
    ids = [store.add_profile(t)["id"] for t in ("主人在深圳工作", "主人周五不排会")]
    memory_receipts.record_fresh(store, date=today, at="03:05", ids=ids)
    c = _client()
    fresh = c.get("/api/memory").json()["fresh"]
    assert fresh["count"] == 2 and fresh["ids"] == ids and fresh["at"] == "03:05"
    assert c.post("/api/memory/fresh/dismiss").json() == {"ok": True}
    assert c.get("/api/memory").json()["fresh"]["count"] == 0
    assert len(c.get("/api/profile").json()["items"]) == 2              # 看过只是不再提示，画像还在


def test_fresh_notice_and_switch_are_tenant_isolated(owner_id):
    member = AccountStore().create_user("member", "member", "Member")
    today = datetime.datetime.now().strftime("%Y-%m-%d")
    store = TenantStore()
    memory_receipts.record_fresh(store, date=today, at="03:00", ids=[store.add_profile("主人在深圳工作")["id"]])
    owner = _client()
    owner.put("/api/memory/prefs", json={"receipts": False})
    other = _client("member", "member")
    state = other.get("/api/memory").json()
    assert state == {"receipts": True, "fresh": {"count": 0, "ids": [], "date": "", "at": ""}}
    other.post("/api/memory/fresh/dismiss")
    assert owner.get("/api/memory").json()["fresh"]["count"] == 1      # B 的「看过」不影响 A
    with tenant_scope(member["id"]):
        assert TenantStore().get_pref(memory_receipts.FRESH_KEY) is None
