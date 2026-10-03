"""「发送前让我确认」（第二十轮，归引擎代理；契约 docs/proposals/2026-10-round20-flows-ops.md §3.1）。

流程跑到 ``approval`` 节点时停下（执行器 ``executor._pause``）：运行记录 status=waiting，表
``tenant_flow_approvals`` 记一条待确认（``state`` 存恢复运行所需的上下文），按节点的 ``notify``（没设 = 账号的
送达设置）推一条「「流程名」有一步等你确认：…」并附 /approve/<id> 链接（绝对地址用 JARVIS_PUBLIC_URL，没有就用
请求来源）。等待期间不占「一个账号同时只跑一条」的闸。

- 同意：用（改过的）内容作为该节点产出，在后台从它的下游接着跑（沿用同一条运行记录，source 记 resume）；
  重新拿闸，忙就排队重试（最多等 5 分钟）；跑完推「流程已完成 / 没跑通」；
- 拒绝：运行记录 rejected，下游不跑；
- 超时：expired（读取时惰性判定 + :class:`ApprovalSweeper` 每分钟清一次，后者顺带通知）。

接口（只能处理自己的；已处理 / 已过期回 409 人话）：

- ``GET  /api/approvals?status=pending|all&limit=``  → ``{approvals: [...], pending}``
- ``GET  /api/approvals/{id}``                       → ``{approval: {..., content, editable, next, source}}``
- ``POST /api/approvals/{id}``  ``{decision: approve|reject, content?, note?}``（CSRF）→ ``{approval, run: {id, status}}``
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Any, Callable

from fastapi import Path as PathParam, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from jarvis.periodic import PeriodicWorker
from jarvis.tenancy import TenantMigrationError, tenant_scope

log = logging.getLogger("jarvis")

MAX_CONTENT = 20000
MAX_NOTE = 200
SUMMARY_CHARS = 300
BUSY_WAIT_SECONDS = 300.0     # 同意后接着跑：账号正忙时最多排队等这么久
BUSY_POLL_SECONDS = 2.0
SWEEP_SECONDS = 60.0
DEFAULT_LIMIT = 20
ApprovalId = Annotated[str, PathParam(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
NOT_FOUND = "没有找到这条确认，可能流程已经被删掉了"
DONE_LABELS = {"approved": "已经同意过了，流程在接着跑或已经跑完", "rejected": "已经拒绝过了，流程已停止",
               "expired": "已经过期了，流程已停止；需要的话到流程页重新跑一次"}
BUSY_GAVE_UP = "等了 5 分钟，你的其他流程还没跑完，这次没能接着跑：到流程页重新跑一次"
RESUME_CRASHED = "接着跑的时候出了点问题，请到流程页重新跑一次"

_STATE: dict[str, Any] = {"notifier": None, "origin": ""}
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="jarvis-flow-approval")


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def submit(fn: Callable, *args, **kwargs):
    """后台执行（推通知、接着跑）；测试可换成同步执行。"""
    return _POOL.submit(fn, *args, **kwargs)


# ---------- 链接与通知 ----------

def set_notifier(notifier) -> None:
    """server 的 delivery.Notifier（按账号送达渠道分发）；flows.start_scheduler / install 时注入。"""
    _STATE["notifier"] = notifier


def remember_origin(origin: str) -> None:
    """记下最近一次请求的来源：定时 / 消息触发的运行没有请求，拼确认链接时兜底用。"""
    if isinstance(origin, str) and origin.startswith(("http://", "https://")):
        _STATE["origin"] = origin.rstrip("/")


def base_url(origin: str = "") -> str:
    """确认链接的绝对地址前缀：JARVIS_PUBLIC_URL → 本次请求来源 → 最近一次请求来源；都没有返回空串（用站内路径）。"""
    for base in (os.getenv("JARVIS_PUBLIC_URL", "").strip(), origin or "", _STATE["origin"] or ""):
        base = base.rstrip("/")
        if base.startswith(("http://", "https://")):
            return base
    return ""


def approve_url(approval_id: str, origin: str = "") -> str:
    return f"{base_url(origin)}/approve/{approval_id}"


def absolute(url: str, origin: str = "") -> str:
    if not url or url.startswith(("http://", "https://")):
        return url or ""
    base = base_url(origin)
    return f"{base}{url}" if base and url.startswith("/") else ""


def _summary(text: str, limit: int = SUMMARY_CHARS) -> str:
    from jarvis.flows.steps import clip, plain_text
    return clip(plain_text(text or "").strip(), limit)


def deliver(user_id: str, text: str, title: str, notify: dict | None, deps=None) -> list[str]:
    """推一条：节点指定了渠道（``{feishu, desktop}``）就按它（同定时运行的 deliver）；没指定按账号的送达设置
    （渠道开关，不受免打扰影响——是用户自己设的流程在等他）。没有统一出口时飞书绑了就推飞书。返回送达的渠道。"""
    notifier = _STATE["notifier"]
    if notify is not None:
        from jarvis.flows.schedule import deliver as deliver_by_switch
        return deliver_by_switch(owner_id=user_id, notify=notify, text=text, title=title, deps=deps,
                                 notifier=notifier)
    if notifier is not None:
        now = dt.datetime.now()
        try:
            prefs_of, fanout = getattr(notifier, "_prefs", None), getattr(notifier, "_fanout", None)
            if prefs_of is not None and fanout is not None:
                _store, prefs = prefs_of(user_id)
                return ["account"] if fanout(user_id, prefs, text, title, now) else []
            return ["account"] if notifier.send(user_id, text, now, icon="") else []
        except Exception as exc:
            log.warning("flow approval notify failed: %s", type(exc).__name__)
            return []
    try:
        if deps is not None and deps.feishu_ready(user_id) and deps.push_feishu(user_id, text):
            return ["feishu"]
    except Exception as exc:
        log.warning("flow approval feishu push failed: %s", type(exc).__name__)
    return []


def announce_wait(*, user_id: str, flow_name: str, title: str, content: str, hours: int, notify, url: str,
                  deps=None) -> None:
    """「「流程名」有一步等你确认：…」+ 链接（后台推，不拖慢运行收尾）。"""
    body = _summary(content) or "（内容是空的）"
    if url.startswith(("http://", "https://")):
        tail = f"去确认：{url}（{hours} 小时内有效）"
    else:
        tail = f"打开贾维斯「我的流程」，在顶部的「等你确认」里处理（{hours} 小时内有效）"
    text = f"✋ 「{flow_name}」有一步等你确认：{title}\n\n{body}\n\n{tail}"
    head = f"「{flow_name}」有一步等你确认：{title}"[:80]
    submit(deliver, user_id, text, head, notify, deps)


def announce_done(*, user_id: str, flow_name: str, result: dict, notify, origin: str = "", deps=None) -> None:
    """确认后接着跑完：推「流程已完成 / 没跑通」（又停在下一个确认节点的，执行器已经推过了）。"""
    status = result.get("status")
    if status == "waiting":
        return
    name = flow_name or "流程"
    if status == "ok":
        output = result.get("output") or {}
        parts = [f"✅ 「{name}」确认后接着跑完了", _summary(output.get("text") or "")]
        link = absolute(output.get("page_url") or "", origin)
        if link:
            parts.append(f"结果网页：{link}")
        text = "\n\n".join(p for p in parts if p)
        head = f"「{name}」确认后跑完了"
    else:
        error = result.get("error") or "流程出错了"
        text = f"⚠️ 「{name}」确认后接着跑，但没跑通：{error}\n打开「我的流程」看看是哪一步出了问题。"
        head = f"「{name}」没跑通：{error}"[:80]
    submit(deliver, user_id, text, head, notify, deps)


# ---------- 运行记录的收尾 ----------

def _record_usage(user_id: str, ok: bool) -> None:
    try:
        from jarvis import usage
        usage.record_flow_run(user_id, ok)
    except Exception as exc:
        log.warning("flow usage record failed: %s", type(exc).__name__)


def _update_run(store, row: dict, status: str, message: str = "", *, node_status: str | None = None,
                node_summary: str = "", resumed: bool = False) -> None:
    """改停着等确认的那条运行：rejected / expired / error 收尾，或 running（同意了、在排队接着跑）。"""
    record = store.run_record(row["owner_id"], row["run_id"])
    if record is None or record["status"] not in ("waiting", "running"):
        return
    detail = record["detail"] or {}
    nodes = [dict(n) for n in detail.get("nodes") or [] if isinstance(n, dict)]
    if node_status is not None:
        for node in nodes:
            if node.get("node_id") == row["node_id"] and node.get("status") == "waiting":
                node["status"], node["summary"] = node_status, node_summary or node.get("summary") or ""
                if message:
                    node["message"] = message
    extra = {"resumed_at": _now_iso()} if resumed else None
    store.finish_run(row["owner_id"], row["run_id"], status=status, nodes=nodes, output=detail.get("output"),
                     ms=detail.get("ms"), error=message, extra=extra, source="resume" if resumed else None)


def expire_due(store, owner_id: str | None = None, *, notify: bool = False, deps=None) -> list[dict]:
    """到期还没处理的确认记成 expired，对应的运行记成 expired；返回这次清掉的。读取时（只看一个账号）惰性调，
    后台每分钟跨账号调一次（``notify=True`` 时顺带推「等确认超时了」）。"""
    try:
        rows = store.due_approvals(_now_iso(), owner_id)
    except Exception as exc:
        log.warning("flow approval expiry lookup failed: %s", type(exc).__name__)
        return []
    expired = []
    for row in rows:
        try:
            if not store.decide_approval(row["owner_id"], row["id"], status="expired"):
                continue   # 刚好被处理了
        except Exception as exc:   # 库忙之类：下次再清，不拖垮读取
            log.warning("flow approval expire failed: %s", type(exc).__name__)
            continue
        hours = (row.get("payload") or {}).get("timeout_hours") or 24
        message = f"超过 {hours} 小时没人确认，流程已停止"
        try:
            _update_run(store, row, "expired", message, node_status="expired", node_summary="等确认超时了")
        except Exception as exc:
            log.warning("flow approval expire run failed: %s", type(exc).__name__)
        _record_usage(row["owner_id"], False)
        expired.append(row)
        if notify:
            name = row.get("flow_name") or (row.get("payload") or {}).get("flow_name") or "流程"
            text = f"⌛ 「{name}」等你确认的那一步{message}。需要的话到「我的流程」重新跑一次。"
            submit(deliver, row["owner_id"], text, f"「{name}」等确认超时了", (row.get("payload") or {}).get("notify"),
                   deps)
    return expired


# ---------- 同意后接着跑 ----------

def _runtime(runtime_fn):
    try:
        return runtime_fn() if callable(runtime_fn) else runtime_fn
    except Exception:
        return None


def resume(runtime_fn, user_id: str, approval_id: str, content: str) -> dict:
    """后台：重新拿「一个账号同时只跑一条」的闸（忙就排队，最多等 BUSY_WAIT_SECONDS 秒）→ 从确认节点的下游接着跑 →
    推「流程已完成 / 没跑通」。返回执行结果（测试用）。"""
    from jarvis.flows import executor
    runtime = _runtime(runtime_fn)
    if runtime is None:
        return {"status": "error", "error": RESUME_CRASHED}
    deadline = time.monotonic() + BUSY_WAIT_SECONDS
    while not runtime.guard.acquire(user_id):
        if time.monotonic() >= deadline:
            return _give_up(runtime, user_id, approval_id, BUSY_GAVE_UP)
        time.sleep(BUSY_POLL_SECONDS)
    row = None
    try:
        with tenant_scope(user_id):
            store = runtime.store()
            row = store.get_approval(user_id, approval_id, with_state=True)
            if row is None or row["status"] != "approved":   # 流程被删了
                return {"status": "error", "error": NOT_FOUND}
            result = executor.resume_graph(approval=row, content=content, user_id=user_id, deps=runtime.deps,
                                           store=store, total_seconds=runtime.total_seconds,
                                           timeouts=runtime.timeouts)
    except Exception as exc:
        log.exception("flow approval resume failed: %s", type(exc).__name__)
        if row is not None:
            try:
                _update_run(runtime.store_factory(), row, "error", RESUME_CRASHED)
            except Exception:
                pass
            _record_usage(user_id, False)
        result = {"status": "error", "error": RESUME_CRASHED, "output": None}
    finally:
        runtime.guard.release(user_id)
    if row is not None:
        payload = row.get("payload") or {}
        announce_done(user_id=user_id, flow_name=row.get("flow_name") or payload.get("flow_name") or "",
                      result=result, notify=payload.get("notify"), origin=(row.get("state") or {}).get("origin") or "",
                      deps=runtime.deps)
    return result


def _give_up(runtime, user_id: str, approval_id: str, message: str) -> dict:
    result = {"status": "error", "error": message, "output": None}
    try:
        with tenant_scope(user_id):
            store = runtime.store()
            row = store.get_approval(user_id, approval_id)
            if row is None:
                return result
            _update_run(store, row, "error", message)
    except Exception as exc:
        log.warning("flow approval give up failed: %s", type(exc).__name__)
        return result
    _record_usage(user_id, False)
    payload = row.get("payload") or {}
    announce_done(user_id=user_id, flow_name=row.get("flow_name") or payload.get("flow_name") or "", result=result,
                  notify=payload.get("notify"), deps=runtime.deps)
    return result


# ---------- 定期清超时 ----------

class ApprovalSweeper(PeriodicWorker):
    """每分钟把超时没人处理的确认记成 expired 并通知（读取时也会惰性判定）。"""

    thread_name = "jarvis-flow-approvals"
    first_delay = 15.0

    def __init__(self, runtime_fn, interval: float = SWEEP_SECONDS):
        super().__init__(interval)
        self._runtime_fn = runtime_fn

    def scan_once(self):
        runtime = _runtime(self._runtime_fn)
        if runtime is None:
            return []
        return expire_due(runtime.store_factory(), None, notify=True, deps=runtime.deps)


def start_sweeper(runtime_fn) -> ApprovalSweeper:
    sweeper = ApprovalSweeper(runtime_fn)
    sweeper.start()
    return sweeper


# ---------- 接口 ----------

class DecisionIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    decision: object = None
    content: object = None
    note: object = None


def view(row: dict, *, detail: bool = False) -> dict:
    payload = row.get("payload") or {}
    out = {"id": row["id"], "flow": {"id": row["flow_id"], "name": row.get("flow_name") or payload.get("flow_name") or "流程"},
           "run_id": row["run_id"], "node_id": row["node_id"], "title": row["title"],
           "preview": payload.get("preview") or "", "status": row["status"], "created_at": row["created_at"],
           "expires_at": row["expires_at"], "decided_at": row.get("decided_at"), "url": f"/approve/{row['id']}"}
    if detail:
        content = payload.get("approved_content") if row["status"] == "approved" else None
        out.update({"content": content if content is not None else payload.get("content") or "",
                    "editable": bool(payload.get("editable", True)), "edited": bool(payload.get("edited")),
                    "next": list(payload.get("next") or []), "source": payload.get("source") or "manual",
                    "timeout_hours": payload.get("timeout_hours") or 24, "note": row.get("note") or ""})
    return out


def register(app, *, request_principal, panel_write, deny, runtime) -> None:
    """注册 /api/approvals*（在流程路由之前）；``runtime`` 是取 FlowRuntime 的函数（注册时还没建好）。"""

    def no_store(payload, status_code: int = 200) -> JSONResponse:
        return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store"})

    def current():
        found = _runtime(runtime)
        if found is None:
            raise TenantMigrationError("flow runtime not ready")
        return found

    def migration_failed() -> JSONResponse:
        return no_store({"error": "个人数据迁移失败"}, 503)

    @app.get("/api/approvals")
    def approvals_list(request: Request, status: str = "pending", limit: int = DEFAULT_LIMIT):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                store = current().store()
                expire_due(store, user_id)
                rows = store.list_approvals(user_id, status=None if status == "all" else "pending",
                                            limit=max(1, min(int(limit), 100)))
                pending = store.pending_approvals(user_id)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"approvals": [view(r) for r in rows], "pending": pending})

    @app.get("/api/approvals/{approval_id}")
    def approvals_get(request: Request, approval_id: ApprovalId):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        user_id = principal.user_id
        try:
            with tenant_scope(user_id):
                store = current().store()
                expire_due(store, user_id)
                row = store.get_approval(user_id, approval_id)
        except TenantMigrationError:
            return migration_failed()
        if row is None:
            return no_store({"error": NOT_FOUND}, 404)
        return no_store({"approval": view(row, detail=True)})

    @app.post("/api/approvals/{approval_id}")
    def approvals_decide(request: Request, approval_id: ApprovalId, body: DecisionIn):
        principal, err = panel_write(request)
        if err:
            return err
        user_id = principal.user_id
        if body.decision not in ("approve", "reject"):
            return no_store({"error": "只能选「同意」或「拒绝」"}, 400)
        if body.note is not None and not isinstance(body.note, str):
            return no_store({"error": "原因要是一段文字"}, 400)
        note = " ".join(str(body.note or "").split())
        if len(note) > MAX_NOTE:
            return no_store({"error": f"原因最多 {MAX_NOTE} 个字，删短一些"}, 400)
        if body.content is not None and not isinstance(body.content, str):
            return no_store({"error": "内容要是一段文字"}, 400)
        try:
            flow_runtime = current()
            with tenant_scope(user_id):
                store = flow_runtime.store()
                expire_due(store, user_id)
                row = store.get_approval(user_id, approval_id)
                if row is None:
                    return no_store({"error": NOT_FOUND}, 404)
                if row["status"] != "pending":
                    return no_store({"error": f"这一步{DONE_LABELS.get(row['status'], '已经处理过了')}",
                                     "approval": view(row, detail=True)}, 409)
                payload = dict(row.get("payload") or {})
                if body.decision == "approve":
                    original = payload.get("content") or ""
                    content = original
                    if body.content is not None and payload.get("editable", True):
                        content = body.content.replace("\r\n", "\n").strip()
                    if len(content) > MAX_CONTENT:
                        return no_store({"error": f"内容最多 {MAX_CONTENT} 个字，删短一些"}, 400)
                    if not content.strip():
                        return no_store({"error": "要发出去的内容是空的：填一点再同意，或者直接拒绝"}, 400)
                    payload.update(approved_content=content, edited=content != original)
                    if not store.decide_approval(user_id, approval_id, status="approved", note=note, payload=payload):
                        return conflict(store, user_id, approval_id)
                    _update_run(store, row, "running", resumed=True)
                    run_status = "running"
                else:
                    if not store.decide_approval(user_id, approval_id, status="rejected", note=note):
                        return conflict(store, user_id, approval_id)
                    message = f"你拒绝了这一步：{note}" if note else "你拒绝了这一步，后面的没有跑"
                    _update_run(store, row, "rejected", message, node_status="rejected", node_summary="你拒绝了")
                    _record_usage(user_id, True)
                    run_status = "rejected"
                updated = store.get_approval(user_id, approval_id)
        except TenantMigrationError:
            return migration_failed()
        if run_status == "running":
            submit(resume, runtime, user_id, approval_id, content)
        return no_store({"approval": view(updated, detail=True), "run": {"id": row["run_id"], "status": run_status}})

    def conflict(store, user_id: str, approval_id: str) -> JSONResponse:
        row = store.get_approval(user_id, approval_id)
        label = DONE_LABELS.get((row or {}).get("status"), "已经处理过了")
        return no_store({"error": f"这一步{label}", **({"approval": view(row, detail=True)} if row else {})}, 409)
