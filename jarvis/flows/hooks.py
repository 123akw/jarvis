"""流程的消息触发与链接触发（第二十轮，归「对话与触发」代理；契约 §4）。

- 消息触发：飞书 / 微信收到的消息命中某流程设的触发词（或「全部消息」）时，交给该流程跑，结果回复到原会话；
  渠道在把消息交给对话前调 :func:`handle_message`，返回回复文字表示已由流程处理，None 表示照常对话。
- 链接触发：``POST /api/hooks/{token}``（公开、按令牌限流）用 JSON 输入跑流程；令牌只在创建 / 重置时明文给一次。
- 设置：``GET /api/flows/{id}/hooks``、``PUT /api/flows/{id}/hooks/message``、
  ``POST|DELETE /api/flows/{id}/hooks/webhook``。

地基只放空实现。
"""
from __future__ import annotations


def register(app, *, request_principal, panel_write, deny, runtime) -> None:
    return None


def handle_message(user_id: str, channel: str, text: str, *, attachments=None) -> str | None:
    """渠道消息先问一下这里：命中消息触发就跑流程并返回要回复的文字；没命中返回 None（照常对话）。"""
    return None
