"""工具注册处。新增工具：在本包里建模块，把工具函数加进 TOOLS 即完成接入。

对外导出路径保持 `from jarvis.tools import ...`，与测试和历史代码兼容。
"""
from jarvis.tools.clock import now
from jarvis.tools.memo import memo_add, memo_del, memo_list
from jarvis.tools.system import sys_query

TOOLS = [now, memo_add, memo_list, memo_del, sys_query]

__all__ = ["TOOLS", "now", "memo_add", "memo_list", "memo_del", "sys_query"]
