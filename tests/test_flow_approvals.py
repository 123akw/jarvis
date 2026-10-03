"""第二十轮「发送前确认」（契约 §3.1）：确认节点的校验与规整、跑到它时停下（运行记录 waiting、node_wait、
通知带绝对链接、闸已释放）、同意（改内容后下游用改后的内容，沿用同一运行记录、来源沿用原来的、跑完通知）、
拒绝、过期（惰性判定与定期清理）、只能处理自己的、已处理 409、恢复时账号忙就排队（以及等不到就放弃）、
连着两个确认、删流程连确认一起删、运行详情接口、无头运行返回 waiting / quota 与 source、用量钩子。"""
import contextvars
import json
import threading
import time
from contextlib import contextmanager
from types import SimpleNamespace

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import flows, usage
from jarvis.accounts import AccountStore
from jarvis.flows import approvals, engine
from jarvis.flows.graph import GraphError, validate_graph
from jarvis.flows.store import FlowStore
from jarvis.tenancy import TenantStore

AI_TEXT = "## 明天团建通知\n- 早上 9 点公司门口集合\n- 带好水杯和防晒"


class Notifier:
    """delivery.Notifier 的替身：只有 send（没有 _prefs / _fanout 时按 send 送）。"""

    def __init__(self):
        self.sent: list[tuple[str, str]] = []

    def send(self, user_id, message, now, *, icon=""):
        self.sent.append((user_id, message))
        return True


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


@pytest.fixture()
def env(monkeypatch, owner_id):
    calls = {"check": [], "record": [], "kinds": [], "prompts": []}
    kind = contextvars.ContextVar("usage_kind", default="chat")

    @contextmanager
    def kind_scope(value):
        token = kind.set(value)
        try:
            yield
        finally:
            kind.reset(token)

    monkeypatch.setattr(usage, "check_flow_run", lambda uid: calls["check"].append(uid) or None)
    monkeypatch.setattr(usage, "record_flow_run", lambda uid, ok: calls["record"].append((uid, ok)))
    monkeypatch.setattr(usage, "kind_scope", kind_scope)

    def compose(user_id, prompt):
        calls["kinds"].append(kind.get())
        calls["prompts"].append(prompt)
        return AI_TEXT

    runtime = flows.runtime()
    monkeypatch.setattr(runtime, "deps", engine.FlowDeps(tenant_store=TenantStore, compose=compose))
    monkeypatch.setattr(runtime, "guard", engine.RunGuard())
    monkeypatch.setattr(runtime, "timeouts", {})
    notifier = Notifier()
    monkeypatch.setitem(approvals._STATE, "notifier", notifier)
    monkeypatch.setitem(approvals._STATE, "origin", "")
    monkeypatch.setattr(approvals, "submit", lambda fn, *a, **k: fn(*a, **k))   # 后台活同步跑，测试好断言
    monkeypatch.setenv("JARVIS_PUBLIC_URL", "https://jarvis.example")
    return SimpleNamespace(calls=calls, notifier=notifier, runtime=runtime)


def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _sse(response):
    return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def _e(source, target, handle=None):
    return {"source": source, "target": target, "sourceHandle": handle}


def _graph(**approval):
    """开始 → AI 写通知 → 发送前确认 → 加到待办 → 结束。"""
    return {"nodes": [
        {"id": "start", "type": "start", "data": {"fields": [
            {"key": "topic", "label": "主题", "type": "text", "default": "团建"}]}},
        {"id": "ai", "type": "llm", "data": {"title": "AI 写通知", "prompt": "写一段 {{start.topic}} 的通知"}},
        {"id": "ok", "type": "approval", "data": {"title": "发出去前看一眼", **approval}},
        {"id": "todo", "type": "step", "data": {"title": "加到待办", "step": "to_todo"}},
        {"id": "end", "type": "end", "data": {"output": "{{ok.text}}"}},
    ], "edges": [_e("start", "ai"), _e("ai", "ok"), _e("ok", "todo"), _e("todo", "end")]}


def _todos(owner_id):
    return [t["content"] for t in TenantStore().list_todos(owner_id=owner_id)]


