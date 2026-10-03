"""第二十轮 §4.2 / §4.3：触发设置接口（只能改自己的、渠道状态、「全部消息」唯一）与链接触发
（令牌只给一次、错令牌 404、限流 429、超时 202、任意 JSON 映射、关掉 / 删掉后 410）。

运行用替身（run_headless 的 source / waiting / quota 归引擎代理）。"""
import hashlib
import json
import threading

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import flows
from jarvis.accounts import AccountStore
from jarvis.flows import engine, hooks
from jarvis.flows.compose import RateLimiter
from jarvis.flows.graph import validate_graph
from jarvis.flows.store import FlowStore
from jarvis.tenancy import TenantStore

FIELDS = [{"key": "city", "label": "城市", "type": "text", "required": True},
          {"key": "note", "label": "备注", "type": "paragraph"},
          {"key": "doc", "label": "资料", "type": "file"}]
OK = {"status": "ok", "run_id": "r1", "error": "",
      "output": {"text": "上海晴", "page_url": "/r/tok123",
                 "links": [{"label": "结果网页", "url": "/r/tok123"}, {"label": "表格.xlsx", "url": "/api/files/abcdefgh12"}]}}


def _graph(fields):
    return validate_graph({
        "nodes": [
            {"id": "start", "type": "start", "position": {"x": 0, "y": 0}, "data": {"fields": fields}},
            {"id": "ai", "type": "llm", "position": {"x": 200, "y": 0}, "data": {"title": "整理", "prompt": "整理"}},
            {"id": "end", "type": "end", "position": {"x": 400, "y": 0}, "data": {"output": "{{ai.text}}"}},
        ],
        "edges": [{"source": "start", "target": "ai"}, {"source": "ai", "target": "end"}],
    })


class Runs:
    def __init__(self):
        self.calls, self.result, self.gate, self.started = [], dict(OK), None, None

    def __call__(self, user_id, flow_id, inputs=None, *, source="schedule"):
        self.calls.append({"user_id": user_id, "flow_id": flow_id, "inputs": inputs, "source": source})
        if self.gate is not None:   # 慢流程：先落一条 running 的运行记录，再等
            self.started = FlowStore().start_run(user_id, flow_id, {"summary": "链接触发"})
            self.gate.wait(5)
        return dict(self.result)


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.unique_active_owner().user_id


@pytest.fixture()
def channels():
    return {"feishu": False, "wechat_owner": True}


@pytest.fixture()
def runs(monkeypatch, owner_id, channels):
    fake = Runs()
    runtime = flows.runtime()
    deps = engine.FlowDeps(tenant_store=TenantStore, feishu_ready=lambda uid: channels["feishu"],
                           wechat_owner=lambda uid: channels["wechat_owner"] and uid == owner_id)
    monkeypatch.setattr(runtime, "deps", deps)
    monkeypatch.setattr(runtime, "run_headless", fake)
    monkeypatch.setattr(hooks, "_wechat_connected", lambda: False)
    monkeypatch.setattr(hooks, "limiter", RateLimiter(hooks.WEBHOOK_RATE, hooks.WEBHOOK_WINDOW))
    monkeypatch.delenv("JARVIS_PUBLIC_URL", raising=False)
    return fake


def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _flow(owner, name="出门提醒", fields=FIELDS):
    return FlowStore().create_flow(owner, name=name, summary=name, graph=_graph(list(fields)))


# ---------- 设置接口 ----------

def test_get_hooks_defaults_and_channel_status(owner_id, runs, channels):
    flow = _flow(owner_id)
    owner = _client()
    body = owner.get(f"/api/flows/{flow['id']}/hooks").json()
    assert body == {"message": None, "webhook": None, "channels": {
        "feishu": {"ready": False, "reason": "还没绑定飞书，先到设置里绑定"},
        "wechat": {"ready": False, "reason": "微信还没连上，先到设置里扫码连接"}}}
    channels["feishu"] = True
    ready = owner.get(f"/api/flows/{flow['id']}/hooks").json()["channels"]["feishu"]
    assert ready == {"ready": True, "reason": ""}
    assert owner.get("/api/flows/nope12345/hooks").status_code == 404


