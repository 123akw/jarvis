"""日程类工具：带时间的安排，增、查、删，落盘 data/schedule.json。"""
import datetime
import json

from langchain_core.tools import tool

from jarvis.config import data_dir

_FMT = "%Y-%m-%d %H:%M"


def _load() -> list[dict]:
    p = data_dir() / "schedule.json"
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))


def _save(items: list[dict]) -> None:
    (data_dir() / "schedule.json").write_text(
        json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def all_schedule() -> list[dict]:
    """给网页仪表盘用的原始数据出口，按时间排序。"""
    return sorted(_load(), key=lambda x: x["when"])


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


@tool
def schedule_add(title: str, when: str) -> str:
    """新增一条日程。title 是事项，when 必须是「YYYY-MM-DD HH:MM」格式的具体时间；
    用户说「明天」「周三」这类相对时间时，先用 now 工具确认今天日期再换算。"""
    try:
        datetime.datetime.strptime(when, _FMT)
    except ValueError:
        return f"时间「{when}」不合法，需要 YYYY-MM-DD HH:MM 格式，例如 2026-08-12 09:00。"
    items = _load()
    sid = max((x["id"] for x in items), default=0) + 1
    items.append({"id": sid, "title": title, "when": when})
    _save(items)
    return f"日程已安排（编号 {sid}）：{when} {title}"


@tool
def schedule_list() -> str:
    """按时间列出全部日程，含编号；今天和明天的会特别标出。"""
    items = all_schedule()
    if not items:
        return "日程表是空的。"
    return "\n".join(f"{x['id']}. {x['when']} {x['title']} {_tag(x['when'])}".rstrip()
                     for x in items)


@tool
def schedule_del(schedule_id: int) -> str:
    """按编号删除一条日程。"""
    items = _load()
    kept = [x for x in items if x["id"] != schedule_id]
    if len(kept) == len(items):
        return f"没找到编号 {schedule_id} 的日程。"
    _save(kept)
    return f"已删除编号 {schedule_id} 的日程。"