def _pause(client, graph=None, name="团建通知"):
    flow = client.post("/api/flows", json={"name": name, "graph": graph or _graph()}).json()["flow"]
    with client.stream("POST", f"/api/flows/{flow['id']}/run", json={"inputs": {}}) as r:
        assert r.status_code == 200
        events = _sse(r)
    return flow, events


# ---------- 节点图里的确认节点 ----------

def test_approval_node_normalized_with_defaults_and_checked():
    graph = validate_graph(_graph())
    node = next(n for n in graph["nodes"] if n["id"] == "ok")
    assert node["data"] == {"title": "发出去前看一眼", "message": "", "editable": True, "timeout_hours": 24,
                            "notify": None}
    graph = validate_graph(_graph(message="请确认：{{ai.text}}", editable=False, timeout_hours="48",
                                  notify={"feishu": True, "desktop": False, "wechat": True}))
    data = next(n for n in graph["nodes"] if n["id"] == "ok")["data"]
    assert data["timeout_hours"] == 48 and data["editable"] is False and data["notify"] == {"feishu": True,
                                                                                             "desktop": False}
    for bad, message in [({"timeout_hours": 0}, "「等多久」要填 1–72 之间的整数小时"),
                         ({"timeout_hours": 100}, "1–72"), ({"timeout_hours": 1.5}, "整数小时"),
                         ({"notify": "feishu"}, "通知方式设置有误"), ({"notify": {"feishu": "yes"}}, "通知方式设置有误"),
                         ({"editable": "no"}, "「允许修改」只能是开或关"),
                         ({"message": "{{todo.text}}"}, "不在「发出去前看一眼」前面")]:
        with pytest.raises(GraphError) as caught:
            validate_graph(_graph(**bad))
        assert message in str(caught.value)


# ---------- 停下等确认 ----------

def test_run_pauses_at_approval_releases_guard_and_notifies(env, owner_id):
    owner = _client()
    flow, events = _pause(owner)
    kinds = [(e["type"], e.get("node_id")) for e in events]
    assert kinds == [("run_start", None), ("node_start", "start"), ("node_done", "start"), ("node_start", "ai"),
                     ("node_done", "ai"), ("node_start", "ok"), ("node_wait", "ok"), ("run_done", None)]
    wait, done = events[-2], events[-1]
    approval_id = wait["approval_id"]
    assert wait["url"] == f"https://jarvis.example/approve/{approval_id}" and wait["expires_at"]
    assert wait["config_hash"] == flow["config_hashes"]["ok"] and wait["summary"] == "等你确认"
    assert done["status"] == "waiting" and done["approval"] == {"id": approval_id, "url": wait["url"],
                                                                 "expires_at": wait["expires_at"]}
    assert "error" not in done and done["output"] == {"text": "", "links": [], "page_url": None}
    assert _todos(owner_id) == []                                   # 下游还没跑
    assert env.runtime.guard.acquire(owner_id)                      # 等待期间闸已释放
    env.runtime.guard.release(owner_id)
    assert env.calls["record"] == []                                # 还没到终态，不记运行次数
    # 通知：流程名、哪一步、要发的内容、绝对链接
    (user, text), = env.notifier.sent
    assert user == owner_id and text.startswith("✋ 「团建通知」有一步等你确认：发出去前看一眼")
    assert "早上 9 点公司门口集合" in text and f"去确认：https://jarvis.example/approve/{approval_id}（24 小时内有效）" in text
    # 运行记录、列表的 last_run、单次运行详情
    run = owner.get(f"/api/flows/{flow['id']}/runs").json()["runs"][0]
    assert run["status"] == "waiting" and run["finished_at"] is None and run["source"] == "manual"
    assert run["approval"] == {"id": approval_id, "url": f"/approve/{approval_id}", "expires_at": wait["expires_at"]}
    assert run["nodes"][-1]["node_id"] == "ok" and run["nodes"][-1]["status"] == "waiting"
    assert all("ctx" not in n for n in run["nodes"])                # 存下的产出不进接口
    detail = owner.get(f"/api/flows/{flow['id']}/runs/{run['id']}").json()["run"]
    assert detail == run
    last = owner.get("/api/flows").json()["flows"][0]["last_run"]
    assert last["status"] == "waiting" and last["approval"]["id"] == approval_id
    # 待确认列表与详情
    listed = owner.get("/api/approvals").json()
    assert listed["pending"] == 1
    item, = listed["approvals"]
    assert item == {"id": approval_id, "flow": {"id": flow["id"], "name": "团建通知"}, "run_id": run["id"],
                    "node_id": "ok", "title": "发出去前看一眼", "preview": item["preview"], "status": "pending",
                    "created_at": item["created_at"], "expires_at": wait["expires_at"], "decided_at": None,
                    "url": f"/approve/{approval_id}"}
    assert item["preview"].startswith("【明天团建通知】")
    approval = owner.get(f"/api/approvals/{approval_id}").json()["approval"]
    assert approval["content"] == AI_TEXT and approval["editable"] is True and approval["source"] == "manual"
    assert approval["next"] == [{"title": "加到待办", "node_type": "step"}, {"title": "结束", "node_type": "end"}]
    assert env.calls["kinds"] == ["flow"]                          # AI 节点的模型调用记在「流程」下


