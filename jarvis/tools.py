"""贾维斯的本地工具：查时间、备忘增查删、白名单系统查询。"""
import datetime
import json
import os
import shlex
import subprocess
from pathlib import Path

from langchain_core.tools import tool

_ROOT = Path(__file__).resolve().parent.parent
_WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
_WHITELIST = {"date", "uptime", "df -h", "ls"}


def _data_dir() -> Path:
    d = Path(os.getenv("JARVIS_DATA_DIR", str(_ROOT / "data")))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load_memos() -> list[dict]:
    p = _data_dir() / "memos.json"
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))


def _save_memos(memos: list[dict]) -> None:
    (_data_dir() / "memos.json").write_text(
        json.dumps(memos, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@tool
def now() -> str:
    """查询当前的日期、时间和星期几。"""
    t = datetime.datetime.now()
    return t.strftime("%Y-%m-%d %H:%M:%S ") + _WEEKDAYS[t.weekday()]


@tool
def memo_add(content: str) -> str:
    """新增一条备忘，content 是备忘内容。"""
    memos = _load_memos()
    memo_id = max((m["id"] for m in memos), default=0) + 1
    memos.append({
        "id": memo_id,
        "content": content,
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
    })
    _save_memos(memos)
    return f"已记下（编号 {memo_id}）：{content}"


@tool
def memo_list() -> str:
    """列出所有备忘及其编号。"""
    memos = _load_memos()
    if not memos:
        return "备忘录是空的。"
    return "\n".join(f"{m['id']}. {m['content']}" for m in memos)


@tool
def memo_del(memo_id: int) -> str:
    """按编号删除一条备忘。"""
    memos = _load_memos()
    kept = [m for m in memos if m["id"] != memo_id]
    if len(kept) == len(memos):
        return f"没找到编号 {memo_id} 的备忘。"
    _save_memos(kept)
    return f"已删除编号 {memo_id} 的备忘。"


@tool
def sys_query(command: str) -> str:
    """执行只读系统查询，仅允许：date、uptime、df -h、ls。"""
    cmd = command.strip()
    if cmd not in _WHITELIST:
        return f"已拒绝执行「{command}」：不在白名单（date、uptime、df -h、ls）内。"
    out = subprocess.run(shlex.split(cmd), capture_output=True, text=True, timeout=10)
    return out.stdout or out.stderr or "（无输出）"


TOOLS = [now, memo_add, memo_list, memo_del, sys_query]
