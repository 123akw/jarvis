"""第二十轮·用量接口与入口接线：/api/admin/usage|quotas|alerts、/api/usage/me 的权限与字段；
网页 / 桌面聊天、OpenAI 兼容接口、语音、飞书在配额用尽时回人话且不调模型；定时流程暂停与连续失败告警；
一句话生成记到 compose；后台任务记到 other。"""
import datetime as dt
import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessageChunk

import jarvis.server as server_mod
from jarvis import usage
from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantStore

MEMBER_PASSWORD = "Bob-pass-12345"


@pytest.fixture(autouse=True)
def clean_usage(monkeypatch):
    usage._ledger.clear()
    usage._quota_alerted.clear()
    monkeypatch.setattr(usage._ledger, "_ensure_thread", lambda: None)
    monkeypatch.setattr(usage, "_notify", None)
    monkeypatch.setattr(usage, "_spawn", lambda work: work())
    for name in ("JARVIS_PRICE_INPUT_PER_M", "JARVIS_PRICE_OUTPUT_PER_M", "JARVIS_PRICE_CACHED_INPUT_PER_M",
                 "JARVIS_DEFAULT_DAILY_MODEL_CALLS", "JARVIS_DEFAULT_DAILY_FLOW_RUNS"):
        monkeypatch.delenv(name, raising=False)
    yield
    usage._ledger.clear()


@pytest.fixture()
def accounts():
    store = AccountStore()
    store._ensure_bootstrap()
    return store


@pytest.fixture()
def owner_id(accounts):
    return accounts.unique_active_owner().user_id


@pytest.fixture()
def member_id(accounts):
    return accounts.create_user("bob", MEMBER_PASSWORD, "Member")["id"]


def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _events(response):
    return [json.loads(line[6:]) for line in response.text.split("\n\n") if line.startswith("data: ")]


def _alert_rows():
    with TenantStore()._connect() as c:
        return [dict(row) for row in c.execute("SELECT * FROM admin_alerts")]


# ---------- 管理接口：权限 ----------

def test_admin_endpoints_require_owner_and_csrf(owner_id, member_id):
    anon = TestClient(server_mod.app)
    assert anon.get("/api/admin/usage").status_code == 401
    assert anon.get("/api/admin/alerts").status_code == 401
    assert anon.get("/api/usage/me").status_code == 401
    assert anon.put(f"/api/admin/quotas/{member_id}", json={"daily_model_calls": 5}).status_code == 401
    member = _client("bob", MEMBER_PASSWORD)
    for path in ("/api/admin/usage", "/api/admin/alerts"):
        r = member.get(path)
        assert r.status_code == 403 and r.json() == {"error": "权限不足"}
    assert member.put(f"/api/admin/quotas/{member_id}", json={"daily_model_calls": 9999}).status_code == 403
    assert member.post("/api/admin/alerts/read", json={"all": True}).status_code == 403
    assert member.get("/api/usage/me").status_code == 200              # 自己的用量谁都能看
    owner = _client()
    no_csrf = TestClient(server_mod.app)
    no_csrf.cookies = owner.cookies
    assert no_csrf.put(f"/api/admin/quotas/{member_id}", json={"daily_model_calls": 5}).status_code == 403
    assert no_csrf.post("/api/admin/alerts/read", json={"all": True}).status_code == 403
    with TenantStore()._connect() as c:
        assert c.execute("SELECT COUNT(*) FROM tenant_quotas").fetchone()[0] == 0


# ---------- 管理接口：字段 ----------