def test_approve_with_edits_resumes_downstream_with_edited_content(env, owner_id):
    owner = _client()
    flow, events = _pause(owner)
    approval_id, run_id = events[-1]["approval"]["id"], events[0]["run_id"]
    env.notifier.sent.clear()
    edited = "- 改成 10 点集合\n- 记得带伞"
    r = owner.post(f"/api/approvals/{approval_id}", json={"decision": "approve", "content": edited + "\r\n"})
    assert r.status_code == 200
    body = r.json()
    assert body["run"] == {"id": run_id, "status": "running"}
    assert body["approval"]["status"] == "approved" and body["approval"]["content"] == edited
    assert body["approval"]["edited"] is True
    assert _todos(owner_id) == ["改成 10 点集合", "记得带伞"]       # 下游用的是改后的内容
    run = owner.get(f"/api/flows/{flow['id']}/runs/{run_id}").json()["run"]
    assert run["status"] == "ok" and run["source"] == "manual" and run["finished_at"]   # 接着跑沿用原来源
    assert run["output_text"] == edited and "approval" not in run
    assert [(n["node_id"], n["status"]) for n in run["nodes"]] == [
        ("start", "ok"), ("ai", "ok"), ("ok", "ok"), ("todo", "ok"), ("end", "ok")]
    assert run["nodes"][2]["summary"] == "你改了内容后同意了"
    assert len(owner.get(f"/api/flows/{flow['id']}/runs").json()["runs"]) == 1   # 沿用同一条运行记录
    assert env.calls["record"] == [(owner_id, True)]
    (_user, text), = env.notifier.sent
    assert text.startswith("✅ 「团建通知」确认后接着跑完了") and "改成 10 点集合" in text
    again = owner.post(f"/api/approvals/{approval_id}", json={"decision": "reject"})
    assert again.status_code == 409 and again.json()["error"] == "这一步已经同意过了，流程在接着跑或已经跑完"
    assert owner.get("/api/approvals").json() == {"approvals": [], "pending": 0}
    everything = owner.get("/api/approvals?status=all").json()["approvals"]
    assert [a["status"] for a in everything] == ["approved"]


def test_approve_unchanged_and_not_editable_ignores_content(env, owner_id):
    owner = _client()
    _flow, events = _pause(owner, _graph(editable=False, message="请确认：{{ai.text}}"))
    approval_id = events[-1]["approval"]["id"]
    detail = owner.get(f"/api/approvals/{approval_id}").json()["approval"]
    assert detail["editable"] is False and detail["content"] == "请确认：" + AI_TEXT
    r = owner.post(f"/api/approvals/{approval_id}", json={"decision": "approve", "content": "- 偷偷改掉"})
    assert r.status_code == 200 and r.json()["approval"]["edited"] is False
    assert _todos(owner_id) == ["早上 9 点公司门口集合", "带好水杯和防晒"]