def test_put_message_saves_cleans_and_defaults_input_field(owner_id, runs):
    flow = _flow(owner_id)
    owner = _client()
    saved = owner.put(f"/api/flows/{flow['id']}/hooks/message",
                      json={"channels": ["wechat", "feishu", "feishu"], "match": "keywords",
                            "keywords": ["出门", " 带伞 ", "出门", ""]})
    assert saved.status_code == 200
    message = saved.json()["message"]
    assert message == {"enabled": True, "channels": ["feishu", "wechat"], "match": "keywords",
                       "keywords": ["出门", "带伞"], "input_field": "note", "last_hit_at": None, "last_status": ""}
    assert owner.get(f"/api/flows/{flow['id']}/hooks").json()["message"] == message
    off = owner.put(f"/api/flows/{flow['id']}/hooks/message", json={"enabled": False}).json()["message"]
    assert off["enabled"] is False and off["keywords"] == ["出门", "带伞"] and off["channels"] == ["feishu", "wechat"]
    on = owner.put(f"/api/flows/{flow['id']}/hooks/message", json={"enabled": True, "input_field": "city"}).json()
    assert on["message"]["enabled"] is True and on["message"]["input_field"] == "city"


@pytest.mark.parametrize("body, error", [
    ({"channels": [], "keywords": ["出门"]}, "至少选一个渠道：飞书或微信"),
    ({"channels": ["dingtalk"], "keywords": ["出门"]}, "渠道只能选飞书或微信"),
    ({"channels": ["feishu"], "match": "regex"}, "触发条件只能选「收到的全部消息」或「包含关键词」"),
    ({"channels": ["feishu"], "keywords": []}, "至少填一个关键词，或者改成「收到的全部消息」"),
    ({"channels": ["feishu"], "keywords": [f"词{i}" for i in range(11)]}, "关键词最多 10 个，删掉几个"),
    ({"channels": ["feishu"], "keywords": ["这是一个超过二十个字的很长很长很长很长的关键词"]}, "每个关键词最多 20 个字"),
    ({"channels": ["feishu"], "keywords": ["出门"], "input_field": "nope"}, "「消息填进哪个输入」要选这条流程开始节点里的一个输入"),
    ({"channels": ["feishu"], "keywords": ["出门"], "enabled": "yes"}, "开关的值不对"),
])
def test_put_message_validation(owner_id, runs, body, error):
    flow = _flow(owner_id)
    response = _client().put(f"/api/flows/{flow['id']}/hooks/message", json=body)
    assert response.status_code == 400 and error in response.json()["error"]


def test_only_one_catch_all_flow_per_channel(owner_id, runs):
    first, second = _flow(owner_id, "收件箱"), _flow(owner_id, "备忘")
    owner = _client()
    assert owner.put(f"/api/flows/{first['id']}/hooks/message",
                     json={"channels": ["feishu"], "match": "all"}).status_code == 200
    clash = owner.put(f"/api/flows/{second['id']}/hooks/message", json={"channels": ["feishu", "wechat"], "match": "all"})
    assert clash.status_code == 409
    assert clash.json()["error"].startswith("「收件箱」已经在飞书上接收全部消息了")
    assert owner.put(f"/api/flows/{second['id']}/hooks/message",
                     json={"channels": ["wechat"], "match": "all"}).status_code == 200            # 别的渠道可以
    assert owner.put(f"/api/flows/{second['id']}/hooks/message",
                     json={"channels": ["feishu"], "match": "keywords", "keywords": ["备忘"]}).status_code == 200
    owner.put(f"/api/flows/{first['id']}/hooks/message", json={"enabled": False})
    assert owner.put(f"/api/flows/{second['id']}/hooks/message",
                     json={"channels": ["feishu"], "match": "all"}).status_code == 200            # 那条关掉后就行
    FlowStore().delete_flow(owner_id, second["id"])                                                  # 删掉的流程不再占位
    assert owner.put(f"/api/flows/{first['id']}/hooks/message",
                     json={"enabled": True, "channels": ["feishu"], "match": "all"}).status_code == 200


