"""时间类工具。"""
import datetime

from langchain_core.tools import tool

_WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


@tool
def now() -> str:
    """查询当前的日期、时间和星期几。"""
    t = datetime.datetime.now()
    return t.strftime("%Y-%m-%d %H:%M:%S ") + _WEEKDAYS[t.weekday()]
