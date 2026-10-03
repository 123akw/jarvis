"""关键动作同意（第二十一轮，归「同意与活动记录」代理；契约 §6）。

原则（参考 Meta Muse）：能撤回的动作直接做（查、记、加待办……）；**难撤回的动作**（替你发消息 / 发邮件给别人、
删除数据、对外发布、花钱）先停下，用**界面原生的同意卡**（不是模型写的文字）请用户确认，可改内容后同意。
实现用 LangGraph 的 interrupt：危险工具执行前 interrupt，前台对话把同意卡推给页面，后台任务停在 waiting；
用户决定后用 Command(resume=…) 接着跑。所有决定写进活动记录。

地基只放空实现，下面的导出签名不变。
"""
from __future__ import annotations

RISKS = ("read", "write", "send", "delete", "spend")   # 只有 send / delete / spend 需要同意


def risk_of(tool_name: str) -> str:
    """工具的风险等级（地基：一律 read）。"""
    return "read"


def needs_consent(tool_name: str) -> bool:
    return risk_of(tool_name) in ("send", "delete", "spend")


def guard_tools(tools: list, *, user_id: str) -> list:
    """给需要同意的工具包一层「先确认再执行」（地基原样返回）。"""
    return tools


def register(app, *, request_principal, panel_write, deny, bundle_for, notifier=None) -> None:
    """注册 /api/consents*（地基为空实现）。"""
    return None
