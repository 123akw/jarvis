"""第二十轮「单节点试跑」（契约 §3.2）：上游产出取最近一次运行里存下的、缺了用 inputs 现填开始的输入、
仍缺说人话；有副作用的积木（发飞书、加到待办、生成网页……）与会写数据的插件工具只预演、注明「试跑不会真的…」；
不写运行记录、不占并发闸；条件分支告诉走哪条；上游改过设置时提示；配额 429；节点不在了 404。"""
import json

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import flows, usage
from jarvis.accounts import AccountStore
from jarvis.flows import engine
from jarvis.flows.nodes import tool_writes
from jarvis.flows.store import FlowStore
from jarvis.tenancy import TenantStore


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


@pytest.fixture()
def fake(monkeypatch, owner_id):
    state = {"prompts": [], "pushed": [], "reply": "明天有雨，记得带伞"}

    def compose(user_id, prompt):
        state["prompts"].append(prompt)
        return state["reply"]

    deps = engine.FlowDeps(tenant_store=TenantStore, compose=compose, feishu_ready=lambda uid: True,
                           push_feishu=lambda uid, text: state["pushed"].append(text) or True)
    runtime = flows.runtime()
    monkeypatch.setattr(runtime, "deps", deps)
    monkeypatch.setattr(runtime, "guard", engine.RunGuard())
    monkeypatch.setattr(runtime, "timeouts", {})
    monkeypatch.setattr(usage, "check_flow_run", lambda uid: None)
    state["runtime"] = runtime
    return state


def _client():
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _sse(response):
    return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def _e(source, target, handle=None):
    return {"source": source, "target": target, "sourceHandle": handle}


RAIN = {"id": "rain", "label": "下雨", "logic": "and", "rules": [{"var": "ai.text", "op": "contains", "value": "雨"}]}
GRAPH = {"nodes": [
    {"id": "start", "type": "start", "data": {"fields": [{"key": "city", "label": "城市", "type": "text", "required": True}]}},
    {"id": "ai", "type": "llm", "data": {"title": "AI 看天气", "prompt": "{{start.city}} 明天天气怎样"}},
    {"id": "tpl", "type": "template", "data": {"title": "拼提醒", "template": "提醒：{{ai.text}}\n- 出门看天"}},
    {"id": "cond", "type": "condition", "data": {"title": "下不下雨", "cases": [RAIN]}},
    {"id": "send", "type": "step", "data": {"title": "发到飞书", "step": "feishu_send"}},
    {"id": "todo", "type": "step", "data": {"title": "加到待办", "step": "to_todo"}},
    {"id": "add", "type": "tool", "data": {"title": "记待办", "plugin": "todo", "tool": "todo_add",
                                           "args": {"content": "{{tpl.text}}"}}},
    {"id": "end", "type": "end", "data": {"output": "{{tpl.text}}", "page": True}},
], "edges": [_e("start", "ai"), _e("ai", "tpl"), _e("ai", "cond"), _e("cond", "send", "rain"), _e("tpl", "todo"),
             _e("tpl", "add"), _e("todo", "end"), _e("add", "end"), _e("cond", "end", "else")]}


def _todos(owner_id):
    return [t["content"] for t in TenantStore().list_todos(owner_id=owner_id)]


def _trial(client, flow_id, node_id, inputs=None):
    body = {"inputs": inputs} if inputs is not None else {}
    return client.post(f"/api/flows/{flow_id}/nodes/{node_id}/test", json=body)


def test_trial_before_any_run_needs_inputs_then_uses_them(fake, owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "出门提醒", "graph": GRAPH}).json()["flow"]
    r = _trial(owner, flow["id"], "ai")
    assert r.status_code == 200 and r.json()["status"] == "error"
    assert r.json()["error"] == "先完整跑一次，或填上开始的输入"
    r = _trial(owner, flow["id"], "tpl")
    assert r.json()["error"] == "前面的「AI 看天气」还没有运行结果：先完整跑一次，或填上开始的输入"
    r = _trial(owner, flow["id"], "ai", {"city": "深圳"})
    body = r.json()
    assert body["status"] == "ok" and body["output"] == {"text": "明天有雨，记得带伞", "items": [], "links": []}
    assert body["error"] == "" and body["ms"] >= 0 and body["summary"].startswith("写好了")
    assert "深圳" in fake["prompts"][-1]
    start = _trial(owner, flow["id"], "start", {"city": "广州"}).json()
    assert start["status"] == "ok" and start["output"]["text"] == "广州"
    assert FlowStore().list_runs(owner_id, flow["id"]) == []   # 试跑不写运行记录


