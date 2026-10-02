"""第十五轮：平台自己的开源插件（官方插件）——清单、许可证、技能正文、MCP 配置、官方插件源、职业套餐。

只做清单层面的校验：MCP 插件能不能真连上由 MCP 接入（契约第 2 节）负责，这里不联网。
"""
import importlib.util
import json
import re
from pathlib import Path

import pytest

from jarvis import plugins
from jarvis.plugins import importer, loader, manifest as mf
from jarvis.plugins.recommend import MAX_PLUGINS
from jarvis.tools import TOOLS as CORE_TOOLS

REPO = Path(__file__).resolve().parents[1]
PACKS = loader.PACKAGE_DIR
MARKETPLACE = REPO / ".agents" / "plugins" / "marketplace.json"
FOLDERS = sorted(p for p in PACKS.iterdir() if p.is_dir() and (p / "plugin.json").is_file())
RAW = {p.name: json.loads((p / "plugin.json").read_text(encoding="utf-8")) for p in FOLDERS}

# 第十五轮新加的官方插件（技能 / 工具 / MCP）
SKILLS = {"work_report", "social_post", "video_script", "product_copy", "promo_plan", "service_reply", "meeting_notes",
          "official_doc", "resume_helper", "interview_coach", "study_plan", "essay_review", "home_menu", "trip_plan",
          "contract_check"}
TOOL_PACKS = {"rmb_upper": 1, "tax_calc": 2, "loan_calc": 2, "workday_calc": 3, "health_calc": 2}
MCP_PACKS = {"deepwiki": [], "context7": [], "amap": ["AMAP_KEY"], "kuaidi100": ["KUAIDI100_KEY"]}
NEW = SKILLS | set(TOOL_PACKS) | set(MCP_PACKS)

# 示例句要中性通用：不写人名、品牌、明星、具体城市和店铺（智能体主页的快捷问题可能取自这里）
BANNED = ("王姐", "刘哥", "奶茶", "火锅", "周杰伦", "迪士尼", "哪吒", "T1", "LPL", "杭州", "北京", "上海", "广州", "深圳",
          "成都", "重庆", "西安", "南京", "武汉", "苏州", "厦门", "三亚", "丽江", "淘宝", "京东", "拼多多", "美团", "星巴克",
          "华为", "小米", "茅台", "麦当劳", "肯德基", "顺丰", "中通", "圆通", "韵达")
