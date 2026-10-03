"""流程 API（第十八轮契约 §3.1–3.3）：CRUD、节点目录、试运行 SSE、运行记录、公开结果页。

鉴权沿用 server.py 的写法：读接口要登录，写接口要登录 + CSRF（panel_write）；
结果页（/api/r/<token>、/r/<token>）公开，只凭不可猜的 token 访问。
路由顺序：``/api/flows/nodes`` 在 ``/api/flows/{flow_id}`` 之前注册（templates / compose 由 extras 先注册）。
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
from typing import Annotated, Any

from fastapi import Path as PathParam, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from jarvis.flows import engine, executor, nodes as nodes_mod, page as page_mod
from jarvis.flows.graph import (MAX_FIELDS, GraphError, config_hashes, default_summary, graph_from_steps,
                                validate_graph)
from jarvis.flows.steps import clip
from jarvis.flows.store import FlowLimitError, FlowStore, MAX_FLOWS
from jarvis.tenancy import TenantMigrationError, tenant_scope

log = logging.getLogger("jarvis")

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_RUN_TEXT = 50000
MAX_SUMMARY = 60
FlowId = Annotated[str, PathParam(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_INPUT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
BUSY = "你有一条流程正在运行，等它跑完再试"
NOT_FOUND = "没有找到这条流程"

_RUN_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="jarvis-flow")


class StepIn(BaseModel):
    plugin: str = Field(max_length=40)
    options: dict = Field(default_factory=dict)
    id: str | None = None


class FlowIn(BaseModel):
    name: str = Field(default="", max_length=200)
    summary: str | None = Field(default=None, max_length=200)
    graph: dict | None = None
    steps: list[StepIn] | None = Field(default=None, max_length=20)   # v6 旧写法，换算成节点图


class FileIn(BaseModel):
    name: str = Field(max_length=200)
    data_base64: str


class RunIn(BaseModel):
    inputs: dict[str, Any] | None = None
    text: str | None = Field(default=None, max_length=MAX_RUN_TEXT)    # v6 旧写法
    file: FileIn | None = None


class InputError(ValueError):
    """运行输入不合法；message 直接给用户看。"""


# ---------- 运行输入 ----------

def decode_file(raw: dict) -> dict:
    """{name, data_base64} → {name, data}；先按编码长度拦超限文件，免得为 30MB 的东西整段解码。"""
    name, encoded = raw.get("name"), raw.get("data_base64")
    if not isinstance(name, str) or not isinstance(encoded, str) or len(name) > 200:
        raise InputError("文件格式不对")
    if len(encoded) > (MAX_FILE_BYTES + 2) // 3 * 4 + 4:
        raise InputError("文件超过 10MB 上限")
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception:
        raise InputError("文件内容编码不合法") from None
    if len(data) > MAX_FILE_BYTES:
        raise InputError("文件超过 10MB 上限")
    return {"name": PurePath(name.replace("\\", "/")).name.strip() or "资料", "data": data}


def prepare_inputs(raw: dict | None, graph: dict) -> tuple[dict, dict]:
    """运行输入 → (inputs, input_info)。值可以是文字、数字或 {name, data_base64}（已解码的 {name, data} 也认）。"""
    raw = raw or {}
    if not isinstance(raw, dict) or len(raw) > MAX_FIELDS * 2:
        raise InputError("输入格式不对")
    inputs: dict = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not _INPUT_KEY.match(key):
            continue
        if value is None:
            continue
        if isinstance(value, bool):
            value = "是" if value else "否"
        if isinstance(value, str):
            if len(value) > MAX_RUN_TEXT:
                raise InputError(f"输入的文字太长了（最多 {MAX_RUN_TEXT} 字）")
            inputs[key] = value
        elif isinstance(value, (int, float)):
            inputs[key] = value
        elif isinstance(value, dict) and isinstance(value.get("data"), (bytes, bytearray)):
            if len(value["data"]) > MAX_FILE_BYTES:
                raise InputError("文件超过 10MB 上限")
            inputs[key] = {"name": str(value.get("name") or "资料")[:200], "data": bytes(value["data"])}
        elif isinstance(value, dict):
            inputs[key] = decode_file(value)
        else:
            raise InputError("输入格式不对")
    return inputs, {"summary": input_summary(inputs, graph)}


def legacy_inputs(body: RunIn, graph: dict) -> dict:
    """v6 的 {text, file} → 开始节点的字段：文件给第一个文件字段，文字给 text 字段（没有就给文件字段当贴进来的文字）。"""
    fields = next(n for n in graph["nodes"] if n["id"] == "start")["data"]["fields"]
    keys = {f["key"]: f["type"] for f in fields}
    file_key = next((k for k, t in keys.items() if t == "file"), "file")
    text_key = "text" if "text" in keys else next((k for k, t in keys.items() if t in ("paragraph", "text")), None)
    out: dict = {}
    if body.file is not None:
        out[file_key] = body.file.model_dump()
    if body.text:
        if text_key is not None:
            out[text_key] = body.text
        elif file_key not in out:
            out[file_key] = body.text
    return out


def input_summary(inputs: dict, graph: dict) -> str:
    fields = next((n for n in graph["nodes"] if n["id"] == "start"), {"data": {"fields": []}})["data"]["fields"]
    parts = []
    for field in fields:
        value = inputs.get(field["key"])
        if value in (None, ""):
            continue
        if isinstance(value, dict):
            parts.append(f"{field['label']}：{value.get('name') or '文件'}")
        else:
            parts.append(f"{field['label']}：{clip(' '.join(str(value).split()), 20)}")
    return clip(" · ".join(parts), 80) or "没有填输入"


# ---------- 运行时 ----------

class FlowRuntime:
    """注册后留一份运行时（依赖、并发闸、存储工厂），测试可直接替换其中的 deps。"""

    def __init__(self, deps: engine.FlowDeps, store_factory=FlowStore, platform_lookup=None):
        self.deps = deps
        self.store_factory = store_factory
        self.guard = engine.RunGuard()
        self.platform_lookup = platform_lookup or platform_for_owner
        self.timeouts: dict[str, float] = {}
        self.total_seconds = engine.TOTAL_SECONDS

    def store(self) -> FlowStore:
        """先走 server 的 _tenant_store 完成旧数据迁移，再碰流程表（调用方已在 tenant_scope 里）。"""
        self.deps.tenant_store()
        return self.store_factory()

    def run_headless(self, user_id: str, flow_id: str, inputs: dict | None = None) -> dict:
        """无头运行（给定时运行用）：同步跑完返回 ``{"status", "run_id", "output", "error"}``。

        status：ok / error / busy（这个账号正在跑别的流程，没开跑）。不发事件、不可取消，整条仍限 240 秒。"""
        def result(status: str, error: str = "", run_id=None, output=None) -> dict:
            return {"status": status, "run_id": run_id, "output": output, "error": error}

        try:
            with tenant_scope(user_id):
                store = self.store()
                flow = store.get_flow(user_id, flow_id)
        except TenantMigrationError:
            return result("error", "个人数据迁移失败")
        if flow is None:
            return result("error", NOT_FOUND)
        try:
            graph = validate_graph(flow["graph"])
            prepared, info = prepare_inputs(inputs, graph)
        except (GraphError, InputError) as exc:
            return result("error", str(exc))
        if not self.guard.acquire(user_id):
            return result("busy", BUSY)
        try:
            with tenant_scope(user_id):
                done = executor.execute_graph(
                    flow={"id": flow["id"], "name": flow["name"], "graph": graph}, user_id=user_id, inputs=prepared,
                    deps=self.deps, store=store, emit=lambda event: None, input_info={**info, "trigger": "headless"},
                    total_seconds=self.total_seconds, timeouts=self.timeouts)
        except Exception as exc:
            log.exception("flow headless run failed: %s", type(exc).__name__)
            return result("error", "流程运行出了点问题，请稍后再试")
        finally:
            self.guard.release(user_id)
        return result(done["status"], done.get("error") or "", done["run_id"], done["output"])


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


def view_graph(flow: dict) -> dict:
    """返回给前端的节点图：能规整就规整（旧流程换算出来的补上标题），规整不了原样给，让画布去改。"""
    try:
        return validate_graph(flow["graph"])
    except GraphError:
        return flow["graph"]


def register(app, *, request_principal, panel_write, deny, deps: engine.FlowDeps,
             store_factory=FlowStore) -> FlowRuntime:
    runtime = FlowRuntime(deps, store_factory)

    def no_store(payload, status_code: int = 200) -> JSONResponse:
        return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store"})

    def migration_failed() -> JSONResponse:
        return no_store({"error": "个人数据迁移失败"}, 503)

    def flow_view(flow: dict, *, last_run: dict | None, trigger: dict | None, full: bool) -> dict:
        graph = view_graph(flow)
        view = {"id": flow["id"], "name": flow["name"], "summary": flow["summary"], "graph": graph,
                "config_hashes": config_hashes(graph), "updated_at": flow["updated_at"], "trigger": trigger,
                "last_run": last_run}
        if not full:
            view["node_count"] = len(graph.get("nodes") or [])
            view["plugins"] = nodes_mod.graph_plugins(graph)
        return view

    # 节点目录必须先于 /api/flows/{flow_id} 注册
    @app.get("/api/flows/nodes")
    def flows_nodes(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                runtime.deps.tenant_store()
                catalog = nodes_mod.node_catalog(principal.user_id, runtime.deps)
        except TenantMigrationError:
            return migration_failed()
        return no_store(catalog)

    @app.get("/api/flows")
    def flows_list(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                s = runtime.store()
                flows = s.list_flows(principal.user_id)
                last, triggers = s.last_runs(principal.user_id), s.triggers(principal.user_id)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"flows": [flow_view(f, last_run=last.get(f["id"]), trigger=triggers.get(f["id"]), full=False)
                                   for f in flows]})

    @app.get("/api/flows/{flow_id}")
    def flows_get(request: Request, flow_id: FlowId):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                s = runtime.store()
                flow = s.get_flow(principal.user_id, flow_id)
                if flow is None:
                    return no_store({"error": NOT_FOUND}, 404)
                last = s.last_runs(principal.user_id).get(flow_id)
                trigger = s.trigger(principal.user_id, flow_id)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"flow": flow_view(flow, last_run=last, trigger=trigger, full=True)})

    def clean_flow(body: FlowIn) -> dict:
        if body.graph is not None:
            graph = validate_graph(body.graph)
        elif body.steps:
            graph = validate_graph(graph_from_steps(engine.normalize_steps([s.model_dump() for s in body.steps])))
        else:
            raise GraphError("流程里还没有节点")
        name = " ".join(str(body.name or "").split())[:engine.MAX_NAME] or "未命名流程"
        summary = " ".join(str(body.summary or "").split())[:MAX_SUMMARY] or default_summary(graph, MAX_SUMMARY)
        return {"name": name, "summary": summary, "graph": graph}

    def save(request: Request, body: FlowIn, flow_id: str | None):
        principal, err = panel_write(request)
        if err:
            return err
        try:
            clean = clean_flow(body)
        except (GraphError, engine.FlowValidationError) as exc:
            return no_store({"error": str(exc)}, 400)
        try:
            with tenant_scope(principal.user_id):
                s = runtime.store()
                if flow_id is None:
                    flow = s.create_flow(principal.user_id, **clean)
                else:
                    flow = s.update_flow(principal.user_id, flow_id, **clean)
                    if flow is None:
                        return no_store({"error": NOT_FOUND}, 404)
                last = s.last_runs(principal.user_id).get(flow["id"])
                trigger = s.trigger(principal.user_id, flow["id"])
        except FlowLimitError:
            return no_store({"error": f"最多保存 {MAX_FLOWS} 条流程，先删掉几条不用的"}, 409)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"flow": flow_view(flow, last_run=last, trigger=trigger, full=True)},
                        201 if flow_id is None else 200)

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
                found = runtime.store().delete_flow(principal.user_id, flow_id)
        except TenantMigrationError:
            return migration_failed()
        if not found:
            return no_store({"error": NOT_FOUND}, 404)
        return no_store({"ok": True})

    @app.get("/api/flows/{flow_id}/runs")
    def flows_runs(request: Request, flow_id: FlowId, limit: int = 10):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                s = runtime.store()
                if s.get_flow(principal.user_id, flow_id) is None:
                    return no_store({"error": NOT_FOUND}, 404)
                runs = s.list_runs(principal.user_id, flow_id, limit)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"runs": runs})

    @app.post("/api/flows/{flow_id}/run")
    def flows_run(request: Request, flow_id: FlowId, body: RunIn):
        principal, err = panel_write(request)
        if err:
            return err
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                s = runtime.store()
                flow = s.get_flow(user_id, flow_id)
        except TenantMigrationError:
            return migration_failed()
        if flow is None:
            return no_store({"error": NOT_FOUND}, 404)
        try:   # 存进去时合法，但积木 / 插件清单可能变过：开跑前再校验一遍
            graph = validate_graph(flow["graph"])
            raw = body.inputs if body.inputs is not None else legacy_inputs(body, graph)
            inputs, info = prepare_inputs(raw, graph)
        except (GraphError, InputError) as exc:
            return no_store({"error": str(exc)}, 422)
        if not runtime.guard.acquire(user_id):
            return no_store({"error": BUSY}, 409)
        target = {"id": flow["id"], "name": flow["name"], "graph": graph}

        def produce(emit, cancel):
            try:
                with tenant_scope(user_id):
                    executor.execute_graph(flow=target, user_id=user_id, inputs=inputs, deps=runtime.deps, store=s,
                                           emit=emit, cancel=cancel, input_info=info,
                                           total_seconds=runtime.total_seconds, timeouts=runtime.timeouts)
            except Exception as exc:
                log.exception("flow run failed: %s", type(exc).__name__)
                emit({"type": "run_done", "status": "error", "ms": 0,
                      "output": {"text": "", "links": [], "page_url": None}, "error": "流程运行出了点问题，请稍后再试"})
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
