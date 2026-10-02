"""日期与工作日计算：两个日期之间有几个工作日、往后 / 往前数 N 个工作日是哪天、某年怎么放假。纯标准库，不联网。

节假日数据来自国务院办公厅每年发布的「部分节假日安排的通知」（中国政府网原文，2026 年 10 月核实）：
- 2025 年：国办发明电〔2024〕12 号，2024 年 11 月 12 日发布
  https://www.gov.cn/zhengce/content/202411/content_6986382.htm
- 2026 年：国办发明电〔2025〕7 号，2025 年 11 月 4 日发布
  https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
2027 年的安排一般在 2026 年 11 月前后公布，公布后在 HOLIDAY_DATA 里加一年即可。
没收录的年份只按周末算，并在结果里提醒。
"""
from __future__ import annotations

import datetime as dt
import re

from langchain_core.tools import tool
from pydantic import BaseModel, Field

MAX_SPAN_DAYS = 3650          # 一次最多算 10 年左右
WEEKDAYS = "一二三四五六日"

# 每年：通知名称、文号、发布日期、原文链接；items = (节日, 放假首日, 放假末日, [调休上班日])
HOLIDAY_DATA: dict[int, dict] = {
    2025: {
        "notice": "国务院办公厅关于2025年部分节假日安排的通知",
        "number": "国办发明电〔2024〕12号", "published": "2024-11-12",
        "url": "https://www.gov.cn/zhengce/content/202411/content_6986382.htm",
        "items": [
            ("元旦", "2025-01-01", "2025-01-01", []),
            ("春节", "2025-01-28", "2025-02-04", ["2025-01-26", "2025-02-08"]),
            ("清明节", "2025-04-04", "2025-04-06", []),
            ("劳动节", "2025-05-01", "2025-05-05", ["2025-04-27"]),
            ("端午节", "2025-05-31", "2025-06-02", []),
            ("国庆节、中秋节", "2025-10-01", "2025-10-08", ["2025-09-28", "2025-10-11"]),
        ],
    },
    2026: {
        "notice": "国务院办公厅关于2026年部分节假日安排的通知",
        "number": "国办发明电〔2025〕7号", "published": "2025-11-04",
        "url": "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
        "items": [
            ("元旦", "2026-01-01", "2026-01-03", ["2026-01-04"]),
            ("春节", "2026-02-15", "2026-02-23", ["2026-02-14", "2026-02-28"]),
            ("清明节", "2026-04-04", "2026-04-06", []),
            ("劳动节", "2026-05-01", "2026-05-05", ["2026-05-09"]),
            ("端午节", "2026-06-19", "2026-06-21", []),
            ("中秋节", "2026-09-25", "2026-09-27", []),
            ("国庆节", "2026-10-01", "2026-10-07", ["2026-09-20", "2026-10-10"]),
        ],
    },
}


def _build_index() -> tuple[dict[dt.date, str], dict[dt.date, str]]:
    off, work = {}, {}
    for data in HOLIDAY_DATA.values():
        for name, first, last, makeups in data["items"]:
            day, end = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
            while day <= end:
                off[day] = name
                day += dt.timedelta(days=1)
            for makeup in makeups:
                work[dt.date.fromisoformat(makeup)] = name
    return off, work


HOLIDAYS, MAKEUP_WORKDAYS = _build_index()


def parse_date(text: str) -> dt.date | None:
    """认 2026-10-08 / 2026/10/8 / 2026.10.8 / 2026年10月8日；认不出返回 None。"""
    match = re.fullmatch(r"\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s*", str(text or ""))
    if not match:
        return None
    try:
        return dt.date(*(int(part) for part in match.groups()))
    except ValueError:
        return None


def label(day: dt.date) -> str:
    return f"{day.year}年{day.month}月{day.day}日（周{WEEKDAYS[day.weekday()]}）"


def day_kind(day: dt.date) -> tuple[bool, str]:
    """(是不是工作日, 说明)：法定假日 / 调休上班 / 周末 / 工作日。"""
    if day in HOLIDAYS:
        return False, f"{HOLIDAYS[day]}假期"
    if day in MAKEUP_WORKDAYS:
        return True, f"{MAKEUP_WORKDAYS[day]}调休上班"
    if day.weekday() >= 5:
        return False, "周末"
    return True, "工作日"


