"""第十四轮插件包：加载与校验、22 个插件迁移前后一致、隔离五条、积木注册、Agent 绑定、技能注入、设置命名空间。"""
import json
import os
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from jarvis import plugins
from jarvis.plugins import loader, manifest as mf, sandbox, settings as plugin_settings, skills
from jarvis.tenancy import tenant_scope

FIXTURES = Path(__file__).parent / "fixtures"
SNAPSHOT_KEYS = ("id", "name", "icon", "category", "summary", "kind", "tools", "step", "requires", "tier", "price",
                 "professions")
BANNED_IN_EXAMPLES = ("王姐", "刘哥", "奶茶", "火锅", "周杰伦", "迪士尼", "哪吒", "T1", "LPL", "杭州")


def _snapshot():
    return json.loads((FIXTURES / "plugin_catalog_r13.json").read_text(encoding="utf-8"))


def _install(tmp_path, name, *, record=None, as_id=None):
    """把夹具插件目录直接放进数据目录（绕过导入流程，测加载器本身）。"""
    src = FIXTURES / "plugins" / name
    plugin_id = as_id or mf.read(src, builtin=False)["id"]
    dest = tmp_path / "plugins" / plugin_id
    shutil.copytree(src, dest)
    if record is not None:
        state = loader.read_state(tmp_path / "plugins")
        state["installed"][plugin_id] = record
        loader.write_state(state, tmp_path / "plugins")
    loader.reload()
    return plugin_id


@pytest.fixture
def packs_dir(tmp_path, monkeypatch):
    """可写的内置插件目录：复制真实的内置插件，测试再往里加坏的 / 新的。"""
    target = tmp_path / "packs"
    shutil.copytree(loader.PACKAGE_DIR, target, ignore=shutil.ignore_patterns("__pycache__", "__init__.py"))
    monkeypatch.setattr(loader, "PACKS_DIR", target)
    yield target
    monkeypatch.undo()
    loader.reload()


def _pack(folder: Path, manifest: dict, code: str | None = None):
    folder.mkdir(parents=True)
    base = {"version": "1.0.0", "icon": "🧪", "category": "efficiency", "summary": "测试插件", "kind": "tool",
            "examples": ["试一下"], "author": "测试"}
    (folder / "plugin.json").write_text(json.dumps({**base, **manifest}, ensure_ascii=False), encoding="utf-8")
    if code is not None:
        (folder / "tools.py").write_text(code, encoding="utf-8")


# ---------- 迁移 ----------

def test_migrated_catalog_matches_round13_snapshot_in_order():
    current = [{key: item[key] for key in SNAPSHOT_KEYS} for item in plugins.PLUGINS if item["builtin"]][:22]
    assert current == _snapshot()
    for item in plugins.PLUGINS:
        if item["id"] in {row["id"] for row in _snapshot()}:
            assert item["status"] == "ok" and item["builtin"] is True and item["source"] == {"type": "builtin"}
            assert item["version"] == "1.0.0" and item["author"] == "JWS-Agent"


def test_every_builtin_pack_has_a_valid_manifest_matching_its_folder():
    folders = [p for p in loader.PACKAGE_DIR.iterdir() if p.is_dir() and (p / "plugin.json").exists()]
    assert len(folders) >= 22
    for folder in folders:
        manifest = mf.read(folder, builtin=True)
        assert manifest["id"] == folder.name
        if manifest["entry"] is None and manifest["kind"] == "step":
            assert manifest["steps"] == [manifest["id"]]


def test_builtin_examples_are_neutral():
    for item in plugins.PLUGINS:
        for example in item["examples"]:
            assert not any(word in example for word in BANNED_IN_EXAMPLES), (item["id"], example)


def test_market_catalog_api_keeps_shape_and_mapping():
    import jarvis.server as server_mod
    data = TestClient(server_mod.app).get("/api/market/catalog").json()
    assert set(data) >= {"categories", "plugins", "professions", "accents", "signup", "signup_allowed"}
    by_id = {p["id"]: p for p in data["plugins"]}
    for row in _snapshot():
        assert {key: by_id[row["id"]][key] for key in SNAPSHOT_KEYS} == row
        assert by_id[row["id"]]["available"] is True