def test_settings_only_for_own_flows_and_need_login_and_csrf(owner_id, runs):
    flow = _flow(owner_id)
    AccountStore().create_user("member", "Member-pass-123", "Member")
    member = _client("member", "Member-pass-123")
    assert member.get(f"/api/flows/{flow['id']}/hooks").status_code == 404
    assert member.put(f"/api/flows/{flow['id']}/hooks/message", json={"channels": ["feishu"], "keywords": ["x"]}).status_code == 404
    assert member.post(f"/api/flows/{flow['id']}/hooks/webhook").status_code == 404
    assert member.delete(f"/api/flows/{flow['id']}/hooks/webhook").status_code == 404
    anon = TestClient(server_mod.app)
    assert anon.get(f"/api/flows/{flow['id']}/hooks").status_code == 401
    owner = _client()
    del owner.headers["X-JWS-CSRF"]
    assert owner.put(f"/api/flows/{flow['id']}/hooks/message", json={"keywords": ["x"]}).status_code == 403
    assert owner.post(f"/api/flows/{flow['id']}/hooks/webhook").status_code == 403
    assert hooks.HookStore().get(owner_id, flow["id"], "message") is None


def test_member_wechat_channel_is_owner_only(owner_id, runs):
    member_id = AccountStore().create_user("member", "Member-pass-123", "Member")["id"]
    flow = _flow(member_id)
    wechat = _client("member", "Member-pass-123").get(f"/api/flows/{flow['id']}/hooks").json()["channels"]["wechat"]
    assert wechat == {"ready": False, "reason": "微信只连着管理员账号，这个账号收不到微信消息"}


# ---------- 链接触发 ----------

def _issue(client, flow_id):
    response = client.post(f"/api/flows/{flow_id}/hooks/webhook")
    assert response.status_code == 200
    body = response.json()
    return body, body["url"].rsplit("/", 1)[1]


def test_issue_gives_token_once_and_stores_only_hash(owner_id, runs):
    flow = _flow(owner_id)
    owner = _client()
    body, token = _issue(owner, flow["id"])
    assert body["url"] == f"http://testserver/api/hooks/{token}" and len(token) >= 30
    assert body["webhook"]["enabled"] is True and body["webhook"]["created_at"]
    assert body["webhook"]["url_hint"] == f"/api/hooks/{token[:6]}…"
    again = owner.get(f"/api/flows/{flow['id']}/hooks").json()
    assert again["webhook"] == body["webhook"] and token not in json.dumps(again)    # 之后只显示提示，不再给明文
    with TenantStore()._connect() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM tenant_flow_hooks").fetchall()]
    assert token not in json.dumps(rows) and rows[0]["token_hash"] == hashlib.sha256(token.encode()).hexdigest()


def test_public_url_is_used_for_the_link(owner_id, runs, monkeypatch):
    monkeypatch.setenv("JARVIS_PUBLIC_URL", "https://jv.example.com")
    body, token = _issue(_client(), _flow(owner_id)["id"])
    assert body["url"] == f"https://jv.example.com/api/hooks/{token}"


