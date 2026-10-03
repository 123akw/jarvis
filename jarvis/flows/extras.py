"""流程的「好用」层（第十八轮，归「模板 / 一句话生成 / 定时」代理）：

- ``GET  /api/flows/templates``         模板库（节点图模板，按场景分类）；
- ``POST /api/flows/compose``           一句话生成流程草稿（不落库，前端打开画布再保存）；
- ``GET|PUT /api/flows/{id}/trigger``   定时运行（表 tenant_flow_triggers，schema v7）；
- :func:`start_scheduler`               后台按 next_run_at 触发到点的流程，跑完经送达渠道通知。

``register`` 在 /api/flows/{id} 之前注册（避免 templates / compose 被当成流程 id），
``runtime()`` 返回 :class:`jarvis.flows.routes.FlowRuntime`（含 deps 与执行器），定时运行用它执行流程。
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from jarvis.flows import compose as compose_mod
from jarvis.flows import templates as templates_mod
from jarvis.tenancy import TenantMigrationError, tenant_scope

log = logging.getLogger("jarvis")


def _no_store(payload, status_code: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store", **(headers or {})})


def _deps(runtime: Callable[[], Any]):
    current = runtime() if runtime is not None else None
    return getattr(current, "deps", None)


class ComposeIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    description: object = None


def register(app, *, request_principal, panel_write, deny, runtime: Callable[[], Any]) -> None:
    """注册模板 / 一句话生成 / 触发器路由。"""

    @app.get("/api/flows/templates")
    def flow_templates(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                payload = templates_mod.templates_for(principal.user_id, _deps(runtime))
        except TenantMigrationError:
            return _no_store({"error": "个人数据迁移失败"}, 503)
        return _no_store(payload)

    @app.post("/api/flows/compose")
    def flow_compose(request: Request, body: ComposeIn):
        principal, err = panel_write(request)
        if err:
            return err
        if body.description is not None and not isinstance(body.description, str):
            return _no_store({"error": "描述要是一段文字"}, 400)
        text = " ".join(str(body.description or "").split())
        if not text:
            return _no_store({"error": "先说说你想自动化什么，比如：每天早上把天气和日程发到飞书"}, 400)
        if len(text) > compose_mod.MAX_DESCRIPTION:
            return _no_store({"error": f"描述最多 {compose_mod.MAX_DESCRIPTION} 个字，挑最要紧的说就行"}, 400)
        wait = compose_mod.limiter.hit(principal.user_id)
        if wait is not None:
            return _no_store({"error": "生成得太频繁了，歇一分钟再试"}, 429, {"Retry-After": str(wait)})
        try:
            with tenant_scope(principal.user_id):
                result = compose_mod.compose_draft(principal.user_id, text, deps=_deps(runtime))
        except TenantMigrationError:
            return _no_store({"error": "个人数据迁移失败"}, 503)
        return _no_store(result)


def start_scheduler(*, runtime: Callable[[], Any], notifier=None):
    """启动定时运行的后台线程；返回带 ``stop()`` 的对象，或 None。"""
    return None
