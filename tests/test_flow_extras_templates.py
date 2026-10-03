"""第十八轮好用层·模板库：每个模板过校验、变量只引用上游、工具 / 技能 / 积木真实存在、排版整齐、
按账号标出可用性（智能体账号没装的插件也列出并说明原因）、接口要登录。"""
import pytest
from fastapi.testclient import TestClient

import jarvis.server as server_mod
from jarvis import platforms
from jarvis.accounts import AccountStore
from jarvis.flows import graph as graph_mod
from jarvis.flows import templates as T
from jarvis.flows.graph import validate_graph
from jarvis.plugins.loader import registry


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _tool_objects():
    from jarvis.tools import TOOLS
    return {t.name: t for t in [*TOOLS, *registry().pack_tools]}


def _schema(tool) -> dict:
    schema = tool.args_schema
    if isinstance(schema, dict):
        return schema
    if schema is not None and hasattr(schema, "model_json_schema"):
        return schema.model_json_schema()
    return {"properties": dict(tool.args)}


# 收集用例时只取 id（不碰注册表）；每条用例在自己的临时数据目录里再取完整模板
TEMPLATE_IDS = [t["id"] for t in T._builtin()] + [f"pro_{flow_id}" for _p, flow_id, *_rest in T._LEGACY]


def test_template_library_size_and_categories():
    TEMPLATES = T.all_templates()
    assert [t["id"] for t in TEMPLATES] == TEMPLATE_IDS
    ids = [t["id"] for t in TEMPLATES]
    assert len(ids) >= 12 and len(set(ids)) == len(ids)
    assert {t["category"] for t in TEMPLATES} == set(T.CATEGORY_IDS)
    assert [c["label"] for c in T.CATEGORIES] == ["办公", "学习", "内容创作", "店铺", "生活资讯"]
    for category in T.CATEGORY_IDS:
        assert sum(t["category"] == category for t in TEMPLATES) >= 2
    # 条件分支、并行分支、文本拼接、插件工具、技能、积木都有模板用到
    kinds = {n["type"] for t in TEMPLATES for n in t["graph"]["nodes"]}
    assert kinds == set(graph_mod.NODE_TYPES)
    assert sum(any(n["type"] == "condition" for n in t["graph"]["nodes"]) for t in TEMPLATES) >= 3


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_template_graph_is_valid_and_references_are_real(template_id):
    template = T.get_template(template_id)
    graph = template["graph"]
    clean = validate_graph(graph)
    T.check_refs(clean)
    assert template["name"] and template["summary"] and template["icon"]
    assert len(template["name"]) <= graph_mod.MAX_NAME
    tools = _tool_objects()
    entries = registry().entry_by_id
    flow_steps = T._steps()
    for node in graph["nodes"]:
        data = node["data"]
        assert data.get("title"), node
        if node["type"] == "tool":
            entry = entries[data["plugin"]]
            if entry.get("mcp"):   # MCP 工具名是发现来的：<插件>__<远端工具名>，远端名要在清单的 tool_labels 里
                prefix, remote = data["tool"].split("__", 1)
                assert prefix == data["plugin"]
                labels = registry().by_id[data["plugin"]].manifest["extras"]["tool_labels"]
                assert remote in labels
                continue
            assert data["tool"] in entry["tools"], data
            schema = _schema(tools[data["tool"]])
            props = schema.get("properties") or {}
            assert set(data["args"]) <= set(props), (data["tool"], data["args"])
            assert set(schema.get("required") or []) <= set(data["args"]), data["tool"]
        elif node["type"] == "llm":
            assert data["prompt"]
            if data.get("skill"):
                pack = registry().by_id[data["skill"]]
                assert pack.status == "ok" and pack.skill, data["skill"]
        elif node["type"] == "step":
            spec = flow_steps.STEPS[data["step"]]
            assert spec.role != flow_steps.ROLE_INPUT
            assert set(data["options"]) <= {o["key"] for o in spec.options}
        elif node["type"] == "condition":
            assert data["cases"]
    assert template["plugins"] == T.graph_plugins(graph)
    for pid in template["plugins"]:
        assert pid in entries, pid