def test_reject_stops_the_run(env, owner_id):
    owner = _client()
    flow, events = _pause(owner)
    approval_id, run_id = events[-1]["approval"]["id"], events[0]["run_id"]
    assert owner.post(f"/api/approvals/{approval_id}", json={"decision": "maybe"}).json() == {
        "error": "只能选「同意」或「拒绝」"}
    r = owner.post(f"/api/approvals/{approval_id}", json={"decision": "reject", "note": "  先不发了 "})
    assert r.status_code == 200 and r.json()["run"] == {"id": run_id, "status": "rejected"}
    assert r.json()["approval"]["status"] == "rejected" and r.json()["approval"]["note"] == "先不发了"
    run = owner.get(f"/api/flows/{flow['id']}/runs/{run_id}").json()["run"]
    assert run["status"] == "rejected" and run["error"] == "你拒绝了这一步：先不发了" and run["finished_at"]
    assert run["nodes"][-1]["status"] == "rejected" and run["nodes"][-1]["summary"] == "你拒绝了"
    assert _todos(owner_id) == []
    assert env.calls["record"] == [(owner_id, True)]
    again = owner.post(f"/api/approvals/{approval_id}", json={"decision": "approve"})
    assert again.status_code == 409 and again.json()["error"] == "这一步已经拒绝过了，流程已停止"
    assert owner.get("/api/flows").json()["flows"][0]["last_run"]["status"] == "rejected"


def test_empty_content_and_long_note_rejected_humanly(env, owner_id):
    owner = _client()
    _flow, events = _pause(owner)
    approval_id = events[-1]["approval"]["id"]
    r = owner.post(f"/api/approvals/{approval_id}", json={"decision": "approve", "content": "  \n "})
    assert r.status_code == 400 and r.json()["error"] == "要发出去的内容是空的：填一点再同意，或者直接拒绝"
    r = owner.post(f"/api/approvals/{approval_id}", json={"decision": "reject", "note": "长" * 201})
    assert r.status_code == 400 and "最多 200 个字" in r.json()["error"]
    no_csrf = TestClient(server_mod.app)
    no_csrf.post("/api/login", json={"username": "admin", "password": "admin"})
    assert no_csrf.post(f"/api/approvals/{approval_id}", json={"decision": "approve"}).status_code == 403
    assert owner.get("/api/approvals").json()["pending"] == 1


def _expire_all():
    with FlowStore()._connect() as c:
        c.execute("UPDATE tenant_flow_approvals SET expires_at='2000-01-01T00:00:00+00:00' WHERE status='pending'")


def test_expired_lazily_on_read_and_by_sweeper(env, owner_id):
    owner = _client()
    flow, events = _pause(owner)
    approval_id, run_id = events[-1]["approval"]["id"], events[0]["run_id"]
    _expire_all()
    assert owner.get("/api/approvals").json() == {"approvals": [], "pending": 0}   # 读取时惰性判定
    run = owner.get(f"/api/flows/{flow['id']}/runs/{run_id}").json()["run"]
    assert run["status"] == "expired" and run["error"] == "超过 24 小时没人确认，流程已停止"
    assert run["nodes"][-1]["status"] == "expired"
    r = owner.post(f"/api/approvals/{approval_id}", json={"decision": "approve"})
    assert r.status_code == 409 and r.json()["error"] == "这一步已经过期了，流程已停止；需要的话到流程页重新跑一次"
    assert r.json()["approval"]["status"] == "expired"
    assert env.calls["record"] == [(owner_id, False)]
    # 后台定期清理：跨账号清掉并通知
    _flow2, events2 = _pause(owner, name="周报")
    env.notifier.sent.clear()
    _expire_all()
    cleared = approvals.ApprovalSweeper(flows.runtime).scan_once()
    assert [row["id"] for row in cleared] == [events2[-1]["approval"]["id"]]
    (_user, text), = env.notifier.sent
    assert text.startswith("⌛ 「周报」等你确认的那一步超过 24 小时没人确认，流程已停止")
    assert approvals.ApprovalSweeper(flows.runtime).scan_once() == []


