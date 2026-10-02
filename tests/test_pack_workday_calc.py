"""官方插件「日期工作日」（workday_calc）：按国务院办公厅 2025、2026 年放假通知核对。"""
import datetime as dt
import json
from pathlib import Path

import pytest

from jarvis.plugins.packs.workday_calc import tools as workday_calc_tools

MANIFEST = json.loads((Path(workday_calc_tools.__file__).parent / "plugin.json").read_text(encoding="utf-8"))
D = dt.date.fromisoformat


def test_manifest_matches_exports():
    assert [t.name for t in workday_calc_tools.TOOLS] == MANIFEST["tools"]
    assert MANIFEST["license"] == "MIT-0" and MANIFEST["author"] == "JWS-Agent"
    assert all(t.name.startswith("workday_calc_") and t.description.strip() for t in workday_calc_tools.TOOLS)


def test_holiday_data_matches_official_notices():
    data = workday_calc_tools.HOLIDAY_DATA
    assert data[2026]["number"] == "国办发明电〔2025〕7号" and data[2025]["number"] == "国办发明电〔2024〕12号"
    assert all(item["url"].startswith("https://www.gov.cn/") for item in data.values())
    lengths = {name: (D(last) - D(first)).days + 1 for name, first, last, _ in data[2026]["items"]}
    assert lengths == {"元旦": 3, "春节": 9, "清明节": 3, "劳动节": 5, "端午节": 3, "中秋节": 3, "国庆节": 7}
    for year in data.values():          # 调休上班日都落在周末
        for _, _, _, makeups in year["items"]:
            assert all(D(day).weekday() >= 5 for day in makeups)


@pytest.mark.parametrize("day,work,label", [
    ("2026-02-14", True, "春节调休上班"), ("2026-02-15", False, "春节假期"), ("2026-02-28", True, "春节调休上班"),
    ("2026-09-20", True, "国庆节调休上班"), ("2026-10-07", False, "国庆节假期"), ("2026-10-10", True, "国庆节调休上班"),
    ("2026-10-11", False, "周末"), ("2026-10-12", True, "工作日"), ("2025-10-06", False, "国庆节、中秋节假期"),
    ("2025-10-11", True, "国庆节、中秋节调休上班"),
])
def test_day_kind(day, work, label):
    assert workday_calc_tools.day_kind(D(day)) == (work, label)


def test_count_october_2026_and_whole_year():
    text = workday_calc_tools.count_between("2026-10-01", "2026-10-31")
    assert "工作日 **18 天**" in text and "国庆节 7 天" in text and "2026年10月10日（周六）" in text
    year = workday_calc_tools.count_between("2026-12-31", "2026-01-01")      # 起止颠倒也能算
    assert "工作日 **248 天**" in year and "调换" in year and "⚠️" not in year


def test_add_workdays_skips_holidays_and_counts_makeup_days():
    assert "2026年10月8日（周四）" in workday_calc_tools.add_days("2026-09-30", 1)
    assert "2026年2月14日（周六）" in workday_calc_tools.add_days("2026-02-13", 1)
    assert "2026年2月24日（周二）" in workday_calc_tools.add_days("2026-02-14", 1)
    assert "2026年9月28日（周一）" in workday_calc_tools.add_days("2026-10-08", -3)
    assert "2026年10月31日（周六）" in workday_calc_tools.add_days("2026-10-01", 30, workdays_only=False)


def test_unknown_years_are_flagged_and_inputs_checked():
    assert "2027 年的放假安排还没公布" in workday_calc_tools.add_days("2026-12-25", 10)
    assert "还没公布" in workday_calc_tools.holidays_report(2027)
    assert "没有收录" in workday_calc_tools.holidays_report(2020)
    assert "YYYY-MM-DD" in workday_calc_tools.count_between("下周一", "2026-10-31")
    assert workday_calc_tools.parse_date("2026年10月8日") == D("2026-10-08")
    assert workday_calc_tools.parse_date("2026-02-30") is None
    assert "10 年" in workday_calc_tools.count_between("2000-01-01", "2026-01-01")
    assert "3650" in workday_calc_tools.add_days("2026-01-01", 5000)
    assert "超出范围" in workday_calc_tools.add_days("9999-12-30", 10)


def test_tools_invoke():
    out = workday_calc_tools.workday_calc_holidays.invoke({"year": 2026})
    assert "春节：2月15日（周日）至 2月23日（周一）放假，共 9 天；2月14日（周六）、2月28日（周六）上班" in out
    assert "国办发明电〔2025〕7号" in out
    out = workday_calc_tools.workday_calc_count.invoke({"start": "2026-10-08", "end": "2026-10-10"})
    assert "工作日 **3 天**" in out
    out = workday_calc_tools.workday_calc_add.invoke({"start": "2026-09-30", "days": 1})
    assert "2026年10月8日" in out