@pytest.mark.parametrize("template_id", TEMPLATE_IDS)
def test_template_layout_is_layered_left_to_right(template_id):
    template = T.get_template(template_id)
    graph = template["graph"]
    by_id = {n["id"]: n for n in graph["nodes"]}
    assert by_id["start"]["position"] == {"x": 0.0, "y": 0.0}
    for e in graph["edges"]:   # 连线一律从左往右
        assert by_id[e["target"]]["position"]["x"] - by_id[e["source"]]["position"]["x"] >= T.DX
    spots = [(n["position"]["x"], n["position"]["y"]) for n in graph["nodes"]]
    assert len(set(spots)) == len(spots)   # 不叠在一起
    for x in {s[0] for s in spots}:
        ys = sorted(s[1] for s in spots if s[0] == x)
        assert all(b - a >= T.DY for a, b in zip(ys, ys[1:]))


def test_layout_aligns_branches_and_parallel_nodes():
    graph = {"nodes": [{"id": "start", "type": "start", "data": {}}, {"id": "c", "type": "condition",
                       "data": {"cases": [{"id": "yes"}]}}, {"id": "a", "type": "llm", "data": {}},
                       {"id": "b", "type": "llm", "data": {}}, {"id": "a2", "type": "end", "data": {}}],
             "edges": [{"source": "start", "target": "c"}, {"source": "c", "target": "b", "sourceHandle": "else"},
                       {"source": "c", "target": "a", "sourceHandle": "yes"}, {"source": "a", "target": "a2"}]}
    T.layout(graph)
    pos = {n["id"]: n["position"] for n in graph["nodes"]}
    assert (T.DX, T.DY) == (320.0, 128.0)   # 与画布「整理」同一套参数
    assert pos["a"] == {"x": 640.0, "y": -64.0} and pos["b"] == {"x": 640.0, "y": 64.0}   # 第一个分支在上
    assert pos["a2"] == {"x": 960.0, "y": -64.0}   # 单线延续时和上游对齐


def test_needs_are_human_readable():
    TEMPLATES = T.all_templates()
    by_id = {t["id"]: t for t in TEMPLATES}
    assert "需要绑定飞书" in by_id["morning_brief"]["needs"]
    assert by_id["morning_brief"]["suggest_trigger"] == {"repeat": "daily", "time": "07:30"}
    assert any("高德地图" in n and "Key" in n for n in by_id["trip_plan"]["needs"])
    assert by_id["essay_review"]["needs"] == []
    for t in TEMPLATES:
        for need in t["needs"]:
            assert "_" not in need and "{{" not in need


def test_legacy_profession_flows_are_converted():
    by_id = {t["id"]: t for t in T.all_templates()}
    archive = by_id["pro_project_archive"]
    assert [n["data"]["title"] for n in archive["graph"]["nodes"]][1:3] == ["文件拆分", "AI 提炼"]
    assert archive["graph"]["nodes"][0]["data"]["fields"][0]["type"] == "file"


def test_templates_for_marks_agent_missing_plugins(owner_id):
    payload = T.templates_for(owner_id)
    assert [c["id"] for c in payload["categories"]] == list(T.CATEGORY_IDS)
    essay = next(t for t in payload["templates"] if t["id"] == "essay_review")
    assert essay["available"] is True and essay["plugin_details"][0]["name"] == "作文批改"
    brief = next(t for t in payload["templates"] if t["id"] == "morning_brief")
    feishu = next(d for d in brief["plugin_details"] if d["id"] == "feishu_send")
    assert feishu["available"] is False and "绑定飞书" in feishu["reason"]   # 测试环境没绑定飞书
    member = AccountStore().create_user("member", "member", "Member")
    fields = platforms.clean_platform({"name": "小林奶茶", "icon": "🧋", "accent": "#FF9F0A",
                                       "profession": "shop_owner", "plugins": ["weather", "essay_review"]})
    platforms.PlatformStore().create(member["id"], fields)
    agent = T.templates_for(member["id"])
    essay = next(t for t in agent["templates"] if t["id"] == "essay_review")
    assert essay["available"] is True
    brief = next(t for t in agent["templates"] if t["id"] == "morning_brief")
    schedule = next(d for d in brief["plugin_details"] if d["id"] == "schedule")
    assert schedule["available"] is False
    assert schedule["reason"] == "这个智能体还没装「日程提醒」，到智能体设置里加上就能用"
    assert next(d for d in brief["plugin_details"] if d["id"] == "weather")["available"] is True


def test_http_templates_requires_login_and_is_not_a_flow_id():
    anonymous = TestClient(server_mod.app)
    assert anonymous.get("/api/flows/templates").status_code == 401
    owner = _client()
    response = owner.get("/api/flows/templates")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    body = response.json()
    assert len(body["templates"]) >= 12 and body["categories"][0] == {"id": "office", "label": "办公"}
    first = body["templates"][0]
    assert set(first) >= {"id", "name", "summary", "category", "icon", "plugins", "graph", "needs"}