def test_admin_usage_report_fields(owner_id, member_id, monkeypatch):
    from jarvis.platforms import PlatformStore, clean_platform
    PlatformStore().create(member_id, clean_platform({"name": "小鲍助手", "icon": "📚", "accent": "#0A84FF",
                                                       "plugins": []}))
    today = dt.date.today()
    monkeypatch.setattr(usage, "_clock", lambda: dt.datetime.combine(today - dt.timedelta(days=2), dt.time(10)))
    usage.record_model_call(member_id, 1000, 200)
    monkeypatch.setattr(usage, "_clock", dt.datetime.now)
    usage.record_model_call(member_id, 500, 100)
    with usage.kind_scope("flow"):
        usage.record_model_call(member_id, 100, 10)
    with usage.kind_scope("voice"):
        usage.record_model_call(owner_id, 10, 10)
    usage.record_flow_run(member_id, True)
    usage.record_flow_run(member_id, False)
    usage.set_quota(member_id, {"daily_model_calls": 50})
    body = _client().get("/api/admin/usage?days=7").json()               # 内存里的先落库再统计
    assert body["range"] == {"days": 7, "start": (today - dt.timedelta(days=6)).isoformat(), "end": today.isoformat()}
    totals = body["totals"]
    assert totals["calls"] == 4 and totals["input_tokens"] == 1610 and totals["output_tokens"] == 320
    assert totals["flow_runs"] == 2 and totals["flow_failures"] == 1 and totals["active_accounts"] == 2
    assert totals["cost_yuan"] == round((1610 * 2 + 320 * 3) / 1e6, 4)
    assert len(body["daily"]) == 7 and body["daily"][-1]["day"] == today.isoformat()
    assert body["daily"][-1]["calls"] == 3 and body["daily"][-1]["tokens"] == 600 + 110 + 20
    assert body["daily"][-3]["calls"] == 1 and body["daily"][0]["calls"] == 0
    kinds = {k["kind"]: k for k in body["by_kind"]}
    assert set(kinds) == {"chat", "flow", "compose", "voice"}
    assert kinds["chat"]["label"] == "对话" and kinds["chat"]["calls"] == 2 and kinds["compose"]["calls"] == 0
    assert kinds["voice"]["tokens"] == 20
    bob = next(a for a in body["accounts"] if a["user_id"] == member_id)
    assert bob["username"] == "bob" and bob["role"] == "Member" and bob["platform"] == {"name": "小鲍助手", "icon": "📚"}
    assert bob["calls"] == 3 and bob["tokens"] == 1910 and bob["flow_runs"] == 2 and bob["flow_failures"] == 1
    assert bob["today"] == {"calls": 2, "flow_runs": 2}
    assert bob["quota"]["daily_model_calls"] == 50 and bob["quota"]["daily_flow_runs"] == 100
    assert bob["quota"]["source"] == "custom"
    admin = next(a for a in body["accounts"] if a["user_id"] == owner_id)
    assert admin["platform"] is None and admin["quota"]["source"] == "unlimited" and admin["quota"]["daily_model_calls"] is None
    assert set(admin) >= {"user_id", "username", "role", "platform", "calls", "tokens", "cost_yuan", "flow_runs",
                          "flow_failures", "today", "quota", "last_active_at"}
    assert body["pricing"]["input_per_m"] == 2.0 and body["pricing"]["output_per_m"] == 3.0
    assert "估算" in body["pricing"]["note"]
    today_only = _client().get("/api/admin/usage?days=1").json()
    assert today_only["range"]["days"] == 1 and today_only["totals"]["calls"] == 3
    assert _client().get("/api/admin/usage?days=abc").json()["range"]["days"] == 7
    assert _client().get("/api/admin/usage?days=9999").json()["range"]["days"] == 90


def test_last_active_ignores_service_threads(owner_id, member_id):
    store = TenantStore()
    store.upsert_thread("heartbeat", "主动唤醒", owner_id=owner_id)
    store.upsert_thread("web", "你好", owner_id=member_id)
    accounts = {a["user_id"]: a for a in _client().get("/api/admin/usage").json()["accounts"]}
    assert accounts[owner_id]["last_active_at"] is None
    assert accounts[member_id]["last_active_at"]


