"""单位换算插件测试：直接测工具函数，不需要模型。"""
import importlib.util
import json
import re
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((PLUGIN_DIR / "plugin.json").read_text(encoding="utf-8"))


def _load_tools():
    spec = importlib.util.spec_from_file_location(f"plugin_{MANIFEST['id']}_tools", PLUGIN_DIR / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tools = _load_tools()


def test_manifest_matches_exports():
    assert re.fullmatch(r"[a-z][a-z0-9_]{1,30}", MANIFEST["id"])
    assert [t.name for t in tools.TOOLS] == MANIFEST["tools"]
    assert all(t.name.startswith(MANIFEST["id"]) and t.description.strip() for t in tools.TOOLS)


@pytest.mark.parametrize("value,src,dst,expected", [
    (3.5, "斤", "公斤", "3.5 斤 = 1.75 千克"),
    (1, "亩", "平方米", "1 亩 = 666.666667 平方米"),
    (6, "英尺", "cm", "6 英尺 = 182.88 厘米"),
    (1, "kg", "斤", "1 千克 = 2 斤"),
    (1, "斤", "两", "1 斤 = 10 两"),
    (3, "尺", "米", "3 尺 = 1 米"),
    (1, "公里", "里", "1 千米 = 2 里"),
    (10, "公顷", "亩", "10 公顷 = 150 亩"),
    (5, "分", "平方米", "5 分 = 333.333333 平方米"),     # 「分」跟着目标单位落到面积
    (2, "方", "升", "2 立方米 = 2000 升"),
    (0.1, "米", "厘米", "0.1 米 = 10 厘米"),
])
def test_ratio_conversions(value, src, dst, expected):
    assert tools.convert(value, src, dst).startswith(expected)


@pytest.mark.parametrize("value,src,dst,expected", [
    (100, "华氏度", "摄氏度", "100 华氏度 = 37.777778 摄氏度"),
    (37, "℃", "℉", "37 摄氏度 = 98.6 华氏度"),
    (0, "K", "摄氏度", "0 开尔文 = -273.15 摄氏度"),
])
def test_temperature(value, src, dst, expected):
    assert tools.convert(value, src, dst) == expected


def test_below_absolute_zero_is_flagged():
    assert "绝对零度" in tools.convert(-300, "摄氏度", "开尔文")


def test_friendly_errors():
    assert "不认识单位「坨」" in tools.convert(1, "坨", "千克")
    assert "没法互相换算" in tools.convert(1, "斤", "米")
    assert "请说明是哪一类" in tools.convert(1, "分", "分")
    assert tools.convert(1, "分", "分", category="面积").startswith("1 分 = 1 分")
    assert "太大" in tools.convert(1e20, "米", "千米")
    assert "看不懂" in tools.convert(float("nan"), "米", "千米")


def test_units_listing():
    listing = tools.list_units()
    assert "亩" in listing and "摄氏度" in listing
    assert tools.list_units("温度").startswith("温度：")
    assert "没有「速度」" in tools.list_units("速度")


def test_tool_invoke():
    out = tools.unit_convert.invoke({"value": 2, "from_unit": "两", "to_unit": "克"})
    assert out.startswith("2 两 = 100 克")
    assert "长度" in tools.unit_convert_units.invoke({})
