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
from typing import Annotated, Any, Callable

from fastapi import Path as PathParam, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from jarvis.flows import compose as compose_mod
from jarvis.flows import schedule as schedule_mod
from jarvis.flows import templates as templates_mod
from jarvis.tenancy import TenantMigrationError, tenant_scope

log = logging.getLogger("jarvis")

FlowId = Annotated[str, PathParam(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
NOT_FOUND = "没有找到这条流程"


def _no_store(payload, status_code: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store", **(headers or {})})


def _deps(runtime: Callable[[], Any]):
    current = runtime() if runtime is not None else None
    return getattr(current, "deps", None)


class ComposeIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    description: object = None


class TriggerIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    kind: object = None
    enabled: object = None
    schedule: object = None
    inputs: object = None
    notify: object = None


def _flow_store(runtime: Callable[[], Any]):
    """先走 server 的 _tenant_store 完成旧数据迁移，再碰流程表（与引擎的路由同一个入口）。"""
    current = runtime() if runtime is not None else None
    if current is not None and hasattr(current, "store"):
        return current.store()
    from jarvis.flows.store import FlowStore
    return FlowStore()


def _channels(user_id: str, deps) -> dict:
    """定时弹层的通知渠道：飞书没绑定时灰显并说明。"""
    ready = False
    try:
        ready = bool(deps.feishu_ready(user_id)) if deps is not None else False
    except Exception:
        ready = False
    return {"feishu": {"ready": ready, "reason": "" if ready else "还没绑定飞书，先到设置里绑定"},
            "desktop": {"ready": True, "reason": ""}}


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

    triggers = schedule_mod.TriggerStore()

    def trigger_payload(user_id: str, row) -> dict:
        return {"trigger": schedule_mod.view(row), "channels": _channels(user_id, _deps(runtime))}

    @app.get("/api/flows/{flow_id}/trigger")
    def flow_trigger_get(request: Request, flow_id: FlowId):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                if _flow_store(runtime).get_flow(principal.user_id, flow_id) is None:
                    return _no_store({"error": NOT_FOUND}, 404)
                row = triggers.get(principal.user_id, flow_id)
                payload = trigger_payload(principal.user_id, row)
        except TenantMigrationError:
            return _no_store({"error": "个人数据迁移失败"}, 503)
        return _no_store(payload)

    @app.put("/api/flows/{flow_id}/trigger")
    def flow_trigger_put(request: Request, flow_id: FlowId, body: TriggerIn):
        principal, err = panel_write(request)
        if err:
            return err
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                flow = _flow_store(runtime).get_flow(user_id, flow_id)
                if flow is None:
                    return _no_store({"error": NOT_FOUND}, 404)
                previous = triggers.get(user_id, flow_id)
                try:
                    settings = schedule_mod.normalize(body.model_dump(),
                                                      schedule_mod.settings_of(previous) if previous else None)
                    settings = schedule_mod.check_inputs(settings, flow.get("graph") or {})
                except schedule_mod.TriggerError as exc:
                    return _no_store({"error": str(exc)}, 400)
                try:
                    from jarvis.platforms import public_base_url
                    origin = public_base_url(request)
                except Exception:
                    origin = ""
                row = schedule_mod.apply(triggers, user_id, flow_id, settings, origin=origin)
                payload = trigger_payload(user_id, row)
        except TenantMigrationError:
            return _no_store({"error": "个人数据迁移失败"}, 503)
        return _no_store(payload)


def start_scheduler(*, runtime: Callable[[], Any], notifier=None):
    """启动定时运行的后台线程（server.py 的 lifespan 调）；返回带 ``stop()`` 的调度器。"""
    return schedule_mod.FlowScheduler(runtime=runtime, notifier=notifier).start()