def test_quota_put_validates_and_returns_view(owner_id, member_id):
    c = _client()
    r = c.put(f"/api/admin/quotas/{member_id}", json={"daily_model_calls": 20, "daily_flow_runs": None})
    assert r.status_code == 200
    quota = r.json()["quota"]
    assert quota["daily_model_calls"] == 20 and quota["daily_flow_runs"] == 100 and quota["source"] == "custom"
    assert quota["sources"] == {"daily_model_calls": "custom", "daily_flow_runs": "default"}
    r = c.put(f"/api/admin/quotas/{member_id}", json={"daily_flow_runs": -1})     # 只改一项：另一项保留
    assert r.json()["quota"]["daily_model_calls"] == 20 and r.json()["quota"]["daily_flow_runs"] is None
    r = c.put(f"/api/admin/quotas/{member_id}", json={"daily_model_calls": -1, "daily_flow_runs": -1})
    assert r.json()["quota"]["source"] == "unlimited"
    r = c.put(f"/api/admin/quotas/{member_id}", json={"daily_model_calls": None, "daily_flow_runs": None})
    assert r.json()["quota"]["source"] == "default" and r.json()["quota"]["daily_model_calls"] == 300
    for bad in ({"daily_model_calls": -2}, {"daily_model_calls": 1.5}, {"daily_model_calls": "10"},
                {"daily_model_calls": True}, {"daily_flow_runs": 10_000_001}, {}, {"other": 1}):
        r = c.put(f"/api/admin/quotas/{member_id}", json=bad)
        assert r.status_code == 400 and r.json()["error"], bad
    assert c.put(f"/api/admin/quotas/{member_id}", json=[1, 2]).status_code == 400
    assert c.put("/api/admin/quotas/nobody", json={"daily_model_calls": 1}).status_code == 404
    r = c.put(f"/api/admin/quotas/{owner_id}", json={"daily_model_calls": 1})
    assert r.status_code == 400 and "不限" in r.json()["error"]


def test_alerts_list_and_mark_read(owner_id, member_id):
    usage.alert("quota_model", "「bob」今天的模型调用次数用完了", "今天已用 3 次", owner_id=member_id)
    usage.alert("channel_wechat", "微信长连接断开超过 5 分钟", "登录态失效")
    c = _client()
    body = c.get("/api/admin/alerts?limit=50").json()
    assert body["unread"] == 2 and len(body["alerts"]) == 2
    quota = next(a for a in body["alerts"] if a["kind"] == "quota_model")
    assert quota == {"id": quota["id"], "kind": "quota_model", "title": "「bob」今天的模型调用次数用完了",
                     "detail": "今天已用 3 次", "owner": {"id": member_id, "username": "bob"},
                     "created_at": quota["created_at"], "read": False}
    assert next(a for a in body["alerts"] if a["kind"] == "channel_wechat")["owner"] is None
    r = c.post("/api/admin/alerts/read", json={"ids": [quota["id"]]})
    assert r.status_code == 200 and r.json() == {"ok": True, "unread": 1}
    assert c.post("/api/admin/alerts/read", json={}).status_code == 400
    assert c.post("/api/admin/alerts/read", json={"ids": [1]}).status_code == 400
    assert c.post("/api/admin/alerts/read", json={"all": True}).json() == {"ok": True, "unread": 0}
    assert all(a["read"] for a in c.get("/api/admin/alerts?limit=1").json()["alerts"])
    assert len(c.get("/api/admin/alerts?limit=1").json()["alerts"]) == 1


def test_usage_me(member_id, monkeypatch):
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "10")
    usage.record_model_call(member_id, 1, 1)
    usage.record_flow_run(member_id, True)
    body = _client("bob", MEMBER_PASSWORD).get("/api/usage/me").json()
    assert body["today"] == {"calls": 1, "flow_runs": 1}
    assert body["remaining"] == {"calls": 9, "flow_runs": 99}
    assert body["quota"]["daily_model_calls"] == 10 and body["quota"]["source"] == "default"
    assert "role" not in body


# ---------- 对话入口：超了回人话、不调模型 ----------

class _NeverAgent:
    def stream(self, *args, **kwargs):
        raise AssertionError("配额用尽时不该调模型")

    invoke = stream


def _bundle_spy(agent, seen):
    @contextmanager
    def bundle_for(user_id):
        seen.append(user_id)
        yield SimpleNamespace(agent=agent)
    return bundle_for


class _ReplyAgent:
    def stream(self, _payload, config=None, stream_mode=None):
        yield AIMessageChunk(content="收到"), {}


