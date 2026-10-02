"""官方插件「个税社保速算」（tax_calc）：手算核对过的例子 + 工具清单与导出一致。"""
import json
from pathlib import Path

import pytest

from jarvis.plugins.packs.tax_calc import tools as tax_calc_tools

MANIFEST = json.loads((Path(tax_calc_tools.__file__).parent / "plugin.json").read_text(encoding="utf-8"))


def test_manifest_matches_exports():
    assert [t.name for t in tax_calc_tools.TOOLS] == MANIFEST["tools"]
    assert MANIFEST["license"] == "MIT-0" and MANIFEST["author"] == "JWS-Agent"
    assert all(t.name.startswith("tax_calc_") and "不要心算" in t.description for t in tax_calc_tools.TOOLS)


@pytest.mark.parametrize("taxable,expected", [
    (0, 0), (-5000, 0), (36000, 1080), (36001, 1080.1), (144000, 11880), (300000, 43080),
    (420000, 73080), (660000, 145080), (960000, 250080), (1000000, 268080),
])
def test_annual_tax_table(taxable, expected):
    # 年度税率表各档临界点：36000×3%；144000×10%−2520；300000×20%−16920 ……
    assert tax_calc_tools.annual_tax(taxable) == pytest.approx(expected)


def test_cumulative_withholding_monthly_20000():
    # 月薪 2 万、基数 2 万、公积金 7%、无专项：社保 2100 + 公积金 1400，每月应纳税所得额 11500
    plan = tax_calc_tools.withholding_schedule(20000, 20000, 7)
    assert plan["contrib"]["social"] == 2100 and plan["contrib"]["fund"] == 1400
    taxes = [row["tax"] for row in plan["rows"]]
    assert taxes[:3] == [345, 345, 345]             # 累计 34500 × 3%
    assert taxes[3] == pytest.approx(1045)          # 累计 46000 × 10% − 2520 − 已扣 1035
    assert taxes[4:] == [1150] * 8
    assert plan["annual_tax"] == pytest.approx(11280)
    assert plan["rows"][0]["net"] == pytest.approx(16155)
    assert plan["annual_net"] == pytest.approx(20000 * 12 - 3500 * 12 - 11280)


def test_low_salary_pays_no_tax_and_special_deduction_counts():
    plan = tax_calc_tools.withholding_schedule(6000, 6000, 7)
    assert plan["annual_tax"] == pytest.approx(0)   # 6000 − 5000 − 1050 ≤ 0
    with_kids = tax_calc_tools.withholding_schedule(20000, 20000, 7, special_deduction=5000)
    assert with_kids["rows"][0]["tax"] == pytest.approx(195)   # (11500 − 5000) × 3%


def test_salary_report_text_and_errors():
    text = tax_calc_tools.salary_report(20000, month=1)
    assert "345.00" in text and "16,155.00" in text and "仅供参考" in text and "2026 年" in text
    assert "1 月" in tax_calc_tools.salary_report(20000) and len(tax_calc_tools.salary_report(20000)) < 2000
    assert "正数" in tax_calc_tools.salary_report(0)
    assert "0–12" in tax_calc_tools.salary_report(10000, housing_fund_rate=20)
    assert "1–12" in tax_calc_tools.salary_report(10000, month=13)
    assert "1 亿" in tax_calc_tools.salary_report(2e9)


@pytest.mark.parametrize("bonus,expected", [
    (36000, 1080), (36001, 3390.1), (144000, 14190), (150000, 28590), (1200000, 524840),
])
def test_bonus_separate_tax(bonus, expected):
    # 按月换算后的税率表：36000/12=3000 → 3%；36001 → 10% − 210；150000/12=12500 → 20% − 1410
    assert tax_calc_tools.bonus_separate_tax(bonus) == pytest.approx(expected)


def test_bonus_dead_zones_are_the_known_ranges():
    zones = tax_calc_tools.bonus_dead_zones()
    assert zones[:2] == [(36000, pytest.approx(38566.67)), (144000, pytest.approx(160500))]
    assert zones[-1] == (960000, pytest.approx(1120000))
    for low, high in zones:   # 区间右端点的税后收入正好追平左端点
        after_low = low - tax_calc_tools.bonus_separate_tax(low)
        after_high = high - tax_calc_tools.bonus_separate_tax(high)
        assert after_high == pytest.approx(after_low, abs=0.02)


def test_bonus_report_compares_both_ways():
    text = tax_calc_tools.bonus_report(37000, 100000)
    assert "3,490.00" in text and "10,970.00" in text and "11,180.00" in text
    assert "单独计税** 更省" in text and "多发反而少拿" in text and "2027 年 12 月 31 日" in text
    merged_better = tax_calc_tools.bonus_report(20000, -30000)   # 工资扣除没用完：并入更省
    assert "并入综合所得** 更省" in merged_better
    assert "正数" in tax_calc_tools.bonus_report(0)


def test_tools_invoke():
    out = tax_calc_tools.tax_calc_salary.invoke({"monthly_salary": 20000, "month": 4})
    assert "1,045.00" in out
    out = tax_calc_tools.tax_calc_bonus.invoke({"bonus": 36000})
    assert "1,080.00" in out and "38,566.67" in out