def is_workday(day: dt.date) -> bool:
    return day_kind(day)[0]


def _unknown_years(first: dt.date, last: dt.date) -> list[int]:
    return [year for year in range(first.year, last.year + 1) if year not in HOLIDAY_DATA]


def _year_note(years: list[int]) -> str:
    if not years:
        return ""
    known = max(HOLIDAY_DATA)
    later = [y for y in years if y > known]
    earlier = [y for y in years if y < min(HOLIDAY_DATA)]
    parts = []
    if later:
        parts.append(f"{'、'.join(map(str, later))} 年的放假安排还没公布或还没收录（国务院办公厅一般在前一年 11 月前后发布）")
    if earlier:
        parts.append(f"{'、'.join(map(str, earlier))} 年的放假安排没有收录")
    return "⚠️ " + "；".join(parts) + "，这几年只按周末算，没扣法定假日和调休，结果可能有出入。"


def _bad_date(text: str) -> str:
    return f"日期「{str(text)[:20]}」看不懂，请换算成 YYYY-MM-DD 格式再算，如 2026-10-08。"


def count_between(start: str, end: str) -> str:
    first, last = parse_date(start), parse_date(end)
    if first is None:
        return _bad_date(start)
    if last is None:
        return _bad_date(end)
    swapped = first > last
    if swapped:
        first, last = last, first
    span = (last - first).days
    if span > MAX_SPAN_DAYS:
        return "时间跨度太长了，一次最多算 10 年左右，分段再算吧。"
    workdays, weekend, makeups = 0, 0, []
    holiday_days: dict[str, int] = {}
    day = first
    while day <= last:
        work, _ = day_kind(day)
        if day in HOLIDAYS:
            holiday_days[HOLIDAYS[day]] = holiday_days.get(HOLIDAYS[day], 0) + 1
        elif day in MAKEUP_WORKDAYS:
            makeups.append(day)
        elif not work:
            weekend += 1
        workdays += work
        day += dt.timedelta(days=1)
    total = span + 1
    lines = [f"**{label(first)} 到 {label(last)}**" + ("（起止日期调换过来算了）" if swapped else ""),
             f"- 相隔 {span} 天，含首尾共 {total} 天",
             f"- 工作日 **{workdays} 天**（含首尾），休息日 {total - workdays} 天"]
    if holiday_days:
        lines.append("- 其中法定假日：" + "、".join(f"{name} {n} 天" for name, n in holiday_days.items())
                     + f"；普通周末 {weekend} 天")
    if makeups:
        lines.append("- 调休上班：" + "、".join(label(d) for d in makeups))
    for day in sorted({first, last}):
        lines.append(f"- {label(day)}是{day_kind(day)[1]}")
    note = _year_note(_unknown_years(first, last))
    if note:
        lines.append(note)
    return "\n".join(lines)


def add_days(start: str, days: int, workdays_only: bool = True) -> str:
    first = parse_date(start)
    if first is None:
        return _bad_date(start)
    if isinstance(days, bool) or not isinstance(days, int):
        return "天数要是整数，往后数填正数、往前数填负数。"
    if abs(days) > MAX_SPAN_DAYS:
        return "天数太多了，一次最多数 3650 天。"
    unit = "个工作日" if workdays_only else "天"
    direction = "往后" if days >= 0 else "往前"
    try:
        if not workdays_only:
            target = first + dt.timedelta(days=days)
        else:
            step = 1 if days >= 0 else -1
            target, left = first, abs(days)
            while left:
                target += dt.timedelta(days=step)
                if is_workday(target):
                    left -= 1
    except OverflowError:
        return "算出来的日期超出范围了。"
    span = (min(first, target), max(first, target))
    if days == 0:
        lines = [f"{label(first)} 当天，是{day_kind(first)[1]}。"]
    else:
        lines = [f"从 {label(first)} {direction}数 {abs(days)} {unit}（不含当天）是 **{label(target)}**，"
                 f"那天是{day_kind(target)[1]}。"]
        if workdays_only:
            natural = abs((target - first).days)
            lines.append(f"- 中间跨了 {natural} 个自然日，节假日、周末已跳过，调休上班日算工作日。")
        else:
            lines.append(f"- 按自然日算；那天{'要上班' if is_workday(target) else '不用上班'}。")
    note = _year_note(_unknown_years(*span))
    if note:
        lines.append(note)
    return "\n".join(lines)


