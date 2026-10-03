"""活动记录 / 审计轨迹（第二十一轮，归「同意与活动记录」代理；契约 §6）。

助理替你做过的每一件事（每次工具调用、每个同意 / 拒绝、每个后台任务的开始与结束）按账号记一条：
什么时候、在哪（对话 / 后台任务 / 自动化 / 渠道）、做了什么、结果如何、风险等级。用户在「活动记录」里随时能看。

地基只放空实现，下面的导出签名不变。
"""
from __future__ import annotations


def record(owner_id: str, *, kind: str, title: str, summary: str = "", tool: str = "", risk: str = "read",
           status: str = "ok", task_id: str | None = None, thread_id: str = "", detail: dict | None = None) -> None:
    """记一条活动（地基为空实现）。kind：tool / consent / task / automation / message。"""
    return None


def callbacks(owner_id: str, *, thread_id: str = "", task_id: str | None = None) -> list:
    """给 agent.invoke / stream 的 config['callbacks'] 用：自动把工具调用记进活动记录（地基返回空列表）。"""
    return []


def register(app, *, request_principal, panel_write, deny) -> None:
    """注册 GET /api/activity（地基为空实现）。"""
    return None
