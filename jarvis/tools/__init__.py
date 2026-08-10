"""工具注册处。新增工具：在本包里建模块，把工具函数加进 TOOLS 即完成接入。

对外导出路径保持 `from jarvis.tools import ...`，与测试和历史代码兼容。
"""
from jarvis.tools.calc import calc
from jarvis.tools.clock import now
from jarvis.tools.memo import memo_add, memo_del, memo_list
from jarvis.tools.schedule import schedule_add, schedule_del, schedule_list
from jarvis.tools.system import sys_query
from jarvis.tools.todo import todo_add, todo_done, todo_list
from jarvis.tools.weather import weather

TOOLS = [
    now, calc, weather,
    memo_add, memo_list, memo_del,
    schedule_add, schedule_list, schedule_del,
    todo_add, todo_list, todo_done,
    sys_query,
]

__all__ = [
    "TOOLS", "now", "calc", "weather",
    "memo_add", "memo_list", "memo_del",
    "schedule_add", "schedule_list", "schedule_del",
    "todo_add", "todo_list", "todo_done",
    "sys_query",
]
