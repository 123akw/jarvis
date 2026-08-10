"""系统查询工具：只读、白名单外一律拒绝。"""
import shlex
import subprocess

from langchain_core.tools import tool

_WHITELIST = {"date", "uptime", "df -h", "ls"}


@tool
def sys_query(command: str) -> str:
    """执行只读系统查询，仅允许：date、uptime、df -h、ls。"""
    cmd = command.strip()
    if cmd not in _WHITELIST:
        return f"已拒绝执行「{command}」：不在白名单（date、uptime、df -h、ls）内。"
    out = subprocess.run(shlex.split(cmd), capture_output=True, text=True, timeout=10)
    return out.stdout or out.stderr or "（无输出）"
