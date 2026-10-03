"""第十八轮流程接口（契约 §3.1–3.3）：节点目录（Owner vs 智能体账号）、节点图 CRUD 与列表字段、
触发器读取与删除、运行 SSE 事件序列（含分支跳过）、运行记录、旧行（graph 为空）读与跑、旧运行记录的展示。"""
import base64
import datetime as dt
import json

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import flows, platforms
from jarvis.accounts import AccountStore
from jarvis.flows import engine
from jarvis.flows.store import FlowStore
from jarvis.tenancy import TenantStore


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


@pytest.fixture()
def fake(monkeypatch, owner_id):
    prompts = []

    def compose(user_id, prompt):
        prompts.append(prompt)
        return "AI：" + ("要带伞" if "雨" in prompt else "不用带伞")

    deps = engine.FlowDeps(tenant_store=TenantStore, compose=compose, describe_image=lambda data, ext: "一张图")
    runtime = flows.runtime()
    monkeypatch.setattr(runtime, "deps", deps)
    monkeypatch.setattr(runtime, "guard", engine.RunGuard())
    monkeypatch.setattr(runtime, "timeouts", {})
    monkeypatch.setattr(runtime, "platform_lookup", lambda owner: None)
    return prompts


def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _sse(response):
    return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def _e(source, target, handle=None):
    return {"source": source, "target": target, "sourceHandle": handle}


GRAPH = {
    "nodes": [
        {"id": "start", "type": "start", "position": {"x": 0, "y": 0},
         "data": {"fields": [{"key": "city", "label": "城市", "type": "text", "required": True},
                             {"key": "doc", "label": "资料", "type": "file"}]}},
        {"id": "ai", "type": "llm", "position": {"x": 240, "y": 0},
         "data": {"title": "看天气", "prompt": "{{start.city}} 明天的天气：{{start.doc}}"}},
        {"id": "cond", "type": "condition", "position": {"x": 480, "y": 0},
         "data": {"cases": [{"id": "rain", "label": "下雨", "rules": [{"var": "ai.text", "op": "contains", "value": "带伞"},
                                                                      {"var": "ai.text", "op": "not_contains", "value": "不用"}]}]}},
        {"id": "todo", "type": "tool", "position": {"x": 720, "y": -80},
         "data": {"title": "记待办", "plugin": "todo", "tool": "todo_add", "args": {"content": "带伞去{{start.city}}"}}},
        {"id": "end", "type": "end", "position": {"x": 960, "y": 0},
         "data": {"output": "{{ai.text}}", "page": True}},
    ],
    "edges": [_e("start", "ai"), _e("ai", "cond"), _e("cond", "todo", "rain"), _e("cond", "end", "else"),
              _e("todo", "end")],
}


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


# ---------- 节点目录 ----------

def _items(catalog, group):
    return {item["key"]: item for g in catalog["groups"] if g["id"] == group for item in g["items"]}


