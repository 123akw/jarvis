"""贾维斯的本地工具。任务1阶段仅为空壳，任务2填实现。"""
from langchain_core.tools import tool


@tool
def now() -> str:
    """查询当前的日期、时间和星期几。"""
    raise NotImplementedError


@tool
def memo_add(content: str) -> str:
    """新增一条备忘，content 是备忘内容。"""
    raise NotImplementedError


@tool
def memo_list() -> str:
    """列出所有备忘及其编号。"""
    raise NotImplementedError


@tool
def memo_del(memo_id: int) -> str:
    """按编号删除一条备忘。"""
    raise NotImplementedError


@tool
def sys_query(command: str) -> str:
    """执行只读系统查询，仅允许：date、uptime、df -h、ls。"""
    raise NotImplementedError


TOOLS = [now, memo_add, memo_list, memo_del, sys_query]
