"""第十三轮智能平台：插件 / 职业清单的结构与 id 完整性、按账号计算 available。"""
import pytest

from jarvis import meeting, plugins
from jarvis.accounts import AccountStore
from jarvis.tools import TOOLS

CONTRACT_PLUGIN_IDS = {
    "schedule": "tool", "todo": "tool", "memo": "tool", "memory": "tool", "weather": "tool", "search": "tool",
    "recall": "tool", "movies": "tool", "esports": "tool", "tickets": "tool", "meeting": "tool",
    "feishu": "channel", "wechat": "channel",
    "input_text": "step", "input_file": "step", "split_file": "step", "ai_extract": "step", "to_todo": "step",
    "feishu_send": "step", "feishu_doc": "step", "wechat_send": "step", "web_page": "step",
}
CONTRACT_PROFESSIONS = {"freelancer", "project_manager", "shop_owner", "sales", "teacher", "student", "creator", "office"}
PLUGIN_KEYS = {"id", "name", "icon", "category", "summary", "kind", "tools", "step", "requires", "tier", "price",
               "professions", "examples", "available"}
# 第十四轮插件包：目录项可以多带这些字段（来源、版本、加载状态）；pack 只出现在插件包提供的积木条目上
EXTRA_KEYS = {"version", "author", "homepage", "source", "status", "reason", "builtin", "pack",
              "mcp", "hosts", "permissions",   # 第十五轮：MCP 插件的徽标、联网主机与权限
              "license", "description", "privacy_url",   # 第十五轮：插件详情页
              "tool_info"}   # MCP 工具的中文说明（详情页「它能做什么」）


def test_plugin_ids_kinds_and_shape_match_the_contract():
    kinds = {p["id"]: p["kind"] for p in plugins.PLUGINS}
    assert {pid: kinds.get(pid) for pid in CONTRACT_PLUGIN_IDS} == CONTRACT_PLUGIN_IDS   # 只许加不许改
    categories = {c["id"] for c in plugins.CATEGORIES}
    assert categories == {"efficiency", "communication", "documents", "info", "life", "ai", "output"}
    for item in plugins.PLUGINS:
        assert PLUGIN_KEYS <= set(item) <= PLUGIN_KEYS | EXTRA_KEYS, item["id"]
        assert item["category"] in categories
        assert item["name"] and item["icon"] and item["summary"]
        assert item["examples"] or "pack" in item, item["id"]
        assert item["tier"] in ("free", "pro") and isinstance(item["price"], (int, float))
        assert item["price"] == (plugins.PRO_PRICE if item["tier"] == "pro" else 0)
        assert set(item["requires"]) <= set(plugins.REQUIREMENTS)
        assert set(item["professions"]) <= CONTRACT_PROFESSIONS
        if item["kind"] == "step":
            assert item["step"]["role"] in ("input", "process", "output")
            assert set(item["step"]) == {"role", "accepts", "produces", "options"}
            for option in item["step"]["options"]:
                assert option["type"] in ("select", "text", "number") and "default" in option
                if option["type"] == "select":
                    assert option["default"] in option["choices"]
        else:
            assert item["step"] is None                     # 技能与通道不当积木用


def test_tool_plugins_map_onto_real_registered_tools_and_skip_base_and_owner_tools():
    registered = {tool.name for tool in TOOLS}
    pack_tools = {tool.name for tool in plugins.pack_tools()}
    assert not registered & pack_tools                     # 插件包工具不和核心工具重名
    mapped = set()
    for item in plugins.PLUGINS:
        if item["status"] != "ok":
            continue
        assert set(item["tools"]) <= registered | pack_tools, item["id"]
        assert bool(item["tools"]) == (item["kind"] == "tool"), item["id"]
        mapped |= set(item["tools"]) & registered
    # 每个工具恰好归属一个去处：插件、基础能力或 Owner 专属
    assert mapped | set(plugins.BASE_TOOLS) | set(plugins.OWNER_TOOLS) == registered
    assert not mapped & (set(plugins.BASE_TOOLS) | set(plugins.OWNER_TOOLS))
    assert plugins.get_plugin("meeting")["requires"] == ["desktop"]
    assert plugins.get_plugin("wechat")["requires"] == ["wechat_owner"]
    assert plugins.get_plugin("feishu_send")["requires"] == ["feishu_bound"]