def test_tools_for_and_owner_only_views_stay_live():
    assert plugins.tools_for(["todo", "nope"]) == {"todo_add", "todo_list", "todo_done"}
    assert plugins.OWNER_ONLY == {"wechat", "wechat_send"}
    assert "wechat" in plugins.OWNER_ONLY and len(plugins.PLUGINS) >= 22
    loader.set_enabled("todo", False)
    assert not plugins.is_plugin("todo") and plugins.tools_for(["todo"]) == set()
    assert "todo" not in plugins.plugin_ids()
    loader.set_enabled("todo", True)
    assert plugins.is_plugin("todo")


# ---------- 隔离 1：坏清单 / 导入报错 / 依赖缺失只影响自己 ----------

def test_broken_packs_only_disable_themselves(packs_dir):
    (packs_dir / "bad_json").mkdir()
    (packs_dir / "bad_json" / "plugin.json").write_text("{不是 json", encoding="utf-8")
    _pack(packs_dir / "bad_kind", {"id": "bad_kind", "name": "坏类型", "kind": "magic"})
    _pack(packs_dir / "boom", {"id": "boom", "name": "导入就炸", "entry": "tools.py", "tools": ["boom_go"]},
          "raise RuntimeError('import time explosion')\n")
    _pack(packs_dir / "needs_pkg", {"id": "needs_pkg", "name": "缺依赖", "entry": "tools.py", "tools": ["needs_go"],
                                     "python_packages": ["surely-not-installed-pkg>=1"]},
          "raise AssertionError('不该被导入')\n")
    _pack(packs_dir / "good_pack", {"id": "good_pack", "name": "好插件", "entry": "tools.py", "tools": ["good_go"]},
          "from langchain_core.tools import tool\n\n@tool\ndef good_go(text: str) -> str:\n"
          "    '''回一句'''\n    return 'ok:' + text\n\nTOOLS = [good_go]\n")
    current = loader.reload()
    rows = {row["id"]: row for row in current.management()}
    assert rows["bad_json"]["status"] == "unavailable" and "不是合法的 JSON" in rows["bad_json"]["reason"]
    assert rows["bad_kind"]["status"] == "unavailable" and "kind" in rows["bad_kind"]["reason"]
    assert rows["boom"]["status"] == "unavailable" and rows["boom"]["reason"] == "插件代码加载失败"
    assert "RuntimeError" in rows["boom"]["detail"]
    assert rows["needs_pkg"]["status"] == "unavailable"
    assert "surely-not-installed-pkg" in rows["needs_pkg"]["reason"]
    assert rows["good_pack"]["status"] == "ok"
    catalog = {p["id"]: p for p in plugins.catalog(None)["plugins"]}
    assert "bad_json" not in catalog                           # 清单坏到读不出 id：只在 Owner 的管理清单里
    assert catalog["boom"]["available"] is False and catalog["boom"]["status"] == "unavailable"
    assert catalog["good_pack"]["available"] is True
    assert all(catalog[row["id"]]["status"] == "ok" for row in _snapshot())   # 其他插件全都照常
    assert plugins.tools_for(["boom", "good_pack"]) == {"good_go"}


# ---------- 隔离 2：工具异常转人话、单次调用限时、带着租户上下文 ----------