def test_node_catalog_route_and_shape(fake):
    anon = TestClient(server_mod.app)
    assert anon.get("/api/flows/nodes").status_code == 401
    catalog = _client().get("/api/flows/nodes").json()   # 没被 /api/flows/{flow_id} 抢先匹配
    assert [g["id"] for g in catalog["groups"]] == ["basic", "tools", "skills", "steps"]
    assert [g["label"] for g in catalog["groups"]] == ["基础", "插件工具", "技能", "积木"]
    assert set(_items(catalog, "basic")) == {"llm", "condition", "template", "end"}
    weather = _items(catalog, "tools")["tool:weather:weather"]
    assert weather["title"] == "查城市天气" and weather["plugin_name"] == "查天气" and weather["category"] == "life"
    assert weather["args"] == [{"name": "city", "label": "城市", "type": "string", "required": True,
                                "description": weather["args"][0]["description"], "enum": None, "default": None}]
    assert weather["data"] == {"title": "查城市天气", "plugin": "weather", "tool": "weather", "args": {}}
    assert weather["available"] is True and weather["reason"] == ""
    salary = _items(catalog, "tools")["tool:tax_calc:tax_calc_salary"]
    assert {a["name"]: a["type"] for a in salary["args"]}["monthly_salary"] == "number"
    skill = _items(catalog, "skills")["skill:work_report"]
    assert skill["type"] == "llm" and skill["data"]["skill"] == "work_report" and skill["available"]
    steps = _items(catalog, "steps")
    assert "step:input_text" not in steps and "step:input_file" not in steps   # 输入积木并进了开始节点
    assert steps["step:ai_extract"]["role"] == "process" and steps["step:to_todo"]["role"] == "output"
    assert steps["step:feishu_send"]["available"] is False and steps["step:feishu_send"]["reason"] == "先在设置里绑定飞书"
    assert steps["step:split_file"]["data"]["options"] == {"mode": "chapter", "max_parts": 8}
    assert {"key": "max_parts", "label": "最多几段", "type": "number", "default": 8, "min": 2, "max": 20} in \
        steps["step:split_file"]["options"]
    assert [v["key"] for v in catalog["vars"]["sys"]] == ["date", "time", "weekday"]
    assert catalog["field_types"] == ["text", "paragraph", "file", "number", "select"]


def test_node_catalog_for_agent_account_lists_missing_plugins_with_reason(fake):
    member = AccountStore().create_user("member", "Member-pass-123", "Member")["id"]
    platforms.PlatformStore().create(member, platforms.clean_platform(
        {"name": "小林奶茶", "icon": "🧋", "accent": "#FF9F0A", "profession": "shop_owner", "plugins": ["todo"]}))
    catalog = _client("member", "Member-pass-123").get("/api/flows/nodes").json()
    tools = _items(catalog, "tools")
    assert tools["tool:todo:todo_add"]["available"] is True
    assert tools["tool:weather:weather"]["available"] is False
    assert tools["tool:weather:weather"]["reason"] == "这个智能体还没装「查天气」，到智能体设置里加上就能用"
    assert _items(catalog, "skills")["skill:work_report"]["available"] is False


# ---------- CRUD ----------

def test_graph_crud_list_fields_and_trigger(fake, owner_id):
    owner = _client()
    created = owner.post("/api/flows", json={"name": " 出门  提醒 ", "graph": GRAPH})
    assert created.status_code == 201
    flow = created.json()["flow"]
    assert flow["name"] == "出门 提醒" and flow["summary"] == "看天气 → 条件分支 → 记待办 → 结束"
    assert flow["graph"]["nodes"][3]["data"]["args"] == {"content": "带伞去{{start.city}}"}
    assert owner.get(f"/api/flows/{flow['id']}").json()["flow"] == flow
    listed = owner.get("/api/flows").json()["flows"][0]
    assert listed["node_count"] == 5 and listed["plugins"] == ["todo"] and listed["trigger"] is None
    assert listed["last_run"] is None and listed["graph"] == flow["graph"]
    bad = owner.put(f"/api/flows/{flow['id']}", json={"name": "x", "graph": {**GRAPH, "edges": GRAPH["edges"] + [_e("end", "ai")]}})
    assert bad.status_code == 400 and bad.json() == {"error": "「结束」节点后面不能再接节点，删掉从「结束」连出去的线"}
    assert owner.post("/api/flows", json={"name": "空"}).json() == {"error": "流程里还没有节点"}
    assert set(flow["config_hashes"]) == {"start", "ai", "cond", "todo", "end"}
    with FlowStore()._connect() as c:   # 定时运行由 extras 写；这里只验证读取与删除
        c.execute("INSERT INTO tenant_flow_triggers(owner_id, flow_id, kind, config, enabled, next_run_at, updated_at)"
                  " VALUES (?, ?, 'schedule', ?, 1, '2026-10-04T08:00:00+08:00', 'x')",
                  (owner_id, flow["id"], json.dumps({"schedule": {"repeat": "weekdays", "time": "08:00"}})))
    listed = owner.get("/api/flows").json()["flows"][0]
    assert listed["trigger"] == {"kind": "schedule", "label": "每个工作日 08:00", "next_run_at": "2026-10-04T08:00:00+08:00",
                                 "last_run_at": None, "last_status": ""}
    assert owner.get(f"/api/flows/{flow['id']}").json()["flow"]["trigger"]["label"] == "每个工作日 08:00"
    assert owner.delete(f"/api/flows/{flow['id']}").json() == {"ok": True}
    with FlowStore()._connect() as c:
        assert c.execute("SELECT COUNT(*) FROM tenant_flow_triggers").fetchone()[0] == 0


