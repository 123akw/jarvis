"""插件自带测试：直接测工具函数，不需要模型、不需要启动贾维斯。

运行：在插件目录下 `python -m pytest -q`（需要 pytest、langchain-core、pydantic）。
"""
import datetime as dt
import importlib.util
import json
import re
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((PLUGIN_DIR / "plugin.json").read_text(encoding="utf-8"))


def _load_tools():
    # 用插件 id 当模块名按路径导入：多个插件的 tools.py 同时测试也不会互相顶掉
    spec = importlib.util.spec_from_file_location(f"plugin_{MANIFEST['id']}_tools", PLUGIN_DIR / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tools = _load_tools()
TODAY = dt.date(2026, 10, 2)


# ---------- 清单与导出（每个插件都该有这一组） ----------

def test_manifest_matches_exports():
    assert re.fullmatch(r"[a-z][a-z0-9_]{1,30}", MANIFEST["id"])
    assert MANIFEST["kind"] == "tool" and MANIFEST["entry"] == "tools.py"
    assert [t.name for t in tools.TOOLS] == MANIFEST["tools"]
    for item in tools.TOOLS:
        assert item.name.startswith(MANIFEST["id"] + "_")
        assert item.description.strip(), "docstring 就是给模型看的说明，不能空"


# ---------- 业务逻辑 ----------

@pytest.mark.parametrize("text,expected", [
    ("2027-02-06", dt.date(2027, 2, 6)),
    ("2027/2/6", dt.date(2027, 2, 6)),
    ("2027年2月6日", dt.date(2027, 2, 6)),
    ("12月25日", dt.date(2026, 12, 25)),
    ("3月8号", dt.date(2027, 3, 8)),        # 今年已过，取明年
    ("2月30日", None),
    ("下周三", None),
])
def test_parse_date(text, expected):
    assert tools.parse_date(text, TODAY) == expected


def test_countdown_future_today_and_past():
    assert tools.countdown_text("2026-10-09", "", TODAY) == "离 10月9日（周五）还有 7 天，约 1 周。"
    assert "就是今天" in tools.countdown_text("10月2日", "", TODAY)
    assert "已经过去 1 天" in tools.countdown_text("2026-10-01", "国庆", TODAY)
    assert "「春节」" in tools.countdown_text("2027-02-06", "春节", TODAY)


def test_bad_input_returns_friendly_text():
    assert "没看懂日期" in tools.countdown_text("随便哪天", "", TODAY)


def test_tool_invoke_returns_text():
    out = tools.my_plugin_countdown.invoke({"target": "2099-01-01", "label": "很久以后"})
    assert isinstance(out, str) and "还有" in out


# ---------- 积木（只在贾维斯环境里测） ----------

def test_step_stamp():
    pytest.importorskip("jarvis.flows.steps")
    spec = tools.STEPS["my_plugin_stamp"]
    assert list(tools.STEPS) == MANIFEST["steps"]
    ctx = {"text": "今天的会议要点"}
    outcome = spec.run(None, ctx, {})
    assert "整理于" in ctx["text"] and outcome.summary
