"""待办类工具：增、列表、勾完成，落盘 data/todos.json。"""
import datetime
import json

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from jarvis.config import data_dir


class TodoAddArgs(BaseModel):
    content: str = Field(description="待办事项内容，如「给车做保养」")


class TodoDoneArgs(BaseModel):
    todo_id: int = Field(ge=1, description="要勾掉的待办编号（todo_list 返回的行首数字）")


def _load() -> list[dict]:
    p = data_dir() / "todos.json"
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))


def _save(items: list[dict]) -> None:
    (data_dir() / "todos.json").write_text(
        json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def all_todos() -> list[dict]:
    """给网页仪表盘用的原始数据出口。"""
    return _load()


@tool(args_schema=TodoAddArgs)
def todo_add(content: str) -> str:
    """新增一条要办的事项（无具体时间点）。有明确时间点的用 schedule_add。"""
    items = _load()
    tid = max((x["id"] for x in items), default=0) + 1
    items.append({
        "id": tid, "content": content, "done": False,
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
    })
    _save(items)
    return f"待办已加入（编号 {tid}）：{content}"


@tool
def todo_list() -> str:
    """列出待办事项：未完成的逐条列出，已完成的报数量。"""
    items = _load()
    pending = [x for x in items if not x["done"]]
    done = len(items) - len(pending)
    if not items:
        return "待办清单是空的。"
    lines = [f"{x['id']}. {x['content']}" for x in pending] or ["未完成：无"]
    return "\n".join(lines) + f"\n（已完成 {done} 条）"


@tool(args_schema=TodoDoneArgs)
def todo_done(todo_id: int) -> str:
    """领导说某件事办完了时，按编号把待办勾成已完成。编号不确定先调 todo_list。"""
    items = _load()
    for x in items:
        if x["id"] == todo_id:
            if x["done"]:
                return f"编号 {todo_id} 早已完成。"
            x["done"] = True
            _save(items)
            return f"已完成勾掉（编号 {todo_id}）：{x['content']}"
    return f"没找到编号 {todo_id} 的待办。"