def test_hit_with_inputs_runs_and_returns_result(owner_id, runs):
    flow = _flow(owner_id)
    _body, token = _issue(_client(), flow["id"])
    anon = TestClient(server_mod.app)
    response = anon.post(f"/api/hooks/{token}", json={"inputs": {"城市": "上海", "note": "带伞"}})
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "run_id": "r1", "output": {
        "text": "上海晴", "page_url": "http://testserver/r/tok123",
        "links": [{"label": "结果网页", "url": "http://testserver/r/tok123"},
                  {"label": "表格.xlsx", "url": "http://testserver/api/files/abcdefgh12"}]}}
    assert runs.calls == [{"user_id": owner_id, "flow_id": flow["id"], "source": "webhook",
                           "inputs": {"city": "上海", "note": "带伞"}}]
    hook = hooks.HookStore().get(owner_id, flow["id"], "webhook")
    assert hook["last_hit_at"] and hook["last_status"] == "ok"


def test_arbitrary_json_is_mapped_by_keys_or_as_text(owner_id, runs):
    _body, token = _issue(_client(), _flow(owner_id)["id"])
    anon = TestClient(server_mod.app)
    anon.post(f"/api/hooks/{token}", json={"城市": "杭州", "doc": "file_id=AbCdEf123456", "extra": 1})
    assert runs.calls[-1]["inputs"] == {"city": "杭州", "doc": {"file_id": "AbCdEf123456"}}
    anon.post(f"/api/hooks/{token}", json={"event": "push", "repo": "jws"})
    assert runs.calls[-1]["inputs"] == {"city": json.dumps({"event": "push", "repo": "jws"}, ensure_ascii=False, indent=2)}
    anon.post(f"/api/hooks/{token}", json=["a", "b"])
    assert runs.calls[-1]["inputs"] == {"city": '[\n  "a",\n  "b"\n]'}
    anon.post(f"/api/hooks/{token}", content=b"")
    assert runs.calls[-1]["inputs"] == {}
    anon.post(f"/api/hooks/{token}", json="宁波")
    assert runs.calls[-1]["inputs"] == {"city": "宁波"}


def test_wrong_and_malformed_tokens_are_404(owner_id, runs):
    _issue(_client(), _flow(owner_id)["id"])
    anon = TestClient(server_mod.app)
    assert anon.post("/api/hooks/" + "x" * 32, json={}).status_code == 404
    assert anon.post("/api/hooks/short", json={}).status_code == 404
    assert "不存在" in anon.post("/api/hooks/" + "y" * 32, json={}).json()["error"]
    assert runs.calls == []


def test_rate_limit_per_token(owner_id, runs, monkeypatch):
    monkeypatch.setattr(hooks, "limiter", RateLimiter(2, 60))
    _body, token = _issue(_client(), _flow(owner_id)["id"])
    anon = TestClient(server_mod.app)
    assert [anon.post(f"/api/hooks/{token}", json={}).status_code for _ in range(2)] == [200, 200]
    limited = anon.post(f"/api/hooks/{token}", json={})
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) >= 1
    assert "每个链接每分钟最多" in limited.json()["error"] and len(runs.calls) == 2


def test_slow_run_returns_202_with_run_id(owner_id, runs, monkeypatch):
    monkeypatch.setattr(hooks, "WEBHOOK_WAIT_SECONDS", 0.2)
    flow = _flow(owner_id)
    _body, token = _issue(_client(), flow["id"])
    runs.gate = threading.Event()
    try:
        response = TestClient(server_mod.app).post(f"/api/hooks/{token}", json={"inputs": {"城市": "上海"}})
    finally:
        runs.gate.set()
    assert response.status_code == 202
    assert response.json() == {"status": "running", "run_id": runs.started}


def test_reset_invalidates_old_token_and_close_or_delete_gives_410(owner_id, runs):
    flow = _flow(owner_id)
    owner, anon = _client(), TestClient(server_mod.app)
    _b, old = _issue(owner, flow["id"])
    _b, new = _issue(owner, flow["id"])
    assert anon.post(f"/api/hooks/{old}", json={}).status_code == 404
    assert anon.post(f"/api/hooks/{new}", json={}).status_code == 200
    closed = owner.delete(f"/api/flows/{flow['id']}/hooks/webhook")
    assert closed.status_code == 200 and closed.json()["webhook"]["enabled"] is False
    gone = anon.post(f"/api/hooks/{new}", json={})
    assert gone.status_code == 410 and "关掉" in gone.json()["error"]
    _b, again = _issue(owner, flow["id"])
    FlowStore().delete_flow(owner_id, flow["id"])
    deleted = anon.post(f"/api/hooks/{again}", json={})
    assert deleted.status_code == 410 and "删掉" in deleted.json()["error"]
    assert len(runs.calls) == 1