def _range_text(first: dt.date, last: dt.date) -> str:
    if first == last:
        return f"{first.month}月{first.day}日（周{WEEKDAYS[first.weekday()]}）放假，共 1 天"
    days = (last - first).days + 1
    return (f"{first.month}月{first.day}日（周{WEEKDAYS[first.weekday()]}）至 {last.month}月{last.day}日"
            f"（周{WEEKDAYS[last.weekday()]}）放假，共 {days} 天")


def holidays_report(year: int) -> str:
    if isinstance(year, bool) or not isinstance(year, int):
        return "年份要是整数，如 2026。"
    data = HOLIDAY_DATA.get(year)
    if data is None:
        known = "、".join(str(y) for y in sorted(HOLIDAY_DATA))
        if year > max(HOLIDAY_DATA):
            return (f"{year} 年的放假安排还没公布或还没收录（国务院办公厅一般在前一年 11 月前后发布）。"
                    f"目前收录了 {known} 年；等通知出来以中国政府网为准。")
        return f"{year} 年的放假安排没有收录，目前收录了 {known} 年。"
    lines = [f"**{year} 年放假安排**"]
    for name, first, last, makeups in data["items"]:
        text = f"- {name}：{_range_text(dt.date.fromisoformat(first), dt.date.fromisoformat(last))}"
        if makeups:
            text += "；" + "、".join(f"{d.month}月{d.day}日（周{WEEKDAYS[d.weekday()]}）"
                                     for d in map(dt.date.fromisoformat, makeups)) + "上班"
        lines.append(text)
    lines.append(f"来源：{data['notice']}（{data['number']}，{data['published']} 发布）{data['url']}")
    return "\n".join(lines)


# ---------- 工具 ----------

class CountArgs(BaseModel):
    start: str = Field(description="开始日期，先换算成 YYYY-MM-DD，如 2026-10-08；「今天」先用 now 查出日期")
    end: str = Field(description="结束日期，YYYY-MM-DD，如 2026-10-31（含这一天）")


class AddArgs(BaseModel):
    start: str = Field(description="起算日期，YYYY-MM-DD，如 2026-09-30（不含当天）")
    days: int = Field(description="数几天：往后填正数，往前填负数，如 10 或 -5")
    workdays_only: bool = Field(default=True, description="true 只数工作日（跳过周末和法定假日）；false 按自然日")


class HolidaysArgs(BaseModel):
    year: int = Field(description="年份，如 2026")


@tool(args_schema=CountArgs)
def workday_calc_count(start: str, end: str) -> str:
    """算两个日期之间相隔几天、有几个工作日（自动扣周末和法定假日、算上调休上班日）。
    用户问「到月底还有几个工作日」「这两天之间隔了多少天」「这个月要上几天班」时使用，不要心算。日期先换算成 YYYY-MM-DD。"""
    return count_between(start, end)


@tool(args_schema=AddArgs)
def workday_calc_add(start: str, days: int, workdays_only: bool = True) -> str:
    """从某天起往后 / 往前数 N 个工作日（或自然日）是哪天、星期几，自动跳过节假日、算上调休。
    用户问「10 个工作日后是哪天」「合同签后 30 天是几号」「往前推 5 个工作日」时使用，不要心算。日期先换算成 YYYY-MM-DD。"""
    return add_days(start, days, workdays_only)


@tool(args_schema=HolidaysArgs)
def workday_calc_holidays(year: int) -> str:
    """列出某一年的法定节假日放假和调休上班安排（国务院办公厅通知原文）。
    用户问「今年国庆怎么放」「春节放几天，哪天补班」「明年放假安排出了吗」时使用，不要凭记忆回答。"""
    return holidays_report(year)


TOOLS = [workday_calc_count, workday_calc_add, workday_calc_holidays]
