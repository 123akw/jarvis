"""日程类工具：带时间的安排，增、查、删，落盘 data/schedule.json。"""
import datetime
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from jarvis.tenancy import MAX_ITEM_ID, TenantStore, canonical_when

_FMT = "%Y-%m-%d %H:%M"
_WEEKDAYS = "一二三四五六日"


class ScheduleAddArgs(BaseModel):
    title: str = Field(description="日程事项内容，简短写清做什么、和谁，如「和王总开会」「给客户回电话」")
    when: str = Field(description="24 小时制「YYYY-MM-DD HH:MM」，如 2026-08-12 15:30；"
                                  "「明天」「下周三」「40 分钟后」按「此刻」的当前时间换算后再填")


class ScheduleListArgs(BaseModel):
    include_past: bool = Field(default=False, description="默认只列今天及以后的日程；"
                                                          "要看或删更早的已过期日程时填 true")


class ScheduleDelArgs(BaseModel):
    schedule_id: int = Field(ge=1, le=MAX_ITEM_ID, description="要删除的日程编号（schedule_list 返回的行首数字）")


def all_schedule() -> list[dict]:
    """给网页仪表盘用的原始数据出口，按时间排序。"""
    return TenantStore().list_schedule()


def _tag(when: str) -> str:
    t = datetime.datetime.strptime(when, _FMT)
    today = datetime.date.today()
    if t.date() == today:
        return "【今天】" if t >= datetime.datetime.now() else "【今天·已过】"
    if t.date() < today:
        return "【已过期】"
    if t.date() == today + datetime.timedelta(days=1):
        return "【明天】"
    return ""


def _weekday(when: str) -> str:
    return "周" + _WEEKDAYS[datetime.datetime.strptime(when, _FMT).weekday()]


@tool(args_schema=ScheduleAddArgs)
def schedule_add(title: str, when: str) -> str:
    """新增一条有明确时间点的日程，到点会提醒领导（开会、约见、「几点提醒我做什么」）。
    没有时间点的事项用 todo_add，随手记的信息用 memo_add。回执带星期几，可据此核对换算。"""
    try:
        when = canonical_when(when)   # 补零入库，否则提醒扫描的字典序比较会错窗
    except ValueError:
        return (f"时间「{when}」不合法，没有保存。需要 24 小时制 YYYY-MM-DD HH:MM，"
                "例如 2026-08-12 09:00；请换算后重新调用。")
    title = " ".join(title.split())
    if not title:
        return "日程内容是空的，没有保存。请问领导要安排什么事。"
    sid = TenantStore().add_schedule(title, when)["id"]
    receipt = f"日程已安排（编号 {sid}）：{when}（{_weekday(when)}）{title}{_tag(when)}"
    if datetime.datetime.strptime(when, _FMT) < datetime.datetime.now():
        receipt += "\n注意：这个时间已经过去了，不会再提醒。若是日期算错了，删掉这条（schedule_del）后按正确时间重加。"
    return receipt


@tool(args_schema=ScheduleListArgs)
def schedule_list(include_past: bool = False) -> str:
    """按时间列出日程（含编号、星期，今天/明天会特别标出）。领导问「有什么安排」、
    要删改日程但不确定编号时使用。默认不列更早的已过期日程。"""
    items = all_schedule()
    if not items:
        return "日程表是空的。"
    today = datetime.date.today().strftime("%Y-%m-%d")
    shown = items if include_past else [x for x in items if x["when"][:10] >= today]
    hidden = len(items) - len(shown)
    lines = [f"{x['id']}. {x['when']}（{_weekday(x['when'])}）{x['title']} {_tag(x['when'])}".rstrip()
             for x in shown] or ["今天及以后没有日程。"]
    if hidden:
        lines.append(f"（另有 {hidden} 条更早的已过期日程未列出，需要时用 include_past=true 查看）")
    return "\n".join(lines)


@tool(args_schema=ScheduleDelArgs)
def schedule_del(schedule_id: int) -> str:
    """按编号删除一条日程。编号不确定时先调 schedule_list 核对，不要猜编号。"""
    if not TenantStore().delete_schedule(schedule_id):
        return f"没找到编号 {schedule_id} 的日程，可能已经删过了；先用 schedule_list 看看现有编号。"
    return f"已删除编号 {schedule_id} 的日程。"