def test_web_chat_blocked_when_quota_used_up(member_id, monkeypatch):
    seen = []
    monkeypatch.setattr(server_mod, "_bundle_for", _bundle_spy(_NeverAgent(), seen))
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "1")
    usage.record_model_call(member_id, 1, 1)
    c = _client("bob", MEMBER_PASSWORD)
    r = c.post("/api/chat", json={"message": "你好", "thread_id": "t-quota"})
    assert r.status_code == 200
    assert _events(r) == [{"type": "error", "message": "今天的用量到上限了，明天再来，或请管理员调高", "code": "quota"}]
    assert seen == []
    assert TenantStore().get_thread("t-quota", owner_id=member_id) is None    # 没建线程
    assert [row["kind"] for row in _alert_rows()] == ["quota_model"]
    c.post("/api/chat", json={"message": "再来", "thread_id": "t-quota"})
    assert len(_alert_rows()) == 1                                     # 每账号每天一次


def test_web_chat_passes_under_quota(member_id, monkeypatch):
    seen = []
    monkeypatch.setattr(server_mod, "_bundle_for", _bundle_spy(_ReplyAgent(), seen))
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "5")
    r = _client("bob", MEMBER_PASSWORD).post("/api/chat", json={"message": "你好", "thread_id": "t-ok"})
    assert [e["type"] for e in _events(r)] == ["token", "done"] and seen == [member_id]


def test_owner_chat_never_blocked(owner_id, monkeypatch):
    seen = []
    monkeypatch.setattr(server_mod, "_bundle_for", _bundle_spy(_ReplyAgent(), seen))
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "0")
    r = _client().post("/api/chat", json={"message": "你好", "thread_id": "t-owner"})
    assert [e["type"] for e in _events(r)] == ["token", "done"] and seen == [owner_id]


def test_openai_compatible_endpoint_blocked(accounts, member_id, monkeypatch):
    seen = []
    monkeypatch.setattr(server_mod, "_bundle_for", _bundle_spy(_NeverAgent(), seen))
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "0")
    (_desktop, (_principal, token)) = accounts.issue_desktop_and_openai(member_id)
    r = TestClient(server_mod.app).post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                                        json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 429 and r.json()["error"]["message"] == usage.MODEL_QUOTA_MESSAGE and seen == []


def test_voice_bundle_checks_quota_and_records_voice(member_id, owner_id, monkeypatch):
    kinds = []

    @contextmanager
    def fake_bundle(user_id):
        kinds.append((user_id, usage.current_kind()))
        yield SimpleNamespace(agent=None)

    monkeypatch.setattr(server_mod, "_bundle_for", fake_bundle)
    with server_mod._voice_bundle_for(owner_id):
        pass
    assert kinds == [(owner_id, "voice")]
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "0")
    with pytest.raises(usage.QuotaExceeded) as caught:
        with server_mod._voice_bundle_for(member_id):
            pass
    assert kinds == [(owner_id, "voice")]                              # 没拿运行时
    assert server_mod._public_runtime_error(caught.value) == usage.MODEL_QUOTA_MESSAGE


def test_voice_call_turn_shows_quota_message(member_id, monkeypatch):
    """语音通话里说一句：配额用尽时下行 error 帧是那句人话，不调模型。"""
    import jarvis.voice.gateway as gateway
    from test_voice_gateway import _FakeTTS, _collect_turn

    monkeypatch.setattr(server_mod, "_get_agent", lambda: _NeverAgent())
    monkeypatch.setattr(gateway, "create_tts_session", _FakeTTS)
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "0")
    client = TestClient(server_mod.app)
    assert client.post("/api/login", json={"username": "bob", "password": MEMBER_PASSWORD}).status_code == 200
    csrf = client.get("/api/session").json()["csrf_token"]
    token = client.cookies[server_mod._COOKIE]
    with client.websocket_connect("/api/voice/call", headers={"Cookie": f"{server_mod._COOKIE}={token}"}) as ws:
        ws.send_json({"type": "init", "csrf": csrf, "thread_id": "voice"})
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "user_text", "text": "在吗"})
        events, _audio = _collect_turn(ws)
    errors = [e for e in events if e["type"] == "error"]
    assert errors and errors[0]["message"] == usage.MODEL_QUOTA_MESSAGE
    assert not [e for e in events if e["type"] == "token"]


