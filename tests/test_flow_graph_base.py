"""第十八轮地基：tenant schema v7 升级路径 + 节点图结构校验 + 旧线性流程换算。"""
import pytest
from jarvis.accounts import AccountStore
from jarvis.flows.graph import GraphError, graph_from_steps, validate_graph
from jarvis.tenancy import TenantStore, tenant_scope


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


def test_v6_database_upgrades_to_v7_keeping_flows(owner_id):
    store = TenantStore()
    with tenant_scope(owner_id):
        store.add_todo("先把库建到最新")
    with store._connect() as c:   # 造一个只到 v6 的旧库：流程表回到 v6 结构、去掉触发器表与 v7 记录
        c.execute("DROP TABLE tenant_flow_triggers")
        c.execute("DROP TABLE tenant_flows")
        c.execute(TenantStore._schema_v6_statements()[0])
        c.execute("INSERT INTO tenant_flows(owner_id, id, name, summary, steps, created_at, updated_at) "
                  "VALUES (?, 'old1', '旧流程', '', '[{\"plugin\": \"input_text\"}]', 'x', 'x')", (owner_id,))
        c.execute("DELETE FROM tenant_schema_migrations WHERE version=7")
        c.commit()
    TenantStore.reset_migration_cache()   # 模拟新进程首连旧库
    with tenant_scope(owner_id):
        assert [t["content"] for t in store.list_todos()] == ["先把库建到最新"]
    with store._connect() as c:
        assert c.execute("SELECT 1 FROM tenant_schema_migrations WHERE version=7").fetchone()
        cols = {r[1] for r in c.execute("PRAGMA table_info(tenant_flows)")}
        assert "graph" in cols
        row = c.execute("SELECT name, graph FROM tenant_flows WHERE id='old1'").fetchone()
        assert tuple(row) == ("旧流程", "")
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "tenant_flow_triggers" in tables


def _g(nodes, edges):
    return {"nodes": nodes, "edges": edges}


START = {"id": "start", "type": "start", "data": {"fields": [{"key": "text", "label": "文字", "type": "paragraph"}]}}
END = {"id": "end", "type": "end", "data": {"output": "{{n1.text}}"}}
LLM = {"id": "n1", "type": "llm", "data": {"prompt": "总结 {{start.text}}"}}


def test_validate_graph_accepts_simple_chain_and_fills_defaults():
    g = validate_graph(_g([START, LLM, END], [{"source": "start", "target": "n1"}, {"source": "n1", "target": "end"}]))
    assert [n["id"] for n in g["nodes"]] == ["start", "n1", "end"]
    assert g["nodes"][1]["position"] == {"x": 0.0, "y": 0.0}
    assert g["edges"][0]["sourceHandle"] is None and g["edges"][0]["id"] == "e0"


@pytest.mark.parametrize("graph, message", [
    (_g([LLM, END], []), "开始"),
    (_g([START, LLM], [{"source": "start", "target": "n1"}]), "结束"),
    (_g([START, LLM, END], [{"source": "start", "target": "x"}]), "没接好"),
    (_g([START, LLM, END], [{"source": "n1", "target": "n1"}]), "自己"),
    (_g([START, LLM, {**LLM, "id": "n2"}, END], [{"source": "n1", "target": "n2"}, {"source": "n2", "target": "n1"}]), "环"),
    (_g([START, {**LLM, "data": {"prompt": "{{ghost.text}}"}}, END], []), "已经删掉的节点"),
    (_g([START, {**LLM, "type": "python"}, END], []), "不认识"),
    (_g([START, START, END], []), "刷新页面"),
])
def test_validate_graph_rejects_with_human_messages(graph, message):
    with pytest.raises(GraphError) as err:
        validate_graph(graph)
    assert message in str(err.value)


def test_graph_from_legacy_steps():
    g = graph_from_steps([{"id": "a", "plugin": "input_file"}, {"id": "b", "plugin": "split_file", "options": {"mode": "chapter"}},
                          {"id": "c", "plugin": "ai_extract", "options": {"task": "要点"}}, {"id": "d", "plugin": "web_page"}])
    validate_graph(g)
    assert g["nodes"][0]["data"]["fields"][0]["type"] == "file"
    assert [n["id"] for n in g["nodes"]] == ["start", "b", "c", "d", "end"]
    assert [(e["source"], e["target"]) for e in g["edges"]] == [("start", "b"), ("b", "c"), ("c", "d"), ("d", "end")]
    assert g["nodes"][-1]["data"]["output"] == "{{d.text}}"


def test_flow_canvas_path_serves_spa():
    from fastapi.testclient import TestClient
    import jarvis.server as server_mod
    with TestClient(server_mod.app) as client:
        for path in ("/flows", "/flows/abc123", "/flows/new", "/admin", "/approve/abc12345"):
            r = client.get(path)
            assert r.status_code == 200 and "<div id=\"root\">" in r.text, path


def test_v7_database_upgrades_to_v8_keeping_runs(owner_id):
    """第二十轮：运行记录表重建（多出 waiting 等状态与 source 列），旧运行原样保留；新表齐全。"""
    store = TenantStore()
    with tenant_scope(owner_id):
        store.add_todo("先把库建到最新")
    with store._connect() as c:   # 造一个只到 v7 的旧库：运行表回到 v6 结构并带一条旧记录，去掉 v8 的新表与记录
        c.execute("DROP TABLE tenant_flow_runs")
        c.execute(TenantStore._schema_v6_statements()[1])
        c.execute("INSERT INTO tenant_flow_runs(id, owner_id, flow_id, status, started_at) VALUES ('r1', ?, 'f1', 'ok', 'x')", (owner_id,))
        for t in ("tenant_flow_hooks", "tenant_flow_approvals", "usage_daily", "tenant_quotas", "admin_alerts"):
            c.execute(f"DROP TABLE {t}")
        c.execute("DELETE FROM tenant_schema_migrations WHERE version=8")
        c.commit()
    TenantStore.reset_migration_cache()
    with tenant_scope(owner_id):
        assert [t["content"] for t in store.list_todos()] == ["先把库建到最新"]
    with store._connect() as c:
        assert c.execute("SELECT 1 FROM tenant_schema_migrations WHERE version=8").fetchone()
        row = c.execute("SELECT status, source FROM tenant_flow_runs WHERE id='r1'").fetchone()
        assert tuple(row) == ("ok", "manual")
        c.execute("INSERT INTO tenant_flow_runs(id, owner_id, flow_id, status, started_at, source) VALUES ('r2', ?, 'f1', 'waiting', 'x', 'chat')", (owner_id,))
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"tenant_flow_hooks", "tenant_flow_approvals", "usage_daily", "tenant_quotas", "admin_alerts"} <= tables
