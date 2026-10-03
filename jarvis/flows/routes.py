"""流程 API（第十八轮契约 §3.1–3.3）：CRUD、节点目录、试运行 SSE、运行记录、公开结果页。

鉴权沿用 server.py 的写法：读接口要登录，写接口要登录 + CSRF（panel_write）；
结果页（/api/r/<token>、/r/<token>）公开，只凭不可猜的 token 访问。
路由顺序：``/api/flows/nodes`` 在 ``/api/flows/{flow_id}`` 之前注册（templates / compose 由 extras 先注册）。

第二十轮（契约 docs/proposals/2026-10-round20-flows-ops.md §2 / §3）：
- ``GET  /api/flows/{id}/runs/{run_id}``          单次运行详情（确认页轮询「接着跑」的进度）；
- ``POST /api/flows/{id}/runs/{run_id}/rerun``    用那次保存的输入再跑一遍（SSE 同 /run，source=rerun）；
- ``POST /api/flows/{id}/nodes/{node_id}/test``   单节点试跑（JSON，不写运行记录、不占并发闸）；
- 开始节点的文件字段接受文件空间里已有的文件：``{file_id}`` 或含「file_id=XXX」的附件标记文字；
- 所有入口先 ``usage.check_flow_run``（超了回 429 / run_headless 的 ``status: "quota"``）。
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

from jarvis import files as filespace
from jarvis import usage
from jarvis.flows import approvals, engine, executor, nodes as nodes_mod, page as page_mod
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
RunId = Annotated[str, PathParam(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
NodeId = Annotated[str, PathParam(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_INPUT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
_FILE_REF = re.compile(r"file_id\s*[=＝:：]\s*[A-Za-z0-9_-]{8,64}")
BUSY = "你有一条流程正在运行，等它跑完再试"
NOT_FOUND = "没有找到这条流程"
RUN_NOT_FOUND = "没有找到这次运行，可能已经被清理了"
NO_SAVED_INPUT = "这次运行是比较早的记录，没有保存输入，没法直接再跑：请在流程里重新填写后运行"

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


class NodeTrialIn(BaseModel):
    inputs: dict[str, Any] | None = None


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


def start_fields(graph: dict) -> dict[str, dict]:
    start = next((n for n in graph.get("nodes") or [] if n.get("id") == "start"), {"data": {"fields": []}})
    return {f["key"]: f for f in start["data"].get("fields") or [] if isinstance(f, dict) and f.get("key")}


def load_file(user_id: str | None, ref: str, label: str) -> dict:
    """文件空间里已有的文件（file_id / 附件标记 / 下载链接）→ {name, data, file_id}；按当前账号取，不重复存。"""
    if not user_id:
        raise InputError(f"「{label}」要上传文件")
    try:
        meta = filespace.resolve(user_id, ref)
        data = filespace.read(user_id, meta["id"])
    except (KeyError, ValueError, OSError):
        raise InputError(f"「{label}」用的文件找不到了（可能已经过期被清理），请重新上传") from None
    if len(data) > MAX_FILE_BYTES:
        raise InputError(f"「{label}」超过 10MB 上限")
    return {"name": meta["name"], "data": data, "file_id": meta["id"]}


def prepare_inputs(raw: dict | None, graph: dict, user_id: str | None = None) -> tuple[dict, dict]:
    """运行输入 → (inputs, input_info)。值可以是文字、数字或 {name, data_base64}（已解码的 {name, data} 也认）；
    第二十轮起文件字段还接受文件空间里已有的文件：``{file_id}``，或含「file_id=XXX」的附件标记文字（按 user_id 取）。

    ``input_info`` = ``{summary, values}``：``values`` 是重跑用的输入（文件存 ``{file_id, name}``，上传的原文件
    在开始节点存进文件空间后由执行器补上 file_id）。"""
    raw = raw or {}
    if not isinstance(raw, dict) or len(raw) > MAX_FIELDS * 2:
        raise InputError("输入格式不对")
    fields = start_fields(graph)
    inputs: dict = {}
    values: dict = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not _INPUT_KEY.match(key):
            continue
        if value is None:
            continue
        label = (fields.get(key) or {}).get("label") or "文件"
        is_file = (fields.get(key) or {}).get("type") == "file"
        if isinstance(value, bool):
            value = "是" if value else "否"
        if isinstance(value, str):
            if len(value) > MAX_RUN_TEXT:
                raise InputError(f"输入的文字太长了（最多 {MAX_RUN_TEXT} 字）")
            if is_file and _FILE_REF.search(value):   # 对话附件、链接触发：附件标记指向文件空间里的文件
                inputs[key] = load_file(user_id, value, label)
                values[key] = {"file_id": inputs[key]["file_id"], "name": inputs[key]["name"]}
                continue
            inputs[key] = values[key] = value
        elif isinstance(value, (int, float)):
            inputs[key] = values[key] = value
        elif isinstance(value, dict) and isinstance(value.get("file_id"), str) and "data_base64" not in value:
            inputs[key] = load_file(user_id, value["file_id"].strip(), label)
            values[key] = {"file_id": inputs[key]["file_id"], "name": inputs[key]["name"]}
        elif isinstance(value, dict) and isinstance(value.get("data"), (bytes, bytearray)):
            if len(value["data"]) > MAX_FILE_BYTES:
                raise InputError("文件超过 10MB 上限")
            inputs[key] = {"name": str(value.get("name") or "资料")[:200], "data": bytes(value["data"])}
            values[key] = {"name": inputs[key]["name"]}
        elif isinstance(value, dict):
            inputs[key] = decode_file(value)
            values[key] = {"name": inputs[key]["name"]}
        else:
            raise InputError("输入格式不对")
    return inputs, {"summary": input_summary(inputs, graph), "values": values}


def rerun_inputs(values: dict, graph: dict) -> dict:
    """运行记录里存的输入 → 再跑一遍的输入：文件按 file_id 取；那次没存下原文件的说清楚要重新上传。"""
    fields = start_fields(graph)
    out: dict = {}
    for key, value in values.items():
        if isinstance(value, dict):
            if not value.get("file_id"):
                label = (fields.get(key) or {}).get("label") or value.get("name") or "文件"
                raise InputError(f"那次上传的「{label}」没有存进文件空间，没法直接再跑：请在流程里重新上传后运行")
            out[key] = {"file_id": str(value["file_id"])}
        else:
            out[key] = value
    return out


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

    def run_headless(self, user_id: str, flow_id: str, inputs: dict | None = None, *, source: str = "schedule",
                     origin: str = "") -> dict:
        """无头运行（定时 / 对话 / 消息触发 / 链接触发用）：同步跑完返回
        ``{"status", "run_id", "output", "error"}``，停在「发送前确认」时另带 ``approval: {id, url, expires_at}``。

        status：ok / error / busy（这个账号正在跑别的流程，没开跑）/ waiting（停下等确认，确认通知已发出）/
        quota（今天的流程运行次数到上限了，没开跑；error 是给人看的说明）。不发事件、不可取消，整条仍限 240 秒。
        ``source`` 写进运行记录；``origin`` 可选，没配 JARVIS_PUBLIC_URL 时拼确认链接的绝对地址。"""
        def result(status: str, error: str = "", run_id=None, output=None, approval=None) -> dict:
            out = {"status": status, "run_id": run_id, "output": output, "error": error}
            if approval:
                out["approval"] = approval
            return out

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
            prepared, info = prepare_inputs(inputs, graph, user_id)
        except (GraphError, InputError) as exc:
            return result("error", str(exc))
        blocked = quota_problem(user_id)
        if blocked:
            return result("quota", blocked)
        if not self.guard.acquire(user_id):
            return result("busy", BUSY)
        try:
            with tenant_scope(user_id):
                done = executor.execute_graph(
                    flow={"id": flow["id"], "name": flow["name"], "graph": graph}, user_id=user_id, inputs=prepared,
                    deps=self.deps, store=store, emit=lambda event: None, input_info={**info, "trigger": "headless"},
                    total_seconds=self.total_seconds, timeouts=self.timeouts, source=source or "schedule",
                    origin=origin)
        except Exception as exc:
            log.exception("flow headless run failed: %s", type(exc).__name__)
            return result("error", "流程运行出了点问题，请稍后再试")
        finally:
            self.guard.release(user_id)
        return result(done["status"], done.get("error") or "", done["run_id"], done["output"], done.get("approval"))


def quota_problem(user_id: str) -> str | None:
    """今天还能不能跑流程（usage.check_flow_run）：能跑返回 None，超了返回人话；检查本身出错不拦。"""
    try:
        message = usage.check_flow_run(user_id)
    except Exception as exc:
        log.warning("flow quota check failed: %s", type(exc).__name__)
        return None
    return str(message) if message else None


def request_origin(request: Request) -> str:
    """确认链接的绝对地址前缀：JARVIS_PUBLIC_URL 优先，否则按请求来源（反代转发头）拼。"""
    try:
        from jarvis.platforms import public_base_url
        origin = public_base_url(request)
    except Exception:
        return ""
    approvals.remember_origin(origin)
    return origin


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

    def flow_view(flow: dict, *, last_run: dict | None, trigger: dict | None, full: bool,
                  hooks: dict | None = None) -> dict:
        graph = view_graph(flow)
        view = {"id": flow["id"], "name": flow["name"], "summary": flow["summary"], "graph": graph,
                "config_hashes": config_hashes(graph), "updated_at": flow["updated_at"], "trigger": trigger,
                "last_run": last_run}
        if not full:
            view["hooks"] = hooks or {"message": False, "webhook": False}   # 卡片上的触发方式小标记
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
                approvals.expire_due(s, principal.user_id)   # 等确认超时的先记成 expired（惰性）
                flows = s.list_flows(principal.user_id)
                last, triggers = s.last_runs(principal.user_id), s.triggers(principal.user_id)
                from jarvis.flows.hooks import HookStore   # 第二十轮：消息 / 链接触发的小标记
                hook_marks = HookStore().summary(principal.user_id)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"flows": [flow_view(f, last_run=last.get(f["id"]), trigger=triggers.get(f["id"]), full=False,
                                             hooks=hook_marks.get(f["id"]))
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
                approvals.expire_due(s, principal.user_id)
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
                approvals.expire_due(s, principal.user_id)
                runs = s.list_runs(principal.user_id, flow_id, limit)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"runs": runs})

    @app.get("/api/flows/{flow_id}/runs/{run_id}")
    def flows_run_detail(request: Request, flow_id: FlowId, run_id: RunId):
        """单次运行详情（同列表项结构）：确认页据此轮询「接着跑」的进度。"""
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                s = runtime.store()
                if s.get_flow(principal.user_id, flow_id) is None:
                    return no_store({"error": NOT_FOUND}, 404)
                approvals.expire_due(s, principal.user_id)
                run = s.get_run(principal.user_id, flow_id, run_id)
        except TenantMigrationError:
            return migration_failed()
        if run is None:
            return no_store({"error": RUN_NOT_FOUND}, 404)
        return no_store({"run": run})

    def start_stream(request: Request, user_id: str, flow: dict, graph: dict, inputs: dict, info: dict, s,
                     source: str):
        """开跑（/run 与 /rerun 共用）：配额 → 并发闸 → SSE。"""
        blocked = quota_problem(user_id)
        if blocked:
            return no_store({"error": blocked}, 429)
        if not runtime.guard.acquire(user_id):
            return no_store({"error": BUSY}, 409)
        target = {"id": flow["id"], "name": flow["name"], "graph": graph}
        origin = request_origin(request)

        def produce(emit, cancel):
            try:
                with tenant_scope(user_id):
                    executor.execute_graph(flow=target, user_id=user_id, inputs=inputs, deps=runtime.deps, store=s,
                                           emit=emit, cancel=cancel, input_info=info,
                                           total_seconds=runtime.total_seconds, timeouts=runtime.timeouts,
                                           source=source, origin=origin)
            except Exception as exc:
                log.exception("flow run failed: %s", type(exc).__name__)
                emit({"type": "run_done", "status": "error", "ms": 0,
                      "output": {"text": "", "links": [], "page_url": None}, "error": "流程运行出了点问题，请稍后再试"})
            finally:
                runtime.guard.release(user_id)

        return StreamingResponse(stream_events(produce), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

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
            inputs, info = prepare_inputs(raw, graph, user_id)
        except (GraphError, InputError) as exc:
            return no_store({"error": str(exc)}, 422)
        return start_stream(request, user_id, flow, graph, inputs, info, s, "manual")

    @app.post("/api/flows/{flow_id}/runs/{run_id}/rerun")
    def flows_rerun(request: Request, flow_id: FlowId, run_id: RunId):
        """用那次运行保存的输入再跑一遍（文件按文件空间 id 取），SSE 同 /run，source=rerun。"""
        principal, err = panel_write(request)
        if err:
            return err
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                s = runtime.store()
                flow = s.get_flow(user_id, flow_id)
                previous = s.run_record(user_id, run_id) if flow is not None else None
        except TenantMigrationError:
            return migration_failed()
        if flow is None:
            return no_store({"error": NOT_FOUND}, 404)
        if previous is None or previous["flow_id"] != flow_id:
            return no_store({"error": RUN_NOT_FOUND}, 404)
        values = previous["input"].get("values")
        if not isinstance(values, dict):
            return no_store({"error": NO_SAVED_INPUT}, 422)
        try:
            graph = validate_graph(flow["graph"])
            inputs, info = prepare_inputs(rerun_inputs(values, graph), graph, user_id)
        except (GraphError, InputError) as exc:
            return no_store({"error": str(exc)}, 422)
        info["rerun_of"] = run_id
        return start_stream(request, user_id, flow, graph, inputs, info, s, "rerun")

    @app.post("/api/flows/{flow_id}/nodes/{node_id}/test")
    def flows_node_test(request: Request, flow_id: FlowId, node_id: NodeId, body: NodeTrialIn | None = None):
        """单节点试跑：上游产出取最近运行里存下的（或用 inputs 现填开始的输入），只跑这一个节点；
        有副作用的积木只渲染要发的内容。不写运行记录、不占并发闸。"""
        principal, err = panel_write(request)
        if err:
            return err
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                s = runtime.store()
                flow = s.get_flow(user_id, flow_id)
                saved = s.node_outputs(user_id, flow_id) if flow is not None else {}
        except TenantMigrationError:
            return migration_failed()
        if flow is None:
            return no_store({"error": NOT_FOUND}, 404)
        try:
            graph = validate_graph(flow["graph"])
            if not any(n["id"] == node_id for n in graph["nodes"]):
                return no_store({"error": "这个节点已经不在流程里了，刷新一下再试"}, 404)
            raw = (body.inputs if body is not None else None) or None
            inputs = prepare_inputs(raw, graph, user_id)[0] if raw else None
        except (GraphError, InputError) as exc:
            return no_store({"error": str(exc)}, 422)
        blocked = quota_problem(user_id)
        if blocked:
            return no_store({"error": blocked}, 429)
        target = {"id": flow["id"], "name": flow["name"], "graph": graph}
        try:
            with tenant_scope(user_id):
                result = executor.test_node(flow=target, node_id=node_id, user_id=user_id, deps=runtime.deps, store=s,
                                            saved=saved, inputs=inputs, total_seconds=runtime.total_seconds,
                                            timeouts=runtime.timeouts)
        except Exception as exc:
            log.exception("flow node test failed: %s", type(exc).__name__)
            return no_store({"error": "试跑出了点问题，请稍后再试"}, 500)
        return no_store(result)

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