def test_only_the_owner_sees_and_decides(env, owner_id):
    owner = _client()
    _flow, events = _pause(owner)
    approval_id = events[-1]["approval"]["id"]
    AccountStore().create_user("member", "Member-pass-123", "Member")
    member = _client("member", "Member-pass-123")
    assert member.get("/api/approvals").json() == {"approvals": [], "pending": 0}
    assert member.get(f"/api/approvals/{approval_id}").status_code == 404
    r = member.post(f"/api/approvals/{approval_id}", json={"decision": "approve"})
    assert r.status_code == 404 and r.json()["error"] == "没有找到这条确认，可能流程已经被删掉了"
    assert TestClient(server_mod.app).get("/api/approvals").status_code == 401
    assert owner.get("/api/approvals").json()["pending"] == 1


def test_resume_queues_while_account_is_busy(env, owner_id, monkeypatch):
    owner = _client()
    flow, events = _pause(owner)
    approval_id, run_id = events[-1]["approval"]["id"], events[0]["run_id"]
    threads: list[threading.Thread] = []

    def background(fn, *a, **k):
        thread = threading.Thread(target=fn, args=a, kwargs=k)
        threads.append(thread)
        thread.start()

    monkeypatch.setattr(approvals, "submit", background)
    monkeypatch.setattr(approvals, "BUSY_POLL_SECONDS", 0.01)
    assert env.runtime.guard.acquire(owner_id)   # 账号正在跑别的流程
    r = owner.post(f"/api/approvals/{approval_id}", json={"decision": "approve"})
    assert r.json()["run"]["status"] == "running"
    time.sleep(0.15)
    run = owner.get(f"/api/flows/{flow['id']}/runs/{run_id}").json()["run"]
    assert run["status"] == "running" and run["source"] == "manual" and _todos(owner_id) == []   # 在排队
    env.runtime.guard.release(owner_id)
    while threads:
        threads.pop(0).join(5)
    assert _todos(owner_id) == ["早上 9 点公司门口集合", "带好水杯和防晒"]
    assert owner.get(f"/api/flows/{flow['id']}/runs/{run_id}").json()["run"]["status"] == "ok"
    assert env.runtime.guard.acquire(owner_id)   # 跑完闸又放了
    env.runtime.guard.release(owner_id)


def test_resume_gives_up_after_waiting_too_long(env, owner_id, monkeypatch):
    owner = _client()
    flow, events = _pause(owner)
    approval_id, run_id = events[-1]["approval"]["id"], events[0]["run_id"]
    monkeypatch.setattr(approvals, "BUSY_POLL_SECONDS", 0.01)
    monkeypatch.setattr(approvals, "BUSY_WAIT_SECONDS", 0.05)
    env.notifier.sent.clear()
    assert env.runtime.guard.acquire(owner_id)
    owner.post(f"/api/approvals/{approval_id}", json={"decision": "approve"})
    env.runtime.guard.release(owner_id)
    run = owner.get(f"/api/flows/{flow['id']}/runs/{run_id}").json()["run"]
    assert run["status"] == "error" and run["error"] == approvals.BUSY_GAVE_UP and _todos(owner_id) == []
    (_user, text), = env.notifier.sent
    assert text.startswith("⚠️ 「团建通知」确认后接着跑，但没跑通：等了 5 分钟")


def test_two_approvals_in_a_row(env, owner_id):
    graph = _graph()
    graph["nodes"].insert(3, {"id": "ok2", "type": "approval", "data": {"title": "再确认一次", "timeout_hours": 2}})
    graph["edges"] = [_e("start", "ai"), _e("ai", "ok"), _e("ok", "ok2"), _e("ok2", "todo"), _e("todo", "end")]
    owner = _client()
    flow, events = _pause(owner, graph)
    first = events[-1]["approval"]["id"]
    owner.post(f"/api/approvals/{first}", json={"decision": "approve", "content": "- 第一次改的"})
    run = owner.get(f"/api/flows/{flow['id']}/runs").json()["runs"][0]
    assert run["status"] == "waiting" and run["approval"]["id"] != first and _todos(owner_id) == []
    second = owner.get(f"/api/approvals/{run['approval']['id']}").json()["approval"]
    assert second["content"] == "- 第一次改的" and second["title"] == "再确认一次"
    assert second["source"] == "manual" and second["next"][0]["title"] == "加到待办"
    owner.post(f"/api/approvals/{second['id']}", json={"decision": "approve"})
    assert _todos(owner_id) == ["第一次改的"]
    run = owner.get(f"/api/flows/{flow['id']}/runs").json()["runs"][0]
    assert run["status"] == "ok" and [n["node_id"] for n in run["nodes"]] == ["start", "ai", "ok", "ok2", "todo", "end"]


