"""待办类工具：增、列表、勾完成，落盘 data/todos.json。"""
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from jarvis.tenancy import TenantStore


class TodoAddArgs(BaseModel):
    content: str = Field(description="待办事项内容，如「给车做保养」")


class TodoDoneArgs(BaseModel):
    todo_id: int = Field(ge=1, description="要勾掉的待办编号（todo_list 返回的行首数字）")


def all_todos() -> list[dict]:
    """给网页仪表盘用的原始数据出口。"""
    return TenantStore().list_todos()


@tool(args_schema=TodoAddArgs)
def todo_add(content: str) -> str:
    """新增一条要办的事项（无具体时间点）。有明确时间点的用 schedule_add。"""
    tid = TenantStore().add_todo(content)["id"]
    return f"待办已加入（编号 {tid}）：{content}"


@tool
def todo_list() -> str:
    """列出待办事项：未完成的逐条列出，已完成的报数量。"""
    items = all_todos()
    pending = [x for x in items if not x["done"]]
    done = len(items) - len(pending)
    if not items:
        return "待办清单是空的。"
    lines = [f"{x['id']}. {x['content']}" for x in pending] or ["未完成：无"]
    return "\n".join(lines) + f"\n（已完成 {done} 条）"


@tool(args_schema=TodoDoneArgs)
def todo_done(todo_id: int) -> str:
    """领导说某件事办完了时，按编号把待办勾成已完成。编号不确定先调 todo_list。"""
    found, was_done, content = TenantStore().mark_todo_done(todo_id)
    if not found:
        return f"没找到编号 {todo_id} 的待办。"
    if was_done:
        return f"编号 {todo_id} 早已完成。"
    return f"已完成勾掉（编号 {todo_id}）：{content}"