def test_professions_reference_known_plugins_and_valid_flow_templates():
    assert {p["id"] for p in plugins.PROFESSIONS} == CONTRACT_PROFESSIONS
    roles = {p["id"]: (p["step"] or {}).get("role") for p in plugins.PLUGINS}
    flow_ids = set()
    for job in plugins.PROFESSIONS:
        assert set(job) == {"id", "name", "icon", "summary", "plugins", "flows", "persona", "home"}
        assert job["plugins"] and all(plugins.is_plugin(pid) for pid in job["plugins"])
        assert job["persona"] and job["home"]["greeting"] and len(job["home"]["chips"]) == 3
        for flow in job["flows"]:
            assert flow["id"] not in flow_ids
            flow_ids.add(flow["id"])
            steps = flow["steps"]
            assert 2 <= len(steps) <= 8
            assert roles[steps[0]["plugin"]] == "input"
            assert any(roles[s["plugin"]] == "output" for s in steps)
            # 新开的账号没绑飞书、也不是 Owner：模板只用一定跑得通的积木，并以生成网页收尾
            assert steps[-1]["plugin"] == "web_page"
            assert not {s["plugin"] for s in steps} & {"feishu_send", "feishu_doc", "wechat_send"}
            for step in steps:
                spec = plugins.get_plugin(step["plugin"])["step"]
                known = {o["key"]: o for o in spec["options"]}
                for key, value in step["options"].items():
                    assert key in known, (flow["id"], key)
                    if known[key]["type"] == "select":
                        assert value in known[key]["choices"]


def test_calibrated_order_pricing_and_names():
    assert plugins.PROFESSIONS[0]["id"] == "shop_owner"
    assert {p["id"] for p in plugins.PLUGINS if p["tier"] == "pro"} == {"meeting", "feishu_doc", "wechat", "wechat_send"}
    assert plugins.get_plugin("recall")["name"] == "找回聊过的话"
    assert plugins.get_plugin("tickets")["name"] == "查票价与入口"
    assert plugins.OWNER_ONLY == {"wechat", "wechat_send"}
    assert not any(plugins.OWNER_ONLY & set(job["plugins"]) for job in plugins.PROFESSIONS)


def test_step_specs_come_from_the_flow_engine_when_present():
    try:
        from jarvis.flows import step_catalog
    except ImportError:
        pytest.skip("流程引擎不在：用兜底定义")
    specs = step_catalog()
    for item in plugins.PLUGINS:
        if item["kind"] == "step":
            assert item["step"] == specs[item["id"]]


def test_accent_presets_are_six_distinct_hex_colors():
    values = [a["value"] for a in plugins.ACCENTS]
    assert len(set(values)) == 6
    assert all(len(v) == 7 and v.startswith("#") and v == v.upper() for v in values)


def test_catalog_is_a_deep_copy():
    data = plugins.catalog()
    data["plugins"][0]["name"] = "改掉"
    data["professions"][0]["plugins"].append("x")
    assert plugins.catalog()["plugins"][0]["name"] != "改掉"
    assert "x" not in plugins.get_profession(data["professions"][0]["id"])["plugins"]


@pytest.fixture
def accounts():
    store = AccountStore()
    store._ensure_bootstrap()
    return store


def test_available_is_true_for_guests_and_computed_per_account(accounts, monkeypatch):
    # 游客：插件本身加载正常就可用（缺依赖的插件包对谁都不可用）
    assert all(p["available"] == (p["status"] == "ok") for p in plugins.catalog(None)["plugins"])
    assert all(p["available"] for p in plugins.catalog(None)["plugins"] if p["builtin"] and p["id"] in CONTRACT_PLUGIN_IDS)
    owner = accounts.unique_active_owner().user_id
    member = accounts.create_user("member1", "Member-pass-123", "Member")["id"]
    from jarvis.channels import feishu
    monkeypatch.setattr(feishu, "push_ready", lambda user_id: user_id == member)

    def usable(user_id):
        return {p["id"]: p["available"] for p in plugins.catalog(user_id)["plugins"]}

    as_member, as_owner = usable(member), usable(owner)
    assert as_member["wechat"] is False and as_member["wechat_send"] is False
    assert as_owner["wechat"] is True and as_owner["wechat_send"] is True
    assert as_member["feishu_send"] is True and as_owner["feishu_send"] is False
    assert as_member["meeting"] is False                       # 桌面端没来领过指令 = 不在线
    meeting.desktop_commands.drain(member)
    assert usable(member)["meeting"] is True
    assert as_member["schedule"] is True and as_member["feishu"] is True   # 没有前置条件的永远可用
    assert plugins.is_available("meeting", member) and not plugins.is_available("nope", member)


def test_desktop_online_expires_after_a_minute():
    clock = [100.0]
    outbox = meeting.CommandOutbox(clock=lambda: clock[0])
    assert outbox.online("u") is False
    outbox.drain("u")
    clock[0] += 59
    assert outbox.online("u") is True
    clock[0] += 2
    assert outbox.online("u") is False


def test_tools_for_ignores_unknown_ids():
    assert plugins.tools_for(["todo", "nope", "feishu"]) == {"todo_add", "todo_list", "todo_done"}
