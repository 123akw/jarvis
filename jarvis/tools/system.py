"""系统查询工具：只读、白名单外一律拒绝。"""
import shlex
import subprocess

from langchain_core.tools import tool
from pydantic import BaseModel, Field

_WHITELIST = {"date", "uptime", "df -h", "ls"}


class SysQueryArgs(BaseModel):
    command: str = Field(description="只读系统命令，只接受这四个原样字符串之一："
                                     "「date」「uptime」「df -h」「ls」，其余一律被拒绝")


@tool(args_schema=SysQueryArgs)
def sys_query(command: str) -> str:
    """查询服务器本机状态（时间、运行时长、磁盘、目录）。仅限白名单四条命令，
    不能执行任何其他 shell 操作。"""
    cmd = command.strip()
    if cmd not in _WHITELIST:
        return f"已拒绝执行「{command}」：不在白名单（date、uptime、df -h、ls）内。"
    out = subprocess.run(shlex.split(cmd), capture_output=True, text=True, timeout=10)
    return out.stdout or out.stderr or "（无输出）"