def test_trial_uses_saved_upstream_and_never_sends_or_writes(fake, owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "出门提醒", "graph": GRAPH}).json()["flow"]
    with owner.stream("POST", f"/api/flows/{flow['id']}/run", json={"inputs": {"city": "深圳"}}) as r:
        assert _sse(r)[-1]["status"] == "ok"
    assert len(fake["pushed"]) == 1 and len(_todos(owner_id)) == 2   # 正式运行：真发、真加（to_todo 1 条 + 记待办 1 条）
    pushed, todos = list(fake["pushed"]), _todos(owner_id)
    fake["reply"] = "这次不该被用到"
    calls = len(fake["prompts"])
    assert fake["runtime"].guard.acquire(owner_id)   # 试跑不占闸：账号正忙也能试
    tpl = _trial(owner, flow["id"], "tpl").json()
    assert tpl["status"] == "ok" and tpl["output"]["text"] == "提醒：明天有雨，记得带伞\n- 出门看天"
    assert tpl["output"]["items"] == ["出门看天"] and len(fake["prompts"]) == calls   # 用存下的 AI 结果，不再调模型
    send = _trial(owner, flow["id"], "send").json()
    assert send["status"] == "ok" and send["note"] == "试跑不会真的发送：这里是要发到飞书的内容"
    assert "明天有雨，记得带伞" in send["output"]["text"] and send["summary"] == "试跑：没有真的发送"
    todo = _trial(owner, flow["id"], "todo").json()
    assert todo["note"] == "试跑不会真的加到待办：这里是要加的 1 条" and todo["output"]["items"] == ["出门看天"]
    add = _trial(owner, flow["id"], "add").json()
    assert add["status"] == "ok" and add["note"] == "试跑不会真的执行「记待办」：这里是要用的内容"
    assert add["output"]["text"] == "- 内容：提醒：明天有雨，记得带伞\n- 出门看天"
    end = _trial(owner, flow["id"], "end").json()
    assert end["note"] == "试跑不会真的生成结果网页：这里是网页里的内容" and end["output"]["links"] == []
    cond = _trial(owner, flow["id"], "cond").json()
    assert cond["status"] == "ok" and cond["note"] == "会走「下雨」" and cond["output"]["text"] == ""
    assert fake["pushed"] == pushed and _todos(owner_id) == todos   # 什么都没真的发、真的加
    assert len(FlowStore().list_runs(owner_id, flow["id"])) == 1
    fake["runtime"].guard.release(owner_id)


def test_trial_notes_changed_upstream_and_errors(fake, owner_id, monkeypatch):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "出门提醒", "graph": GRAPH}).json()["flow"]
    with owner.stream("POST", f"/api/flows/{flow['id']}/run", json={"inputs": {"city": "深圳"}}) as r:
        _sse(r)
    changed = json.loads(json.dumps(GRAPH))
    changed["nodes"][1]["data"]["prompt"] = "{{start.city}} 后天天气"
    owner.put(f"/api/flows/{flow['id']}", json={"name": "出门提醒", "graph": changed})
    tpl = _trial(owner, flow["id"], "tpl").json()
    assert tpl["status"] == "ok" and tpl["note"] == "「AI 看天气」改过设置，这里用的是改之前那次的结果"
    assert _trial(owner, flow["id"], "nope").status_code == 404
    assert _trial(owner, flow["id"], "nope").json() == {"error": "这个节点已经不在流程里了，刷新一下再试"}
    assert owner.post("/api/flows/zzz/nodes/ai/test", json={}).status_code == 404
    monkeypatch.setattr(usage, "check_flow_run", lambda uid: "今天的流程运行次数到上限了")
    r = _trial(owner, flow["id"], "tpl")
    assert r.status_code == 429 and r.json() == {"error": "今天的流程运行次数到上限了"}
    no_csrf = TestClient(server_mod.app)
    no_csrf.post("/api/login", json={"username": "admin", "password": "admin"})
    assert no_csrf.post(f"/api/flows/{flow['id']}/nodes/tpl/test", json={}).status_code == 403


def test_trial_failure_says_which_step(fake, owner_id):
    owner = _client()
    graph = {"nodes": [GRAPH["nodes"][0], {"id": "ai", "type": "llm", "data": {"title": "AI 看天气", "prompt": ""}},
                       {"id": "end", "type": "end", "data": {}}], "edges": [_e("start", "ai"), _e("ai", "end")]}
    flow = owner.post("/api/flows", json={"name": "x", "graph": graph}).json()["flow"]
    r = _trial(owner, flow["id"], "ai", {"city": "深圳"}).json()
    assert r["status"] == "error" and r["error"] == "「AI 看天气」还没写要 AI 做什么"


def test_tool_writes_rules():
    assert tool_writes("todo", "todo_add") and tool_writes("memo", "memo_del") and tool_writes("todo", "todo_done")
    assert tool_writes("memory", "profile_remember") and tool_writes("memory", "profile_forget")
    assert tool_writes("meeting", "meeting_start") and tool_writes("schedule", "schedule_add")
    assert not tool_writes("todo", "todo_list") and not tool_writes("weather", "weather")
    assert not tool_writes("workday_calc", "workday_calc_add")   # 算日期，不写数据
    assert not tool_writes("excel", "excel_summary")
