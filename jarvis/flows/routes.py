"""流程 API（契约 4.3）：CRUD、试运行 SSE、运行记录、公开结果页。

鉴权沿用 server.py 的写法：读接口要登录，写接口要登录 + CSRF（panel_write）；
结果页（/api/r/<token>、/r/<token>）公开，只凭不可猜的 token 访问。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import PurePath
from typing import Annotated

from fastapi import Path as PathParam, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from jarvis.flows import engine, page as page_mod
from jarvis.flows.store import FlowLimitError, FlowStore, MAX_FLOWS
from jarvis.tenancy import TenantMigrationError, tenant_scope

log = logging.getLogger("jarvis")

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_RUN_TEXT = 50000
FlowId = Annotated[str, PathParam(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

_RUN_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="jarvis-flow")


class StepIn(BaseModel):
    plugin: str = Field(max_length=40)
    options: dict = Field(default_factory=dict)
    id: str | None = None


class FlowIn(BaseModel):
    name: str = Field(default="", max_length=200)
    summary: str | None = Field(default=None, max_length=200)
    steps: list[StepIn] = Field(default_factory=list, max_length=20)


class FileIn(BaseModel):
    name: str = Field(max_length=200)
    data_base64: str


class RunIn(BaseModel):
    text: str | None = Field(default=None, max_length=MAX_RUN_TEXT)
    file: FileIn | None = None


class FlowRuntime:
    """注册后留一份运行时（依赖、并发闸、存储工厂），测试可直接替换其中的 deps。"""

    def __init__(self, deps: engine.FlowDeps, store_factory=FlowStore, platform_lookup=None):
        self.deps = deps
        self.store_factory = store_factory
        self.guard = engine.RunGuard()
        self.platform_lookup = platform_lookup or platform_for_owner
        self.timeouts: dict[str, float] = {}
        self.total_seconds = engine.TOTAL_SECONDS


def platform_for_owner(owner_id: str) -> dict | None:
    """平台名与主题色：平台模块（jarvis/platforms.py）还没合进来或出错时返回 None。"""
    try:
        from jarvis.platforms import platform_for_user
    except ImportError:
        return None
    try:
        with tenant_scope(owner_id):
            found = platform_for_user(owner_id)
    except Exception as exc:
        log.warning("flow page platform lookup failed: %s", type(exc).__name__)
        return None
    return found if isinstance(found, dict) else None


def stream_events(produce):
    """produce(emit, cancel) 在独立线程里跑；客户端断开时置位 cancel，执行器随即停下。"""

    async def event_stream():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        finished = object()
        cancel = threading.Event()

        def emit(event: dict) -> None:
            data = f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            try:
                loop.call_soon_threadsafe(queue.put_nowait, data)
            except RuntimeError:
                cancel.set()   # 事件循环已关：没人在听了

        def work():
            try:
                produce(emit, cancel)
            except Exception as exc:
                log.exception("flow run crashed: %s", type(exc).__name__)
            finally:
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, finished)
                except RuntimeError:
                    pass

        _RUN_POOL.submit(work)
        try:
            while True:
                item = await queue.get()
                if item is finished:
                    return
                yield item
        finally:
            cancel.set()

    return event_stream()


def register(app, *, request_principal, panel_write, deny, deps: engine.FlowDeps,
             store_factory=FlowStore) -> FlowRuntime:
    runtime = FlowRuntime(deps, store_factory)

    def no_store(payload, status_code: int = 200) -> JSONResponse:
        return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store"})

    def migration_failed() -> JSONResponse:
        return no_store({"error": "个人数据迁移失败"}, 503)

    def flow_view(flow: dict, last_run: dict | None) -> dict:
        return {"id": flow["id"], "name": flow["name"], "summary": flow["summary"], "steps": flow["steps"],
                "updated_at": flow["updated_at"], "last_run": last_run}

    def store() -> FlowStore:
        runtime.deps.tenant_store()   # 走 server 的 _tenant_store：先完成旧数据迁移再碰新表
        return runtime.store_factory()

    @app.get("/api/flows")
    def flows_list(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                s = store()
                flows, last = s.list_flows(principal.user_id), s.last_runs(principal.user_id)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"flows": [flow_view(f, last.get(f["id"])) for f in flows]})

    def save(request: Request, body: FlowIn, flow_id: str | None):
        principal, err = panel_write(request)
        if err:
            return err
        try:
            clean = engine.normalize_flow(body.name, [s.model_dump() for s in body.steps], body.summary)
        except engine.FlowValidationError as exc:
            return no_store({"error": str(exc)}, 422)
        try:
            with tenant_scope(principal.user_id):
                s = store()
                if flow_id is None:
                    flow = s.create_flow(principal.user_id, **clean)
                else:
                    flow = s.update_flow(principal.user_id, flow_id, **clean)
                    if flow is None:
                        return no_store({"error": "没有找到这条流程"}, 404)
                last = s.last_runs(principal.user_id).get(flow["id"])
        except FlowLimitError:
            return no_store({"error": f"最多保存 {MAX_FLOWS} 条流程，先删掉几条不用的"}, 409)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"flow": flow_view(flow, last)}, 201 if flow_id is None else 200)

    @app.post("/api/flows")
    def flows_create(request: Request, body: FlowIn):
        return save(request, body, None)

    @app.put("/api/flows/{flow_id}")
    def flows_update(request: Request, flow_id: FlowId, body: FlowIn):
        return save(request, body, flow_id)

    @app.delete("/api/flows/{flow_id}")
    def flows_delete(request: Request, flow_id: FlowId):
        principal, err = panel_write(request)
        if err:
            return err
        try:
            with tenant_scope(principal.user_id):
                found = store().delete_flow(principal.user_id, flow_id)
        except TenantMigrationError:
            return migration_failed()
        if not found:
            return no_store({"error": "没有找到这条流程"}, 404)
        return no_store({"ok": True})

    @app.get("/api/flows/{flow_id}/runs")
    def flows_runs(request: Request, flow_id: FlowId, limit: int = 10):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                s = store()
                if s.get_flow(principal.user_id, flow_id) is None:
                    return no_store({"error": "没有找到这条流程"}, 404)
                runs = s.list_runs(principal.user_id, flow_id, limit)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"runs": runs})

    @app.post("/api/flows/{flow_id}/run")
    def flows_run(request: Request, flow_id: FlowId, body: RunIn):
        principal, err = panel_write(request)
        if err:
            return err
        payload: dict = {"text": body.text or ""}
        input_info: dict = {"kind": "text", "chars": len((body.text or "").strip())}
        if body.file is not None:
            # 先按编码长度拦超限文件，免得为 30MB 的东西整段解码
            if len(body.file.data_base64) > (MAX_FILE_BYTES + 2) // 3 * 4 + 4:
                return no_store({"error": "文件超过 10MB 上限"}, 422)
            try:
                data = base64.b64decode(body.file.data_base64, validate=True)
            except Exception:
                return no_store({"error": "文件内容编码不合法"}, 422)
            if len(data) > MAX_FILE_BYTES:
                return no_store({"error": "文件超过 10MB 上限"}, 422)
            name = PurePath(body.file.name.replace("\\", "/")).name.strip() or "资料"
            payload["file"] = {"name": name, "data": data}
            input_info = {"kind": "file", "name": name[:80], "bytes": len(data)}
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                s = store()
                flow = s.get_flow(user_id, flow_id)
        except TenantMigrationError:
            return migration_failed()
        if flow is None:
            return no_store({"error": "没有找到这条流程"}, 404)
        try:   # 存进去时合法，但积木清单可能变过：开跑前再校验一遍
            flow = {**flow, "steps": engine.normalize_steps(flow["steps"])}
        except engine.FlowValidationError as exc:
            return no_store({"error": str(exc)}, 422)
        if not runtime.guard.acquire(user_id):
            return no_store({"error": "你有一条流程正在运行，等它跑完再试"}, 409)

        def produce(emit, cancel):
            try:
                with tenant_scope(user_id):
                    engine.execute(flow=flow, user_id=user_id, payload=payload, deps=runtime.deps, store=s,
                                   emit=emit, cancel=cancel, input_info=input_info,
                                   total_seconds=runtime.total_seconds, timeouts=runtime.timeouts)
            except Exception as exc:
                log.exception("flow run failed: %s", type(exc).__name__)
                emit({"type": "run_done", "status": "error", "output": None})
            finally:
                runtime.guard.release(user_id)

        return StreamingResponse(stream_events(produce), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    def lookup(token: str):
        if not _TOKEN.match(token):   # 手动校验：坏链接也要回「已过期」页面，而不是 422 JSON
            return None, None
        found = runtime.store_factory().get_page(token)
        if found is None:
            return None, None
        return found, runtime.platform_lookup(found["owner_id"])

    @app.get("/api/r/{token}")
    def result_json(token: str):
        try:
            found, platform = lookup(token)
        except TenantMigrationError:
            return migration_failed()
        if found is None:
            return no_store({"error": "这个结果页不存在或已过期"}, 404)
        info = page_mod.brand(platform)
        return JSONResponse({
            "token": found["token"], "title": found["title"], "text": found["text"], "links": found["links"],
            "created_at": found["created_at"], "expires_at": found["expires_at"],
            "platform": {"name": info["name"], "icon": info["icon"], "accent": info["accent"]},
        }, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"})

    @app.get("/r/{token}")
    def result_page(token: str):
        try:
            found, platform = lookup(token)
        except TenantMigrationError:
            found = platform = None
        if found is None:
            return HTMLResponse(page_mod.render_missing(), status_code=404, headers=page_mod.HEADERS)
        return HTMLResponse(page_mod.render_page(found, platform), headers=page_mod.HEADERS)

    return runtime
