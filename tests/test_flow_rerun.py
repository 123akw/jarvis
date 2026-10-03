"""第二十轮「重跑」与「文件输入接受文件空间里已有的文件」（契约 §2 / §3.3）：开始节点的文件字段接受 ``{file_id}``
与含「file_id=XXX」的附件标记（按当前账号取、不重复存、别人的取不到）；运行记录的 input 里文件存 ``{file_id, name}``；
``/runs/{run_id}/rerun`` 用那次的输入再跑（SSE，source=rerun）；旧记录 / 没存下原文件的说人话；单次运行详情。"""
import base64
import json

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import files, flows, usage
from jarvis.accounts import AccountStore
from jarvis.flows import engine
from jarvis.flows.store import FlowStore
from jarvis.tenancy import TenantStore

CSV = "部门,金额\n销售部,100\n市场部,80\n".encode()


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


@pytest.fixture()
def fake(monkeypatch, owner_id):
    prompts: list[str] = []

    def compose(user_id, prompt):
        prompts.append(prompt)
        return "AI：看完了"

    runtime = flows.runtime()
    monkeypatch.setattr(runtime, "deps", engine.FlowDeps(tenant_store=TenantStore, compose=compose))
    monkeypatch.setattr(runtime, "guard", engine.RunGuard())
    monkeypatch.setattr(runtime, "timeouts", {})
    monkeypatch.setattr(usage, "check_flow_run", lambda uid: None)
    return prompts


def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _sse(response):
    return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def _e(source, target):
    return {"source": source, "target": target, "sourceHandle": None}


GRAPH = {"nodes": [
    {"id": "start", "type": "start", "data": {"fields": [
        {"key": "note", "label": "说明", "type": "text"},
        {"key": "report", "label": "报表", "type": "file", "required": True}]}},
    {"id": "ai", "type": "llm", "data": {"title": "看报表", "prompt": "{{start.note}}：{{start.report}}"}},
    {"id": "end", "type": "end", "data": {"output": "{{ai.text}}\n{{start.report_file}}"}},
], "edges": [_e("start", "ai"), _e("ai", "end")]}


def _run(client, flow_id, inputs):
    with client.stream("POST", f"/api/flows/{flow_id}/run", json={"inputs": inputs}) as r:
        if r.status_code != 200:
            return r.status_code, json.loads(r.read())
        return 200, _sse(r)


def _record(owner_id, run_id):
    return FlowStore().run_record(owner_id, run_id)


def test_file_input_accepts_file_space_reference_without_copying(fake, owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "看报表", "graph": GRAPH}).json()["flow"]
    meta = files.save(owner_id, "九月.csv", CSV, source="chat")
    status, events = _run(owner, flow["id"], {"note": "汇总", "report": {"file_id": meta["id"]}})
    assert status == 200 and events[-1]["status"] == "ok"
    assert "销售部" in fake[-1] and "汇总" in fake[-1]                       # 读出的文字进了模型
    assert f"file_id={meta['id']}" in events[-1]["output"]["text"]          # 原文件变量就是那份文件
    assert [m["id"] for m in files.list(owner_id)] == [meta["id"]]          # 没有另存一份
    run_id = events[0]["run_id"]
    assert _record(owner_id, run_id)["input"]["values"] == {"note": "汇总",
                                                            "report": {"file_id": meta["id"], "name": "九月.csv"}}
    run = owner.get(f"/api/flows/{flow['id']}/runs/{run_id}").json()["run"]
    assert run["input_summary"] == "说明：汇总 · 报表：九月.csv" and run["rerunnable"] is True
    assert run["nodes"][0]["files"] == [{"name": "九月.csv", "url": f"/api/files/{meta['id']}", "label": "报表"}]
    # 对话附件的标记文字也认
    status, events = _run(owner, flow["id"], {"report": f"帮我看看［附件：九月.csv · file_id={meta['id']}］"})
    assert status == 200 and events[-1]["status"] == "ok" and len(files.list(owner_id)) == 1
    # 找不到 / 别人的文件：人话
    status, body = _run(owner, flow["id"], {"report": {"file_id": "nosuchfile123"}})
    assert status == 422 and body == {"error": "「报表」用的文件找不到了（可能已经过期被清理），请重新上传"}
    member = AccountStore().create_user("member", "Member-pass-123", "Member")["id"]
    other = files.save(member, "别人的.csv", CSV)
    status, body = _run(owner, flow["id"], {"report": {"file_id": other["id"]}})
    assert status == 422 and "找不到了" in body["error"]


def test_run_headless_accepts_attachment_marker(fake, owner_id):
    from jarvis.flows.graph import validate_graph
    flow = FlowStore().create_flow(owner_id, name="看报表", summary="", graph=validate_graph(GRAPH))
    meta = files.save(owner_id, "九月.csv", CSV, source="chat")
    done = flows.runtime().run_headless(owner_id, flow["id"], {"report": files.attachment_marker(meta)},
                                        source="message")
    assert done["status"] == "ok" and "销售部" in fake[-1]
    run = FlowStore().list_runs(owner_id, flow["id"])[0]
    assert run["source"] == "message" and run["input_summary"] == "报表：九月.csv"