# ---------- 运行 SSE ----------

def test_run_streams_node_events_with_branch_skip(fake, owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "出门提醒", "graph": GRAPH}).json()["flow"]
    with owner.stream("POST", f"/api/flows/{flow['id']}/run",
                      json={"inputs": {"city": "深圳", "doc": {"name": "预报.md", "data_base64": _b64("明天有雨")}}}) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        events = _sse(r)
    assert [(e["type"], e.get("node_id")) for e in events] == [
        ("run_start", None), ("node_start", "start"), ("node_done", "start"), ("node_start", "ai"), ("node_done", "ai"),
        ("node_start", "cond"), ("node_done", "cond"), ("node_start", "todo"), ("node_done", "todo"),
        ("node_start", "end"), ("node_done", "end"), ("run_done", None)]
    assert events[1] == {"type": "node_start", "node_id": "start", "node_type": "start", "title": "开始",
                         "config_hash": flow["config_hashes"]["start"]}
    assert all(e["config_hash"] == flow["config_hashes"][e["node_id"]] for e in events if "node_id" in e)
    assert events[4]["output"] == {"text": "AI：要带伞"} and events[4]["summary"] == "写好了（6 字）"
    assert "明天有雨" in fake[0] and "深圳" in fake[0]   # 文件字段的正文进了模型
    done = events[-1]
    assert done["status"] == "ok" and done["output"]["text"] == "AI：要带伞" and done["output"]["page_url"].startswith("/r/")
    assert done["ms"] >= 0
    runs = owner.get(f"/api/flows/{flow['id']}/runs").json()["runs"]
    assert set(runs[0]) >= {"id", "status", "started_at", "finished_at", "ms", "input_summary", "nodes", "output_text",
                            "page_url", "error"}
    assert runs[0]["input_summary"] == "城市：深圳 · 资料：预报.md" and runs[0]["output_text"] == "AI：要带伞"
    assert runs[0]["nodes"][2] == {"node_id": "cond", "title": "条件分支", "node_type": "condition", "status": "ok",
                                   "summary": "走「下雨」", "preview": "", "ms": runs[0]["nodes"][2]["ms"],
                                   "config_hash": flow["config_hashes"]["cond"]}
    listed = owner.get("/api/flows").json()["flows"][0]["last_run"]
    assert listed["status"] == "ok" and listed["id"] == events[0]["run_id"] and listed["started_at"]
    with owner.stream("POST", f"/api/flows/{flow['id']}/run", json={"inputs": {"city": "北京"}}) as r:
        events = _sse(r)
    assert [e["node_id"] for e in events if e["type"] == "node_skip"] == ["todo"]
    assert next(e for e in events if e["type"] == "node_skip")["reason"] == "「条件分支」走了「其他情况」，没走这条"