def test_builtin_pack_tools_are_guarded(packs_dir, tmp_path):
    code = (
        "import time\nfrom langchain_core.tools import tool\nfrom jarvis.tenancy import current_owner_id\n\n"
        "@tool\ndef guard_fail() -> str:\n    '''出错'''\n    raise ValueError('secret detail')\n\n"
        "@tool\ndef guard_slow() -> str:\n    '''很慢'''\n    time.sleep(3)\n    return 'late'\n\n"
        "@tool\ndef guard_who() -> str:\n    '''当前账号'''\n    return current_owner_id()\n\n"
        "TOOLS = [guard_fail, guard_slow, guard_who]\n"
    )
    _pack(packs_dir / "guarded", {"id": "guarded", "name": "护栏", "entry": "tools.py", "timeout": 1,
                                   "tools": ["guard_fail", "guard_slow", "guard_who"]}, code)
    loader.reload()
    tools = {t.name: t for t in plugins.pack_tools()}
    failed = tools["guard_fail"].invoke({})
    assert "插件「护栏」这次没办成" in failed and "ValueError" in failed and "secret detail" not in failed
    started = time.monotonic()
    slow = tools["guard_slow"].invoke({})
    assert time.monotonic() - started < 2.5 and "超时" in slow
    with tenant_scope("owner-42"):
        assert tools["guard_who"].invoke({}) == "owner-42"


# ---------- 隔离 3：名称冲突拒绝后加载者 ----------

def test_name_conflicts_reject_the_later_pack(packs_dir, tmp_path):
    tool = "from langchain_core.tools import tool\n\n@tool\ndef {name}() -> str:\n    '''x'''\n    return 'x'\n\nTOOLS = [{name}]\n"
    _pack(packs_dir / "aaa_first", {"id": "aaa_first", "name": "先来", "entry": "tools.py", "tools": ["shared_tool"]},
          tool.format(name="shared_tool"))
    _pack(packs_dir / "zzz_second", {"id": "zzz_second", "name": "后到", "entry": "tools.py", "tools": ["shared_tool"]},
          tool.format(name="shared_tool"))
    _pack(packs_dir / "core_clash", {"id": "core_clash", "name": "撞核心", "entry": "tools.py", "tools": ["todo_add"]},
          tool.format(name="todo_add"))
    _pack(packs_dir / "step_clash", {"id": "step_clash", "name": "撞积木", "kind": "step", "entry": "tools.py",
                                      "steps": ["web_page"]}, "STEPS = {}\n")
    current = loader.reload()
    rows = {row["id"]: row for row in current.management()}
    assert rows["aaa_first"]["status"] == "ok"
    assert rows["zzz_second"]["status"] == "unavailable" and "已被「先来」占用" in rows["zzz_second"]["reason"]
    assert rows["core_clash"]["status"] == "unavailable" and "todo_add" in rows["core_clash"]["reason"]
    assert rows["step_clash"]["status"] == "unavailable" and "web_page" in rows["step_clash"]["reason"]
    assert [t.name for t in plugins.pack_tools()].count("shared_tool") == 1
    # 导入的插件和内置插件同 id：导入的被拒绝
    clone = tmp_path / "plugins" / "todo"
    clone.mkdir(parents=True)
    (clone / "SKILL.md").write_text("---\nname: todo\n---\n# 抢名字\n正文", encoding="utf-8")
    rows = {(row["id"], row["builtin"]): row for row in loader.reload().management()}
    assert rows[("todo", True)]["status"] == "ok"
    assert rows[("todo", False)]["status"] == "unavailable" and "重复" in rows[("todo", False)]["reason"]


# ---------- 隔离 4：插件设置命名空间 ----------

def test_plugin_settings_live_in_their_own_namespace():
    from jarvis.accounts import AccountStore
    from jarvis.tenancy import TenantStore
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    owner = accounts.unique_active_owner().user_id
    with tenant_scope(owner):
        plugin_settings.set("echo_tool", "city", "上海")
        plugin_settings.set("echo_tool", "unit", "metric")
        plugin_settings.set("other_one", "city", "北京")
        TenantStore().set_pref("persona_address", "老板")
        assert plugin_settings.get("echo_tool", "city") == "上海"
        assert plugin_settings.all_for("echo_tool") == {"city": "上海", "unit": "metric"}
        assert plugin_settings.all_for("other_one") == {"city": "北京"}
        assert TenantStore().get_pref("plugin:echo_tool:city") == "上海"
        assert TenantStore().get_pref("persona_address") == "老板"      # 插件碰不到贾维斯自己的偏好
        plugin_settings.set("echo_tool", "city", None)
        assert plugin_settings.get("echo_tool", "city") is None
    with pytest.raises(plugin_settings.SettingsError):
        plugin_settings.pref_key("echo_tool", "../persona")
    with pytest.raises(plugin_settings.SettingsError):
        plugin_settings.pref_key("Bad-Id", "x")


