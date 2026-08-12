"""备忘类工具：增、查、删，落盘 data/memos.json。"""
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from jarvis.tenancy import TenantStore


class MemoAddArgs(BaseModel):
    content: str = Field(description="备忘内容原文，保留领导原话要点，如「周三交电费」")


class MemoDelArgs(BaseModel):
    memo_id: int = Field(ge=1, description="要删除的备忘编号（memo_list 返回的行首数字）")


def all_memos() -> list[dict]:
    """给网页仪表盘用的原始数据出口。"""
    return TenantStore().list_memos()


@tool(args_schema=MemoAddArgs)
def memo_add(content: str) -> str:
    """记下一条备忘信息。适用于「记住/记一下」这类无时间点的随手记；
    有明确时间点的安排用 schedule_add，要办的事项用 todo_add。"""
    memo_id = TenantStore().add_memo(content)["id"]
    return f"已记下（编号 {memo_id}）：{content}"


@tool
def memo_list() -> str:
    """列出所有备忘及其编号。"""
    memos = all_memos()
    if not memos:
        return "备忘录是空的。"
    return "\n".join(f"{m['id']}. {m['content']}" for m in memos)


@tool(args_schema=MemoDelArgs)
def memo_del(memo_id: int) -> str:
    """按编号删除一条备忘。编号不确定时先调 memo_list 查看。"""
    if not TenantStore().delete_memo(memo_id):
        return f"没找到编号 {memo_id} 的备忘。"
    return f"已删除编号 {memo_id} 的备忘。"