def test_deleting_flow_removes_its_approvals(env, owner_id):
    owner = _client()
    flow, events = _pause(owner)
    approval_id = events[-1]["approval"]["id"]
    assert owner.delete(f"/api/flows/{flow['id']}").json() == {"ok": True}
    assert owner.get(f"/api/approvals/{approval_id}").status_code == 404
    assert owner.get("/api/approvals").json()["pending"] == 0


def test_waiting_runs_are_not_trimmed(env, owner_id, monkeypatch):
    from jarvis.flows import store as store_mod
    monkeypatch.setattr(store_mod, "KEEP_RUNS", 2)
    owner = _client()
    flow, events = _pause(owner)
    store = FlowStore()
    others = [store.start_run(owner_id, flow["id"], {}) for _ in range(3)]
    assert store.run_record(owner_id, events[0]["run_id"])["status"] == "waiting"   # 等确认的留着
    assert store.run_record(owner_id, others[0]) is None                             # 其他的照常只留最近几次


# ---------- 无头运行：source / waiting / quota ----------

def test_run_headless_returns_waiting_with_source_and_quota(env, owner_id, monkeypatch):
    graph = validate_graph(_graph())
    flow = FlowStore().create_flow(owner_id, name="团建通知", summary="", graph=graph)
    done = env.runtime.run_headless(owner_id, flow["id"], {}, source="chat")
    assert done["status"] == "waiting" and done["output"] is None and done["error"] == ""
    assert set(done["approval"]) == {"id", "url", "expires_at"}
    assert done["approval"]["url"] == f"https://jarvis.example/approve/{done['approval']['id']}"
    run = FlowStore().list_runs(owner_id, flow["id"])[0]
    assert run["id"] == done["run_id"] and run["source"] == "chat" and run["status"] == "waiting"
    assert env.calls["check"] == [owner_id]
    # 没配 JARVIS_PUBLIC_URL：用请求来源（最近一次请求）兜底；也没有就给站内路径
    monkeypatch.delenv("JARVIS_PUBLIC_URL")
    assert env.runtime.run_headless(owner_id, flow["id"], {}, source="message",
                                    origin="https://a.example")["approval"]["url"].startswith("https://a.example/approve/")
    assert env.runtime.run_headless(owner_id, flow["id"], {})["approval"]["url"].startswith("/approve/")
    assert FlowStore().list_runs(owner_id, flow["id"])[0]["source"] == "schedule"   # 默认 schedule
    monkeypatch.setattr(usage, "check_flow_run", lambda uid: "今天的流程运行次数到上限了，明天再来，或请管理员调高")
    blocked = env.runtime.run_headless(owner_id, flow["id"], {}, source="webhook")
    assert blocked == {"status": "quota", "run_id": None, "output": None,
                       "error": "今天的流程运行次数到上限了，明天再来，或请管理员调高"}
    owner = _client()
    r = owner.post(f"/api/flows/{flow['id']}/run", json={"inputs": {}})
    assert r.status_code == 429 and r.json() == {"error": "今天的流程运行次数到上限了，明天再来，或请管理员调高"}


def test_usage_recorded_once_per_finished_run(env, owner_id):
    graph = validate_graph({"nodes": [
        {"id": "start", "type": "start", "data": {"fields": []}},
        {"id": "ai", "type": "llm", "data": {"prompt": "写点什么"}},
        {"id": "end", "type": "end", "data": {}}], "edges": [_e("start", "ai"), _e("ai", "end")]})
    flow = FlowStore().create_flow(owner_id, name="随便", summary="", graph=graph)
    assert env.runtime.run_headless(owner_id, flow["id"], {}, source="chat")["status"] == "ok"
    env.runtime.deps = engine.FlowDeps(tenant_store=TenantStore, compose=None)
    assert env.runtime.run_headless(owner_id, flow["id"], {})["status"] == "error"
    assert env.calls["record"] == [(owner_id, True), (owner_id, False)]
    assert env.calls["kinds"] == ["flow"]