def test_run_input_errors(fake, owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "x", "graph": GRAPH}).json()["flow"]
    url = f"/api/flows/{flow['id']}/run"
    huge = "A" * ((10 * 1024 * 1024 + 2) // 3 * 4 + 8)
    assert owner.post(url, json={"inputs": {"doc": {"name": "a.txt", "data_base64": huge}}}).json() == {"error": "文件超过 10MB 上限"}
    assert owner.post(url, json={"inputs": {"doc": {"name": "a.txt", "data_base64": "!!"}}}).status_code == 422
    assert owner.post(url, json={"inputs": {"city": ["列表"]}}).json() == {"error": "输入格式不对"}
    with owner.stream("POST", url, json={"inputs": {}}) as r:   # 必填没填：开始节点报错
        events = _sse(r)
    assert events[2] == {"type": "node_error", "node_id": "start", "message": "「开始」：请先填写「城市」",
                         "ms": events[2]["ms"], "config_hash": flow["config_hashes"]["start"]}
    assert events[-1]["status"] == "error" and events[-1]["error"] == "「开始」：请先填写「城市」"


# ---------- 旧数据兼容 ----------

LEGACY_STEPS = [{"id": "a1", "plugin": "input_text", "options": {"label": "说说新品卖点"}},
                {"id": "b2", "plugin": "ai_extract", "options": {"task": "改写", "instruction": ""}},
                {"id": "c3", "plugin": "web_page", "options": {"title": "今日上新"}}]


def test_legacy_row_without_graph_reads_and_runs(fake, owner_id):
    store = FlowStore()
    legacy = store.create_flow(owner_id, name="上新文案", summary="说说卖点", steps=LEGACY_STEPS)   # v6 的行：graph 为空串
    with store._connect() as c:
        assert c.execute("SELECT graph FROM tenant_flows WHERE id=?", (legacy["id"],)).fetchone()[0] == ""
    owner = _client()
    flow = owner.get(f"/api/flows/{legacy['id']}").json()["flow"]
    assert [n["id"] for n in flow["graph"]["nodes"]] == ["start", "b2", "c3", "end"]
    assert flow["graph"]["nodes"][0]["data"]["fields"][0]["placeholder"] == "说说新品卖点"
    assert flow["graph"]["nodes"][1]["data"]["title"] == "AI 提炼" and flow["summary"] == "说说卖点"
    with owner.stream("POST", f"/api/flows/{legacy['id']}/run", json={"text": "桂花拿铁上新"}) as r:   # v6 的请求体
        events = _sse(r)
    assert events[-1]["status"] == "ok" and events[-1]["output"]["page_url"].startswith("/r/")
    assert FlowStore().get_page(events[-1]["output"]["page_url"][3:])["title"] == "今日上新"
    saved = owner.put(f"/api/flows/{legacy['id']}", json={"name": "上新文案", "graph": flow["graph"]}).json()["flow"]
    with store._connect() as c:   # 再保存一次就写成节点图
        row = c.execute("SELECT graph, steps FROM tenant_flows WHERE id=?", (legacy["id"],)).fetchone()
    assert json.loads(row["graph"]) == saved["graph"] and row["steps"] == "[]"


def test_legacy_run_records_show_as_nodes(fake, owner_id):
    store = FlowStore()
    flow = store.create_flow(owner_id, name="旧", summary="", steps=LEGACY_STEPS)
    run_id = store.start_run(owner_id, flow["id"], {"kind": "text", "chars": 6})
    store.finish_run(owner_id, run_id, status="ok", steps=[
        {"step_id": "a1", "plugin": "input_text", "status": "ok", "summary": "收到 6 字", "preview": "桂花", "ms": 3}])
    run = _client().get(f"/api/flows/{flow['id']}/runs").json()["runs"][0]
    assert run["input_summary"] == "文字 6 字" and run["status"] == "ok" and run["output_text"] == ""
    assert run["nodes"] == [{"node_id": "a1", "title": "文字输入", "node_type": "step", "status": "ok",
                             "summary": "收到 6 字", "preview": "桂花", "ms": 3}]
    old = dt.datetime.fromisoformat(run["started_at"])
    assert run["ms"] is not None and old.tzinfo is not None
