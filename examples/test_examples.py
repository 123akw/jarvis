"""示例插件整体自检：模板和 examples/plugins/ 下每个插件都要通过 check_plugin，没有错误也没有安全提醒。"""
import importlib.util
import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("jarvis_examples_check_plugin", HERE / "check_plugin.py")
checker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(checker)

PLUGINS = [HERE / "plugin-template", *sorted(p for p in (HERE / "plugins").iterdir() if p.is_dir())]


@pytest.mark.parametrize("plugin_dir", PLUGINS, ids=lambda p: p.name)
def test_example_plugin_passes_contract(plugin_dir):
    errors, warnings = checker.check_plugin(plugin_dir)
    assert errors == []
    assert not [w for w in warnings if "人工看一眼" in w], warnings   # 示例插件不联网、不读环境变量
    manifest = json.loads((plugin_dir / "plugin.json").read_text(encoding="utf-8"))
    assert manifest["python_packages"] == []                         # 示例只用标准库


def test_example_ids_and_tool_names_unique():
    ids, tools = [], []
    for plugin_dir in PLUGINS:
        manifest = json.loads((plugin_dir / "plugin.json").read_text(encoding="utf-8"))
        ids.append(manifest["id"])
        tools += manifest["tools"]
    assert len(ids) == len(set(ids)) and len(tools) == len(set(tools))


def test_checker_catches_common_mistakes(tmp_path):
    (tmp_path / "plugin.json").write_text(json.dumps({
        "id": "Bad-Id", "name": "坏插件", "version": "1", "icon": "x", "kind": "tool",
        "category": "games", "summary": "演示", "entry": "tools.py", "tools": ["bad_tool"],
        "steps": [], "requires": ["root"]}), encoding="utf-8")
    (tmp_path / "tools.py").write_text("import os\nKEY = os.environ.get('X')\nTOOLS = []\n", encoding="utf-8")
    errors, warnings = checker.check_plugin(tmp_path)
    joined = "\n".join(errors)
    assert "id「Bad-Id」不合规" in joined and "category" in joined and "requires" in joined
    assert "与 plugin.json 的 tools 不一致" in joined
    assert any("读取环境变量" in w for w in warnings)


def test_checker_skill_rules(tmp_path):
    (tmp_path / "plugin.json").write_text(json.dumps({
        "id": "long_skill", "name": "长技能", "version": "1.0.0", "icon": "📘", "kind": "skill",
        "category": "ai", "summary": "演示超长技能", "entry": None, "tools": [], "steps": [],
        "requires": []}), encoding="utf-8")
    (tmp_path / "SKILL.md").write_text("# 长技能\n" + "字" * 2001, encoding="utf-8")
    errors, _ = checker.check_plugin(tmp_path)
    assert any("超过 2000 字" in e for e in errors)


# ---------- 插件源与 Agent Plugins 标准插件 ----------

MARKET = HERE / "marketplace"
REPO_URL = "https://github.com/123akw/jarvis.git"


def _resolve_this_repo(url, path):
    """插件源引用本仓库的子目录时，直接用本地副本检查。"""
    return HERE.parent / path if url == REPO_URL else None


def test_marketplace_example_passes():
    errors, warnings = checker.check_marketplace(MARKET, resolve_git=_resolve_this_repo)
    assert errors == []
    assert not [w for w in warnings if "人工看一眼" in w], warnings
    data = json.loads((MARKET / ".agents/plugins/marketplace.json").read_text(encoding="utf-8"))
    referenced = {e["source"].get("path", "").rsplit("/", 1)[-1] for e in data["plugins"]}
    assert {p.name for p in (HERE / "plugins").iterdir() if p.is_dir()} <= referenced   # 示例插件都上了插件源


def test_agent_plugin_maps_to_skill_plugin():
    errors, warnings = [], []
    root = MARKET / "plugins" / "festival-greetings"
    raw = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
    mapped, body = checker.from_agent_plugin(raw, root, errors, warnings)
    assert errors == []
    assert mapped["id"] == "festival_greetings" and mapped["kind"] == "skill"
    assert mapped["name"] == "节日祝福语" and mapped["category"] == "life"
    assert mapped["examples"][0] == "帮我写条中秋祝福发给客户"
    assert body.startswith("# 节日祝福语")
    assert checker.check_plugin(root) == ([], [])


def test_marketplace_rejects_npm_and_escaping_paths(tmp_path):
    (tmp_path / ".agents/plugins").mkdir(parents=True)
    (tmp_path / ".agents/plugins/marketplace.json").write_text(json.dumps({
        "name": "bad-source", "plugins": [
            {"name": "a", "source": {"source": "npm", "package": "@x/y"}},
            {"name": "b", "source": {"source": "local", "path": "../outside"}},
            {"name": "c", "source": {"source": "git-subdir", "url": "http://x/y.git", "path": "p"}},
        ]}), encoding="utf-8")
    errors, _ = checker.check_marketplace(tmp_path)
    joined = "\n".join(errors)
    assert "npm" in joined and "./ 开头" in joined and "https" in joined