def test_feishu_blocked_when_quota_used_up(tmp_path, member_id, monkeypatch):
    from test_feishu_bridge import Env

    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "0")
    env = Env(tmp_path)
    env.bind("ou_bob", member_id)
    env.send("帮我查天气", open_id="ou_bob")
    assert env.agent.calls == [] and env.texts() == [usage.MODEL_QUOTA_MESSAGE]
    assert env.fake.cards == {}                                        # 没开流式卡片


# ---------- 类别接线 ----------

def test_service_invoke_and_briefing_record_as_other(owner_id, monkeypatch):
    kinds = []

    class Agent:
        checkpointer = SimpleNamespace(delete_thread=lambda _tid: None)

        def invoke(self, *_args, **_kwargs):
            kinds.append(usage.current_kind())
            return {"messages": [SimpleNamespace(content="ok")]}

    @contextmanager
    def fake_bundle(_user_id):
        kinds.append(("bundle", usage.current_kind()))
        yield SimpleNamespace(agent=Agent())

    monkeypatch.setattr(server_mod, "_bundle_for", fake_bundle)
    assert server_mod._service_invoke(owner_id, "heartbeat", "主动唤醒", "巡检") == "ok"
    with server_mod._background_bundle_for(owner_id):
        pass
    assert kinds == [("bundle", "other"), "other", ("bundle", "other")]


def test_compose_model_calls_record_as_compose(owner_id):
    from jarvis.flows import compose

    seen = []

    def compose_fn(user_id, prompt):
        seen.append((user_id, usage.current_kind()))
        return "不是 JSON"

    with pytest.raises(compose.ComposeError):
        compose._call_model(lambda u, p: (_ for _ in ()).throw(RuntimeError("down")), owner_id, "x", 5)
    assert compose._call_model(compose_fn, owner_id, "写个早报流程", 5) == "不是 JSON"
    assert seen == [(owner_id, "compose")] and usage.current_kind() == "chat"


# ---------- 定时流程告警 ----------

def test_scheduled_flow_failures_and_pause_alert_admin(owner_id, monkeypatch):
    import test_flow_extras_schedule as T
    from jarvis.flows import schedule as S

    monkeypatch.setattr(S, "LOCAL_TZ", T.CST)
    fired = []
    monkeypatch.setattr(usage, "alert", lambda kind, title, detail="", **kw: fired.append((kind, title, kw.get("owner_id"))))
    T._setup(owner_id, notify={"feishu": False, "desktop": False})
    failing = T.FakeRuntime([{"status": "error", "run_id": "x", "output": None, "error": "「写早报」没成功：模型暂时不可用"}])
    for day in range(12, 17):
        T._scheduler(failing, T.Clock(f"2026-10-{day} 08:00")).tick()
    assert [kind for kind, _t, _o in fired] == ["flow_failing", "flow_failing", "flow_failing", "flow_paused"]
    assert fired[0][1] == "定时流程「早报」连续 2 次没跑成" and fired[-1][1] == "定时流程「早报」已自动暂停"
    assert all(owner == owner_id for _k, _t, owner in fired)


def test_server_configures_push_and_channel_probes(monkeypatch, owner_id):
    """server 注入的推送走 Notifier（桌面领取箱）；渠道探针读飞书 / 微信状态。"""
    from jarvis import delivery, heartbeat
    outbox = heartbeat.PendingOutbox()
    notifier = delivery.Notifier(outbox=outbox)
    monkeypatch.setattr(server_mod, "_notifier", notifier)
    server_mod.usage.configure(
        notify=lambda uid, text: server_mod._notifier.send(uid, text, dt.datetime(2026, 10, 3, 9, 0), icon="⚠️"),
        channels=dict(usage._watch.channels))
    usage.alert("channel_feishu", "飞书长连接断开超过 5 分钟", "长连接已断开")
    [item] = outbox.drain(owner_id)
    assert item["title"].startswith("管理提醒：飞书长连接断开超过 5 分钟")
    assert set(usage._watch.channels) == {"feishu", "wechat"}
    assert usage._watch.channels["feishu"]() == (False, "")            # 测试里飞书没配置
    assert usage._watch.channels["wechat"]() == (False, "")