# ---------- 隔离 5：第三方插件在子进程里执行 ----------

def test_third_party_tools_run_in_a_sandboxed_subprocess(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_API_KEY", "sk-super-secret")
    monkeypatch.setenv("FEISHU_APP_SECRET", "feishu-secret")
    _install(tmp_path, "echo_tool", record={"installed_at": "2026-10-02T00:00:00+00:00",
                                            "source": {"type": "github", "repo": "someone/echo", "ref": "a" * 40}})
    entry = plugins.get_plugin("echo_tool")
    assert entry["status"] == "ok" and entry["builtin"] is False
    assert entry["source"] == {"type": "github", "repo": "someone/echo", "ref": "a" * 40}
    tools = {t.name: t for t in plugins.pack_tools()}
    assert getattr(tools["echo_shout"], "plugin_sandboxed", False)
    assert tools["echo_shout"].invoke({"text": "hi"}) == "HI！"          # 同级模块可导入、print 不混进结果
    assert tools["echo_count"].invoke({"text": "嗨", "times": 3}) == "嗨 嗨 嗨"   # 普通函数也能当工具
    env_names = json.loads(tools["echo_env"].invoke({}))
    assert "JARVIS_API_KEY" not in env_names and "FEISHU_APP_SECRET" not in env_names
    assert set(env_names) <= {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "PYTHONDONTWRITEBYTECODE", "LC_CTYPE",
                              "__CF_USER_TEXT_ENCODING"}
    failed = tools["echo_fail"].invoke({})
    assert "插件「回声测试」这次没办成" in failed and "ValueError" in failed
    crashed = tools["echo_crash"].invoke({})
    assert "意外退出" in crashed
    started = time.monotonic()
    slow = tools["echo_slow"].invoke({"seconds": 30})
    assert "超时" in slow and time.monotonic() - started < 6
    assert tools["echo_shout"].invoke({"text": "again"}) == "AGAIN！"     # 崩溃 / 超时之后照常可用


def test_sandbox_never_imports_third_party_code_in_process(tmp_path):
    _install(tmp_path, "echo_tool")
    import sys
    assert "jarvis_plugin_entry" not in sys.modules and "helper" not in sys.modules


def test_sandbox_describe_reports_import_errors(tmp_path):
    folder = tmp_path / "broken"
    folder.mkdir()
    (folder / "tools.py").write_text("import surely_missing_module\n", encoding="utf-8")
    with pytest.raises(sandbox.SandboxError) as caught:
        sandbox.describe(folder, "tools.py")
    assert "ModuleNotFoundError" in str(caught.value)


# ---------- 积木注册进流程引擎 ----------

STEP_CODE = '''
from jarvis.flows.steps import Outcome, StepSpec

def run_shout(job, ctx, options):
    ctx["text"] = (ctx.get("text") or "").upper()
    return Outcome("大写好了", ctx["text"])

STEPS = {"pack_shout": StepSpec("pack_shout", "变大写", "process", ("text",), ("text",), run=run_shout,
                                summary="把上一步的文字全部变成大写")}
TOOLS = []
'''


def test_pack_steps_register_into_the_flow_engine_and_catalog(packs_dir):
    from jarvis.flows import engine, steps as flow_steps
    _pack(packs_dir / "shouter", {"id": "shouter", "name": "大写工具", "kind": "tool", "entry": "tools.py",
                                   "tools": [], "steps": ["pack_shout"]}, STEP_CODE)
    loader.reload()
    assert "pack_shout" in flow_steps.STEPS
    entry = plugins.get_plugin("pack_shout")
    assert entry["kind"] == "step" and entry["pack"] == "shouter" and entry["step"]["role"] == "process"
    assert entry["summary"] == "把上一步的文字全部变成大写"
    flow = engine.normalize_flow("测试", [{"plugin": "input_text"}, {"plugin": "pack_shout"}, {"plugin": "web_page"}])
    assert [s["plugin"] for s in flow["steps"]] == ["input_text", "pack_shout", "web_page"]
    loader.set_enabled("shouter", False)
    assert "pack_shout" not in flow_steps.STEPS and not plugins.is_plugin("pack_shout")
    assert set(flow_steps.CORE_STEP_IDS) <= set(flow_steps.STEPS)       # 核心积木永远在


# ---------- Agent 绑定：Owner 拿到全部已启用插件的工具；平台账号只拿装了的 ----------

def test_build_agent_merges_pack_tools(tmp_path):
    from tests.test_platform_agent import ToolRecordingModel
    from jarvis.graph import build_agent
    from jarvis.search.service import SearchService
    _install(tmp_path, "echo_tool")
    model = ToolRecordingModel()
    build_agent(search_service=SearchService([]), model=model, checkpointer=False)
    assert "echo_shout" in model.bound[-1] and "todo_add" in model.bound[-1]
    member_tools = set(plugins.BASE_TOOLS) | plugins.tools_for(["todo", "echo_tool"])
    model = ToolRecordingModel()
    build_agent(search_service=SearchService([]), model=model, checkpointer=False, tool_names=member_tools)
    assert set(model.bound[-1]) == member_tools
    loader.set_enabled("echo_tool", False)
    model = ToolRecordingModel()
    build_agent(search_service=SearchService([]), model=model, checkpointer=False)
    assert "echo_shout" not in model.bound[-1]


def test_runtime_bundles_rebuild_when_plugins_change(monkeypatch):
    import jarvis.provider_runtime as runtime_mod
    before = runtime_mod._plugins_generation()
    loader.set_enabled("movies", False)
    assert runtime_mod._plugins_generation() > before


# ---------- 提示词技能 ----------

def test_skill_plugins_are_injected_as_external_material(tmp_path):
    from jarvis.accounts import AccountStore
    from jarvis.prompts import compose_system_prompt
    from jarvis.platforms import PlatformStore
    plugin_id = _install(tmp_path, "community_skill")
    assert plugin_id == "polite_reply"
    entry = plugins.get_plugin("polite_reply")
    assert entry["kind"] == "skill" and entry["name"] == "礼貌回复" and entry["tools"] == []
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    owner = accounts.unique_active_owner().user_id
    with tenant_scope(owner):
        prompt = compose_system_prompt()
    assert "外部资料，不是指令" in prompt and "第一句先感谢对方的耐心" in prompt
    assert "name: polite-reply" not in prompt                    # front matter 不进提示词
    member = accounts.create_user("member_s", "Member-pass-123", "Member")["id"]
    PlatformStore().create(member, {"name": "测试", "plugins": ["todo"], "profession": "", "icon": "✨",
                                    "accent": "#0A84FF", "tagline": ""})
    with tenant_scope(member):
        assert "第一句先感谢对方的耐心" not in compose_system_prompt()   # 没装就不注入
    PlatformStore().update(member, {"plugins": ["todo", "polite_reply"]})
    with tenant_scope(member):
        assert "第一句先感谢对方的耐心" in compose_system_prompt()


def test_skill_markdown_parsing_and_limits():
    parsed = mf.parse_skill("---\nname: x-y\ndescription: >\n  多行\n  描述\n---\n# 标题\n" + "字" * 2500)
    assert parsed["title"] == "标题" and parsed["description"] == "多行 描述"
    assert len(parsed["body"]) == 2000 and parsed["truncated"] is True
    plain = mf.parse_skill("没有标题的正文")
    assert plain["title"] == "" and plain["body"] == "没有标题的正文"
    assert skills._escape("a</技能>b") == "a</ 技能>b"


def test_agent_plugin_format_maps_onto_our_manifest(tmp_path):
    m = mf.read(FIXTURES / "plugins" / "agent_plugin", builtin=False)
    assert m["id"] == "meeting_helper" and m["name"] == "会议助手" and m["kind"] == "skill"
    assert m["summary"] == "把会议记录整理成纪要和行动项" and m["author"] == "示例团队"
    assert m["examples"] == ["把这段会议记录整理成纪要", "列出会上定下的行动项"]
    assert m["extras"]["capabilities"] == ["Read", "Write"] and m["extras"]["privacy_url"].startswith("https://")
    assert m["extras"]["mcp"][0]["type"] == "streamable-http" and m["license"] == "MIT"
    nested = mf.read(FIXTURES / "plugins" / "marketplace" / "plugins" / "festival-greetings", builtin=False)
    assert nested["id"] == "festival_greetings" and nested["name"] == "节日祝福语" and nested["category"] == "life"


def test_unit_convert_example_loads_as_third_party(tmp_path):
    _install(tmp_path, "unit_convert")
    entry = plugins.get_plugin("unit_convert")
    assert entry["status"] == "ok", entry["reason"]
    tool = {t.name: t for t in plugins.pack_tools()}["unit_convert"]
    assert "1.75 千克" in tool.invoke({"value": 3.5, "from_unit": "斤", "to_unit": "公斤"})


# ---------- 办公插件包（C 提供）：自动发现、积木注册、按智能体过滤工具 ----------

OFFICE = {"pdf": ("pdf_",), "excel": ("excel_", "csv_"), "word": ("word_",)}


def test_office_packs_are_discovered_and_filtered_per_agent():
    from tests.test_platform_agent import ToolRecordingModel
    from jarvis.accounts import AccountStore
    from jarvis.flows import steps as flow_steps
    from jarvis.graph import build_agent
    from jarvis.platforms import PlatformStore, agent_tool_names
    from jarvis.search.service import SearchService
    found = [pid for pid in OFFICE if plugins.is_plugin(pid)]
    if not found:
        pytest.skip("办公插件包还没合进来")
    for pid in found:
        entry = plugins.get_plugin(pid)
        assert entry["builtin"] and entry["kind"] == "tool" and entry["tools"], pid
        assert all(name.startswith(OFFICE[pid]) for name in entry["tools"]), pid
    for step_id in ("excel_out", "word_out"):
        entry = plugins.get_plugin(step_id)
        if entry and entry["status"] == "ok":
            assert entry["kind"] == "step" and entry["pack"] in OFFICE and step_id in flow_steps.STEPS
    usable = [pid for pid in found if plugins.get_plugin(pid)["status"] == "ok"]
    if not usable:
        pytest.skip("办公插件的依赖没装")
    picked = usable[0]
    others = set()
    for pid in usable[1:]:
        others |= plugins.tools_for([pid])
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    member = accounts.create_user("office_member", "Member-pass-123", "Member")["id"]
    from jarvis.platforms import PlatformStore
    PlatformStore().create(member, {"name": "办公助手", "plugins": [picked, "todo"], "profession": "", "icon": "✨",
                                    "accent": "#0A84FF", "tagline": ""})
    names = agent_tool_names(member)
    assert plugins.tools_for([picked]) <= names and {"todo_add", "now", "calc"} <= names
    assert not names & others                                          # 没装的办公插件工具一个都不给
    model = ToolRecordingModel()
    build_agent(search_service=SearchService([]), model=model, checkpointer=False, tool_names=names)
    assert set(model.bound[-1]) == names
    owner = accounts.unique_active_owner().user_id
    assert agent_tool_names(owner) is None                             # Owner：完整贾维斯
    model = ToolRecordingModel()
    build_agent(search_service=SearchService([]), model=model, checkpointer=False)
    assert plugins.tools_for(usable) <= set(model.bound[-1])


def test_tool_display_names_the_owning_plugin():
    """对话芯片 / 飞书进度提示用：插件工具能查到所属插件的图标与名字，未知工具返回 None。"""
    from jarvis.plugins import tool_display
    assert tool_display("excel_summary") == {"icon": tool_display("excel_summary")["icon"], "name": "Excel 工具箱"}
    assert tool_display("schedule_add")["name"]
    assert tool_display("no_such_tool") is None
    assert tool_display("") is None