def test_rerun_uses_saved_inputs_and_file_ids(fake, owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "看报表", "graph": GRAPH}).json()["flow"]
    upload = {"name": "十月.csv", "data_base64": base64.b64encode(CSV).decode()}
    status, events = _run(owner, flow["id"], {"note": "按部门", "report": upload})
    assert status == 200 and events[-1]["status"] == "ok"
    first = events[0]["run_id"]
    kept, = files.list(owner_id)
    assert _record(owner_id, first)["input"]["values"]["report"] == {"file_id": kept["id"], "name": "十月.csv"}
    prompt = fake[-1]
    with owner.stream("POST", f"/api/flows/{flow['id']}/runs/{first}/rerun") as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        events = _sse(r)
    assert events[-1]["status"] == "ok" and events[0]["run_id"] != first
    assert fake[-1] == prompt                                       # 同样的输入
    assert [m["id"] for m in files.list(owner_id)] == [kept["id"]]  # 文件按 id 取，没有再存一份
    runs = owner.get(f"/api/flows/{flow['id']}/runs").json()["runs"]
    assert [r["source"] for r in runs] == ["rerun", "manual"]
    assert _record(owner_id, events[0]["run_id"])["input"]["rerun_of"] == first
    # 重跑出来的这次也能再重跑
    with owner.stream("POST", f"/api/flows/{flow['id']}/runs/{runs[0]['id']}/rerun") as r:
        assert _sse(r)[-1]["status"] == "ok"


def test_rerun_errors_are_human(fake, owner_id, monkeypatch):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "看报表", "graph": GRAPH}).json()["flow"]
    url = f"/api/flows/{flow['id']}/runs/%s/rerun"
    assert owner.post(url % "nosuchrun").status_code == 404
    assert owner.post(url % "nosuchrun").json() == {"error": "没有找到这次运行，可能已经被清理了"}
    legacy = FlowStore().start_run(owner_id, flow["id"], {"summary": "旧的"})   # 第二十轮以前的记录：没存输入
    r = owner.post(url % legacy)
    assert r.status_code == 422 and r.json()["error"].startswith("这次运行是比较早的记录，没有保存输入")
    assert owner.get(f"/api/flows/{flow['id']}/runs/{legacy}").json()["run"]["rerunnable"] is False
    # 上传的不是办公文件、后面也没用到原文件：原文件没存下来，重跑要重新上传
    graph = json.loads(json.dumps(GRAPH))
    graph["nodes"][2]["data"]["output"] = "{{ai.text}}"
    plain = owner.post("/api/flows", json={"name": "看笔记", "graph": graph}).json()["flow"]
    status, events = _run(owner, plain["id"], {"report": {"name": "笔记.md",
                                                          "data_base64": base64.b64encode("# 标题\n内容".encode()).decode()}})
    assert status == 200 and files.list(owner_id) == []
    assert owner.get(f"/api/flows/{plain['id']}/runs/{events[0]['run_id']}").json()["run"]["rerunnable"] is False
    r = owner.post(f"/api/flows/{plain['id']}/runs/{events[0]['run_id']}/rerun")
    assert r.status_code == 422
    assert r.json()["error"] == "那次上传的「报表」没有存进文件空间，没法直接再跑：请在流程里重新上传后运行"
    # 别的流程的运行、配额、正忙
    assert owner.post(f"/api/flows/{flow['id']}/runs/{events[0]['run_id']}/rerun").status_code == 404
    status, events = _run(owner, flow["id"], {"report": {"name": "a.csv", "data_base64": base64.b64encode(CSV).decode()}})
    run_id = events[0]["run_id"]
    runtime = flows.runtime()
    assert runtime.guard.acquire(owner_id)
    assert owner.post(url % run_id).status_code == 409
    runtime.guard.release(owner_id)
    monkeypatch.setattr(usage, "check_flow_run", lambda uid: "今天的流程运行次数到上限了")
    r = owner.post(url % run_id)
    assert r.status_code == 429 and r.json() == {"error": "今天的流程运行次数到上限了"}
    no_csrf = TestClient(server_mod.app)
    no_csrf.post("/api/login", json={"username": "admin", "password": "admin"})
    assert no_csrf.post(url % run_id).status_code == 403


def test_run_detail_route(fake, owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "看报表", "graph": GRAPH}).json()["flow"]
    meta = files.save(owner_id, "九月.csv", CSV)
    status, events = _run(owner, flow["id"], {"report": {"file_id": meta["id"]}})
    run_id = events[0]["run_id"]
    detail = owner.get(f"/api/flows/{flow['id']}/runs/{run_id}")
    assert detail.status_code == 200 and detail.headers["cache-control"] == "no-store"
    assert detail.json()["run"] == owner.get(f"/api/flows/{flow['id']}/runs").json()["runs"][0]
    assert owner.get(f"/api/flows/{flow['id']}/runs/nosuchrun").status_code == 404
    assert owner.get(f"/api/flows/nosuchflow/runs/{run_id}").status_code == 404
    assert TestClient(server_mod.app).get(f"/api/flows/{flow['id']}/runs/{run_id}").status_code == 401
    AccountStore().create_user("member", "Member-pass-123", "Member")
    assert _client("member", "Member-pass-123").get(f"/api/flows/{flow['id']}/runs/{run_id}").status_code == 404
