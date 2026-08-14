"""长期记忆画像工具：关于领导本人的稳定事实（偏好/习惯/背景），跨会话生效。

与 memo（随手记的信息）不同：画像条目会注入每轮对话的系统提示词，
让贾维斯在任何会话里都「记得领导是谁」；网页端「记忆」面板可查可删。
"""
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from jarvis.tenancy import TenantStore


class ProfileRememberArgs(BaseModel):
    fact: str = Field(description="一句话画像，如「领导喝咖啡只喝美式」「领导在深圳做后端开发」；"
                                  "必须是长期稳定的事实，不是一次性的待办或日程")


class ProfileForgetArgs(BaseModel):
    profile_id: int = Field(ge=1, description="要忘记的画像编号（profile_list 返回的行首数字）")


def all_profile() -> list[dict]:
    """给网页「记忆」面板用的原始数据出口。"""
    return TenantStore().list_profile()


@tool(args_schema=ProfileRememberArgs)
def profile_remember(fact: str) -> str:
    """记住一条关于领导的长期画像（称呼偏好、饮食习惯、工作背景、家人朋友等稳定事实）。
    领导明确说「记住我…」，或聊天中透露了稳定的个人信息/偏好时使用；
    一次性的事项应该用 memo/todo/schedule，不要存进画像。"""
    item = TenantStore().add_profile(fact)
    if item["existed"]:
        return f"这条我已经记着了（编号 {item['id']}）：{item['content']}"
    return f"记住了（编号 {item['id']}）：{item['content']}"


@tool
def profile_list() -> str:
    """列出记住的关于领导的全部长期画像条目，带编号。领导问「你记得我什么」时使用。"""
    items = all_profile()
    if not items:
        return "还没有记住关于领导的长期画像。"
    return "\n".join(f"{x['id']}. {x['content']}" for x in items)


@tool(args_schema=ProfileForgetArgs)
def profile_forget(profile_id: int) -> str:
    """忘记一条长期画像。领导说「忘记/别记着 XX」时先 profile_list 找到编号再删。"""
    if TenantStore().delete_profile(profile_id):
        return f"已忘记编号 {profile_id} 的画像。"
    return f"没有编号 {profile_id} 的画像。"
