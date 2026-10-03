"""流程的「好用」层（第十八轮，归「模板 / 一句话生成 / 定时」代理）：

- ``GET  /api/flows/templates``         模板库（节点图模板，按场景分类）；
- ``POST /api/flows/compose``           一句话生成流程草稿（不落库，前端打开画布再保存）；
- ``GET|PUT /api/flows/{id}/trigger``   定时运行（表 tenant_flow_triggers，schema v7）；
- :func:`start_scheduler`               后台按 next_run_at 触发到点的流程，跑完经送达渠道通知。

地基只放空实现：``register`` 在 /api/flows/{id} 之前注册（避免 templates / compose 被当成流程 id），
``runtime()`` 返回 :class:`jarvis.flows.routes.FlowRuntime`（含 deps 与执行器），定时运行用它执行流程。
"""
from __future__ import annotations

from typing import Any, Callable


def register(app, *, request_principal, panel_write, deny, runtime: Callable[[], Any]) -> None:
    """注册模板 / 一句话生成 / 触发器路由（地基为空实现）。"""
    return None


def start_scheduler(*, runtime: Callable[[], Any], notifier=None):
    """启动定时运行的后台线程；返回带 ``stop()`` 的对象，或 None（地基为空实现）。"""
    return None