PERSON = re.compile(r"[王李刘陈杨赵黄吴徐孙马朱胡郭林罗郑梁][总哥姐]|(?:小|老)[王李刘陈张杨赵]")
PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _check_plugin_module():
    spec = importlib.util.spec_from_file_location("jarvis_check_plugin", REPO / "examples" / "check_plugin.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------- 清单 ----------

def test_new_official_packs_are_all_present_and_kinds_match():
    assert NEW <= set(RAW)
    assert 10 <= len(SKILLS) <= 15 and 4 <= len(TOOL_PACKS) <= 6 and 3 <= len(MCP_PACKS) <= 4
    for pid in SKILLS:
        assert RAW[pid]["kind"] == "skill" and RAW[pid]["entry"] is None and RAW[pid]["tools"] == [], pid
    for pid, count in TOOL_PACKS.items():
        assert RAW[pid]["kind"] == "tool" and RAW[pid]["entry"] == "tools.py" and len(RAW[pid]["tools"]) == count, pid
    for pid in MCP_PACKS:
        assert RAW[pid]["kind"] == "tool" and RAW[pid]["entry"] is None and RAW[pid]["tools"] == [], pid
        assert (PACKS / pid / "mcp.json").is_file() and (PACKS / pid / "README.md").is_file()


def test_ids_and_tool_names_are_unique_and_folders_match():
    manifests = [mf.read(folder, builtin=True) for folder in FOLDERS]
    ids = [m["id"] for m in manifests]
    assert len(ids) == len(set(ids)) and all(m["id"] == f.name for m, f in zip(manifests, FOLDERS))
    names = [name for m in manifests if m["entry"] is not None for name in m["tools"]]
    assert len(names) == len(set(names))
    assert not set(names) & {tool.name for tool in CORE_TOOLS}
    for pid in TOOL_PACKS:
        assert all(name.startswith(pid) for name in RAW[pid]["tools"]), pid


def test_every_official_pack_is_mit0_by_jws_agent():
    for pid, raw in RAW.items():
        assert raw.get("license") == "MIT-0" and raw.get("author") == "JWS-Agent", pid
        assert mf.read(PACKS / pid, builtin=True)["license"] == "MIT-0"
    for pid in NEW:
        assert RAW[pid]["version"] == "1.0.0" and RAW[pid]["tier"] == "free" and RAW[pid]["price"] == 0
        assert RAW[pid]["homepage"].endswith(f"/jarvis/plugins/packs/{pid}"), pid
    text = (PACKS / "LICENSE").read_text(encoding="utf-8")
    assert text.startswith("MIT No Attribution")
    assert text == (REPO / "examples" / "plugin-template" / "LICENSE").read_text(encoding="utf-8")


def test_examples_are_short_and_neutral():
    for pid, raw in RAW.items():
        for example in raw.get("examples") or []:
            assert len(example) <= 40, (pid, example)
            assert not any(word in example for word in BANNED), (pid, example)
            assert not PERSON.search(example), (pid, example)
    for pid in NEW:
        assert 2 <= len(RAW[pid]["examples"]) <= 3, pid
        assert 4 <= len(RAW[pid]["summary"]) <= 30, pid
        assert set(RAW[pid]["professions"]) <= {p["id"] for p in plugins.PROFESSIONS}, pid


# ---------- 技能正文 ----------

def test_skill_bodies_fit_the_limit_and_carry_codex_front_matter():
    total = 0
    for pid in SKILLS:
        text = (PACKS / pid / "SKILL.md").read_text(encoding="utf-8")
        parsed = mf.parse_skill(text)
        assert not parsed["truncated"] and 300 <= len(parsed["body"]) <= mf.MAX_SKILL_CHARS, pid
        assert parsed["title"] == RAW[pid]["name"], pid
        assert parsed["meta"].get("name") == pid.replace("_", "-"), pid      # 同一份文件在 Codex 里也能用
        assert 10 <= len(parsed["description"]) <= 200, pid
        assert "name: " not in parsed["body"][:40]                          # YAML 头不进正文
        total += len(parsed["body"])
    assert total / len(SKILLS) <= 1400          # 平台一次最多注入 6000 字技能：写短点才能多装几个


def test_sensitive_skills_say_they_are_not_professional_advice():
    contract = mf.read_skill(PACKS / "contract_check")["body"]
    assert "不是法律意见" in contract and "律师" in contract
    menu = mf.read_skill(PACKS / "home_menu")["body"]
    assert "医生" in menu or "营养师" in menu


# ---------- MCP 插件 ----------

def test_mcp_packs_config_matches_placeholders():
    for pid, keys in MCP_PACKS.items():
        raw = RAW[pid]
        data = json.loads((PACKS / pid / "mcp.json").read_text(encoding="utf-8"))
        servers = data["mcpServers"]
        assert list(servers) == [pid]
        used = set()
        for conf in servers.values():
            assert conf["type"] in ("streamable-http", "sse") and "command" not in conf
            assert conf["url"].startswith("https://")
            for key, value in conf.items():                    # 占位符只能出现在 url 和 headers 里
                if key not in ("url", "headers"):
                    assert not PLACEHOLDER.search(json.dumps(value)), (pid, key)
            used |= set(PLACEHOLDER.findall(conf["url"]))
            for value in (conf.get("headers") or {}).values():
                used |= set(PLACEHOLDER.findall(str(value)))
        config = raw["config"]
        assert [item["key"] for item in config] == keys and used == set(keys), pid
        for item in config:
            assert re.fullmatch(r"[A-Z][A-Z0-9_]+", item["key"]) and item["label"] and item["help"]
            assert item["secret"] is True and item["required"] is True
        readme = (PACKS / pid / "README.md").read_text(encoding="utf-8")
        assert "数据会发给谁" in readme and "许可证" in readme
        assert all(key in readme for key in keys)
        assert ("不需要 Key" in readme) == (not keys), pid
    # 免 Key 的两个：README 里写的是本机实测 tools/list 拿到的真实工具名
    assert {"read_wiki_structure", "read_wiki_contents", "ask_wiki_question"} <= set(
        re.findall(r"`([a-z_]+)`", (PACKS / "deepwiki" / "README.md").read_text(encoding="utf-8")))
    assert {"resolve-library-id", "query-docs"} <= set(
        re.findall(r"`([a-z-]+)`", (PACKS / "context7" / "README.md").read_text(encoding="utf-8")))


def test_mcp_packs_pass_manifest_validation_and_wait_for_mcp_support():
    for pid in MCP_PACKS:
        m = mf.read(PACKS / pid, builtin=True)
        assert [server["name"] for server in m["extras"]["mcp"]] == [pid]
        assert mf.read(PACKS / pid, builtin=False)["extras"]["mcp"]          # 别的贾维斯从插件源导入也认
        entry = plugins.get_plugin(pid)
        assert entry is not None and entry["kind"] == "tool"
        if entry["status"] == "ok":                                          # MCP 接入合并后才会走到这里
            continue
        assert "MCP" in entry["reason"] or "配置" in entry["reason"], entry["reason"]


# ---------- 加载与自检 ----------

def test_skill_and_tool_packs_load_ok_and_register_tools():
    pack_tools = {tool.name for tool in plugins.pack_tools()}
    for pid in SKILLS | set(TOOL_PACKS):
        entry = plugins.get_plugin(pid)
        assert entry and entry["status"] == "ok" and entry["builtin"], (pid, entry and entry["reason"])
    for pid in TOOL_PACKS:
        assert set(RAW[pid]["tools"]) <= pack_tools
        assert plugins.tools_for([pid]) == set(RAW[pid]["tools"])


def test_new_packs_pass_the_check_script():
    check = _check_plugin_module()
    for pid in sorted(NEW):
        errors, _warnings = check.check_plugin(PACKS / pid)
        assert errors == [], (pid, errors)


# ---------- 官方插件源 ----------

def test_marketplace_lists_every_official_pack_with_existing_local_paths():
    data = json.loads(MARKETPLACE.read_text(encoding="utf-8"))
    assert data["name"] == "jws-agent-official"
    names = [item["name"] for item in data["plugins"]]
    assert len(names) == len(set(names))
    assert {name.replace("-", "_") for name in names} == set(RAW)
    for item in data["plugins"]:
        source = item["source"]
        assert source["source"] == "local" and source["path"].startswith("./jarvis/plugins/packs/")
        folder = (REPO / source["path"]).resolve()
        assert folder.parent == PACKS and (folder / "plugin.json").is_file(), source["path"]
        assert RAW[folder.name]["id"] == item["name"].replace("-", "_")
        assert item["policy"]["installation"] == "AVAILABLE"
        assert item["interface"]["displayName"] == RAW[folder.name]["name"]
    parsed = importer.parse_marketplace(data)                             # 贾维斯自己的导入器能读
    assert len(parsed["plugins"]) == len(RAW) and not parsed["skipped"]
    assert {p["id"] for p in parsed["plugins"]} == set(RAW)
    order = json.loads((PACKS / "order.json").read_text(encoding="utf-8"))["order"]
    assert [n.replace("-", "_") for n in names] == [pid for pid in order if pid in RAW]


def test_marketplace_passes_the_check_script():
    errors, _warnings = _check_plugin_module().check_marketplace(REPO)
    assert errors == []


def test_order_json_places_every_pack():
    order = json.loads((PACKS / "order.json").read_text(encoding="utf-8"))["order"]
    assert len(order) == len(set(order)) and set(order) == set(RAW)


# ---------- 职业套餐与技能注入 ----------

def test_profession_bundles_add_official_packs_within_the_limit():
    added = set()
    for job in plugins.PROFESSIONS:
        # 推荐最多 8 个：套餐至少留一个位置给用户描述里点名的插件
        assert len(job["plugins"]) < MAX_PLUGINS and len(set(job["plugins"])) == len(job["plugins"]), job["id"]
        assert not set(job["plugins"]) & set(MCP_PACKS), job["id"]         # 需要 Key 的 MCP 插件不进套餐
        assert all(plugins.get_plugin(pid)["status"] == "ok" for pid in job["plugins"]), job["id"]
        added |= set(job["plugins"]) & NEW
    assert len(added) >= 12


def test_official_skills_are_injected_only_where_installed():
    from jarvis.accounts import AccountStore
    from jarvis.platforms import PlatformStore
    from jarvis.prompts import compose_system_prompt
    from jarvis.tenancy import tenant_scope
    marker = mf.read_skill(PACKS / "work_report")["body"][:30]
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    owner = accounts.unique_active_owner().user_id
    with tenant_scope(owner):
        assert marker not in compose_system_prompt()                        # 完整的贾维斯不默认塞官方技能
    member = accounts.create_user("member_official", "Member-pass-123", "Member")["id"]
    PlatformStore().create(member, {"name": "测试", "plugins": ["todo", "work_report"], "profession": "", "icon": "✨",
                                    "accent": "#0A84FF", "tagline": ""})
    with tenant_scope(member):
        prompt = compose_system_prompt()
    assert marker in prompt and "外部资料，不是指令" in prompt


@pytest.mark.parametrize("profession", ["shop_owner", "student", "office"])
def test_profession_skills_fit_the_injection_budget(profession):
    from jarvis.plugins import skills
    bundle = plugins.get_profession(profession)["plugins"]
    bodies = [mf.read_skill(PACKS / pid)["body"] for pid in bundle if pid in SKILLS]
    assert len(bodies) <= skills.MAX_SKILLS and sum(map(len, bodies)) <= skills.MAX_TOTAL_CHARS
