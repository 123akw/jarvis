"""飞书（Feishu/Lark）机器人渠道：单聊或群里 @机器人 即可与贾维斯对话。

server.py 只需三处挂钩：lifespan 里 ``start()`` / ``shutdown()``，模块级 ``register(app, ...)``。
未配置 FEISHU_APP_ID / FEISHU_APP_SECRET 时整条渠道保持 disabled，不起线程、不联网。
"""
from __future__ import annotations

from jarvis.channels.feishu.bridge import FeishuBridge, FeishuSettings
from jarvis.channels.feishu.routes import register_routes

_bridge = FeishuBridge()


def get_bridge() -> FeishuBridge:
    return _bridge


def register(app, *, bundle_for, chunk_text, tenant_store, accounts,
             request_principal, write_authorized, deny, csrf_deny, quick_reply=None) -> None:
    """注入 Agent/账户依赖并挂上 /api/feishu/* 路由（不启动连接）。"""
    _bridge.configure(bundle_for=bundle_for, chunk_text=chunk_text,
                      tenant_store=tenant_store, accounts=accounts, quick_reply=quick_reply)
    register_routes(app, _bridge, request_principal=request_principal,
                    write_authorized=write_authorized, deny=deny, csrf_deny=csrf_deny)


def start() -> dict:
    """lifespan 启动挂钩：有凭据才建长连接（后台线程，立即返回）。"""
    return _bridge.start()


def shutdown() -> None:
    _bridge.shutdown()


def status() -> dict:
    return _bridge.status()


def push_text(user_id: str, text: str) -> bool:
    """主动私聊推送给该账号绑定的飞书身份；渠道未启用或未绑定返回 False。"""
    return _bridge.push_text(user_id, text)


def push_ready(user_id: str) -> bool:
    return _bridge.push_ready(user_id)


def bound_users() -> list[str]:
    return _bridge.bound_users()


def doc_target(user_id: str):
    """流程「汇总到飞书文档」用：(FeishuAPI, open_ids) 或 None。"""
    return _bridge.doc_target(user_id)


__all__ = ["FeishuBridge", "FeishuSettings", "bound_users", "doc_target", "get_bridge", "push_ready", "push_text",
           "register", "shutdown", "start", "status"]
