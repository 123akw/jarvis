"""官方工具插件「BMI与热量」：WS/T 428—2013 分档边界、腰围、Mifflin-St Jeor 已知值、输入校验、清单一致。"""
import json
from pathlib import Path

import pytest

from jarvis.plugins.packs.health_calc import tools as health_calc_tools

PACK = Path(health_calc_tools.__file__).resolve().parent
MANIFEST = json.loads((PACK / "plugin.json").read_text(encoding="utf-8"))


def test_manifest_matches_exports():
    assert [t.name for t in health_calc_tools.TOOLS] == MANIFEST["tools"] == ["health_calc_bmi", "health_calc_energy"]
    assert MANIFEST["license"] == "MIT-0" and MANIFEST["author"] == "JWS-Agent"


@pytest.mark.parametrize("bmi,level", [
    (18.49, "体重过低"), (18.5, "体重正常"), (23.99, "体重正常"), (24.0, "超重"), (27.99, "超重"), (28.0, "肥胖"),
])
def test_bmi_levels_follow_ws_t_428(bmi, level):
    assert health_calc_tools.bmi_level(bmi) == level


@pytest.mark.parametrize("waist,sex,level", [
    (84.9, "男", "腰围正常"), (85, "男", "中心型肥胖前期"), (89.9, "男", "中心型肥胖前期"), (90, "男", "中心型肥胖"),
    (79.9, "女", "腰围正常"), (80, "女", "中心型肥胖前期"), (85, "女", "中心型肥胖"),
])
def test_waist_levels(waist, sex, level):
    assert health_calc_tools.waist_level(waist, sex) == level


def test_bmi_text():
    out = health_calc_tools.bmi_text(170, 75, 88, "男")
    assert "**BMI 26.0，超重**" in out
    assert "53.5–69.1 kg" in out and "多 5.9 kg" in out
    assert "**中心型肥胖前期**" in out and "WS/T 428—2013" in out and "不是诊断" in out
    thin = health_calc_tools.bmi_text(160, 45)
    assert "体重过低" in thin and "少 2.4 kg" in thin and "腰围" not in thin.split("依据")[0]
    both = health_calc_tools.bmi_text(160, 50, 82)
    assert "按男性标准是「腰围正常」" in both and "按女性标准是「中心型肥胖前期」" in both


def test_mifflin_st_jeor_known_values():
    assert health_calc_tools.bmr_value("女", 30, 160, 55) == pytest.approx(1239)
    assert health_calc_tools.bmr_value("男", 40, 175, 80) == pytest.approx(1698.75)


def test_energy_text():
    out = health_calc_tools.energy_text("男", 40, 175, 80, "中度")
    assert "基础代谢约 **1,699 千卡 / 天**" in out and "每日总消耗约 **2,633 千卡 / 天**" in out
    assert "2,133–2,333 千卡" in out and "仅供参考" in out and "孕妇" in out
    # 减重下限不低于基础代谢
    female = health_calc_tools.energy_text("female", 30, 160, 55, "light")
    assert "1,239–1,404 千卡" in female
    # 活动量太低时不建议继续少吃
    low = health_calc_tools.energy_text("女", 60, 150, 45, "久坐")
    assert "建议先多动一动" in low


@pytest.mark.parametrize("activity,expected", [
    ("", "久坐"), ("轻度", "轻度"), ("moderate", "中度"), ("每周中度运动", "中度"), ("重体力", "极高"), ("瞎写", None),
])
def test_activity_aliases(activity, expected):
    assert health_calc_tools.normalize_activity(activity) == expected


@pytest.mark.parametrize("call,hint", [
    (lambda t: t.bmi_text(1.7, 65), "厘米"),
    (lambda t: t.bmi_text(170, 400), "公斤"),
    (lambda t: t.bmi_text(170, float("nan")), "公斤"),
    (lambda t: t.bmi_text(170, 65, 0, "其他"), "性别"),
    (lambda t: t.bmi_text(170, 65, 500, "男"), "这次先不判断腰围"),
    (lambda t: t.energy_text("", 30, 170, 65), "性别"),
    (lambda t: t.energy_text("男", 15, 170, 65), "18 到 100"),
    (lambda t: t.energy_text("男", 30, 170, 65, "躺平"), "活动量"),
])
def test_bad_input_gets_plain_words(call, hint):
    assert hint in call(health_calc_tools)


def test_tool_invoke():
    out = health_calc_tools.health_calc_bmi.invoke({"height_cm": 170, "weight_kg": 65})
    assert "BMI 22.5，体重正常" in out
    out = health_calc_tools.health_calc_energy.invoke({"sex": "女", "age": 30, "height_cm": 160, "weight_kg": 55})
    assert "1,239" in out and "久坐" in out
