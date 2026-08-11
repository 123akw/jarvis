"""备忘类工具：增、查、删，落盘 data/memos.json。"""
import datetime
import json

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from jarvis.config import data_dir


class MemoAddArgs(BaseModel):
    content: str = Field(description="备忘内容原文，保留领导原话要点，如「周三交电费」")


class MemoDelArgs(BaseModel):
    memo_id: int = Field(ge=1, description="要删除的备忘编号（memo_list 返回的行首数字）")


def _load_memos() -> list[dict]:
    p = data_dir() / "memos.json"
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))


def _save_memos(memos: list[dict]) -> None:
    (data_dir() / "memos.json").write_text(
        json.dumps(memos, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def all_memos() -> list[dict]:
    """给网页仪表盘用的原始数据出口。"""
    return _load_memos()


@tool(args_schema=MemoAddArgs)
def memo_add(content: str) -> str:
    """记下一条备忘信息。适用于「记住/记一下」这类无时间点的随手记；
    有明确时间点的安排用 schedule_add，要办的事项用 todo_add。"""
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


@tool(args_schema=MemoDelArgs)
def memo_del(memo_id: int) -> str:
    """按编号删除一条备忘。编号不确定时先调 memo_list 查看。"""
    memos = _load_memos()
    kept = [m for m in memos if m["id"] != memo_id]
    if len(kept) == len(memos):
        return f"没找到编号 {memo_id} 的备忘。"
    _save_memos(kept)
    return f"已删除编号 {memo_id} 的备忘。"
