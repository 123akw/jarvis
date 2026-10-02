"""时间类工具。"""
import datetime

from langchain_core.tools import tool

_WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


@tool
def now() -> str:
    """查询精确到秒的当前日期、时间和星期几。
    通常不需要：每轮消息前的「此刻」已给出当前日期、星期和时间，换算「明天」「下周三」直接用它；
    只有领导要精确到秒，或怀疑时间有误时才调用。"""
    t = datetime.datetime.now()
    return t.strftime("%Y-%m-%d %H:%M:%S ") + _WEEKDAYS[t.weekday()]