def test_disabled_account_link_is_410(owner_id, runs):
    member_id = AccountStore().create_user("member", "Member-pass-123", "Member")["id"]
    flow = _flow(member_id)
    _b, token = _issue(_client("member", "Member-pass-123"), flow["id"])
    AccountStore().update_user(member_id, active=False)
    response = TestClient(server_mod.app).post(f"/api/hooks/{token}", json={})
    assert response.status_code == 410 and runs.calls == []


def test_body_size_and_bad_json(owner_id, runs):
    _body, token = _issue(_client(), _flow(owner_id)["id"])
    anon = TestClient(server_mod.app)
    big = anon.post(f"/api/hooks/{token}", content=b'{"a": "' + b"x" * (256 * 1024) + b'"}',
                    headers={"Content-Type": "application/json"})
    assert big.status_code == 413 and "256KB" in big.json()["error"]
    bad = anon.post(f"/api/hooks/{token}", content=b"{not json", headers={"Content-Type": "application/json"})
    assert bad.status_code == 400 and "JSON" in bad.json()["error"]
    assert runs.calls == []


@pytest.mark.parametrize("result, code, extra", [
    ({"status": "busy", "error": "你有一条流程正在运行，等它跑完再试"}, 409, {}),
    ({"status": "quota", "error": "今天的流程运行次数到上限了"}, 429, {}),
    ({"status": "error", "error": "「整理」：模型没回话"}, 200, {}),
    ({"status": "waiting", "approval": {"id": "ap12345678", "url": "/approve/ap12345678",
                                        "expires_at": "2026-10-04T08:00:00+00:00"}}, 200,
     {"approval": {"id": "ap12345678", "url": "http://testserver/approve/ap12345678",
                   "expires_at": "2026-10-04T08:00:00+00:00"}}),
])
def test_not_ok_statuses(owner_id, runs, result, code, extra):
    _body, token = _issue(_client(), _flow(owner_id)["id"])
    runs.result = {"run_id": "r2", "output": None, "error": "", **result}
    response = TestClient(server_mod.app).post(f"/api/hooks/{token}", json={})
    assert response.status_code == code
    body = response.json()
    assert body["status"] == result["status"] and body["run_id"] == "r2"
    if result.get("error"):
        assert body["error"] == result["error"]
    for key, value in extra.items():
        assert body[key] == value


def test_flow_list_shows_trigger_marks(owner_id, runs):
    """流程卡片上的触发方式小标记：列表每项带 hooks.{message, webhook}（只算开着的）。"""
    flow = _flow(owner_id)
    owner = _client()
    listed = {f["id"]: f for f in owner.get("/api/flows").json()["flows"]}
    assert listed[flow["id"]]["hooks"] == {"message": False, "webhook": False}
    owner.put(f"/api/flows/{flow['id']}/hooks/message", json={"enabled": True, "channels": ["feishu"], "match": "keywords",
                                                               "keywords": ["出门"]})
    _issue(owner, flow["id"])
    listed = {f["id"]: f for f in owner.get("/api/flows").json()["flows"]}
    assert listed[flow["id"]]["hooks"] == {"message": True, "webhook": True}
    owner.delete(f"/api/flows/{flow['id']}/hooks/webhook")
    listed = {f["id"]: f for f in owner.get("/api/flows").json()["flows"]}
    assert listed[flow["id"]]["hooks"] == {"message": True, "webhook": False}
