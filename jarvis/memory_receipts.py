"""记忆回执：让「记住了什么」看得见、撤得回。

三件事，全部存在 tenant_prefs（v2 起就有的表），**不加表、不动 schema 版本**：
- 对话回执：profile_remember / profile_forget 的 ToolMessage.artifact 里带结构化回执，
  聊天 SSE 的 tool_result 事件原样透出 ``memory`` 字段（见 :func:`receipt_of`）；
- 夜间蒸馏批次：distill 写入的新画像编号记在 ``distill_fresh``（JSON，新批次覆盖旧批次），
  「今日」板据此显示「昨晚为你整理了 N 条记忆」，看过（或关掉）即清；
- 总开关：``memory_receipts`` = "off" 时网页不渲染回执（缺省开启）。
"""
from __future__ import annotations

import datetime
import json
import logging

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from jarvis.tenancy import MAX_ITEM_ID, TenantMigrationError, tenant_scope

log = logging.getLogger("jarvis")

FRESH_KEY = "distill_fresh"
RECEIPTS_KEY = "memory_receipts"
_ACTIONS = {"remember", "forget"}
_MAX_FRESH = 20


def receipt_of(message) -> dict | None:
    """从 ToolMessage 取出结构化记忆回执；不是记忆工具或格式不对返回 None。"""
    artifact = getattr(message, "artifact", None)
    memory = artifact.get("memory") if isinstance(artifact, dict) else None
    if not isinstance(memory, dict) or memory.get("action") not in _ACTIONS:
        return None
    item_id, content = memory.get("id"), memory.get("content")
    if not isinstance(item_id, int) or isinstance(item_id, bool) or not 1 <= item_id <= MAX_ITEM_ID:
        return None
    if not isinstance(content, str) or not content.strip():
        return None
    return {"action": memory["action"], "id": item_id, "content": content[:200]}


def sse_fields(message) -> dict:
    """聊天 SSE tool_result 事件的附加字段：有回执时 ``{"memory": {...}}``，否则空。"""
    receipt = receipt_of(message)
    return {"memory": receipt} if receipt else {}


def record_fresh(store, *, date: str, at: str, ids: list[int]) -> None:
    """记下一次蒸馏新写入的画像编号（新批次整体覆盖旧批次）。"""
    clean = [int(x) for x in ids if isinstance(x, int) and not isinstance(x, bool)][:_MAX_FRESH]
    if clean:
        store.set_pref(FRESH_KEY, json.dumps({"date": date, "at": at, "ids": clean}))


def fresh_notice(store, today: str) -> dict:
    """当天那批蒸馏里**仍然存在**的新画像；跨日、已看过、已被删光都返回 count=0。"""
    empty = {"count": 0, "ids": [], "date": "", "at": ""}
    raw = store.get_pref(FRESH_KEY)
    if not raw:
        return empty
    try:
        batch = json.loads(raw)
    except ValueError:
        return empty
    if not isinstance(batch, dict) or batch.get("date") != today:
        return empty
    wanted = {x for x in batch.get("ids") or [] if isinstance(x, int)}
    alive = [x["id"] for x in store.list_profile() if x["id"] in wanted]
    return {"count": len(alive), "ids": alive, "date": today, "at": str(batch.get("at") or "")}


def receipts_enabled(store) -> bool:
    return (store.get_pref(RECEIPTS_KEY) or "on") != "off"


class MemoryPrefsIn(BaseModel):
    receipts: bool


def register(app, *, request_principal, panel_write, tenant_store, deny, now_fn=None) -> None:
    """挂上 /api/memory 三个小接口（鉴权、CSRF、租户隔离与任务台写接口同一套）。"""
    now = now_fn or datetime.datetime.now

    def migration_failed() -> JSONResponse:
        return JSONResponse({"error": "个人数据迁移失败"}, status_code=503, headers={"Cache-Control": "no-store"})

    @app.get("/api/memory")
    def memory_state(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                store = tenant_store()
                return {"receipts": receipts_enabled(store),
                        "fresh": fresh_notice(store, now().strftime("%Y-%m-%d"))}
        except TenantMigrationError:
            return migration_failed()

    @app.put("/api/memory/prefs")
    def memory_prefs(request: Request, body: MemoryPrefsIn):
        principal, err = panel_write(request)
        if err:
            return err
        try:
            with tenant_scope(principal.user_id):
                tenant_store().set_pref(RECEIPTS_KEY, None if body.receipts else "off")
        except TenantMigrationError:
            return migration_failed()
        return {"ok": True, "receipts": body.receipts}

    @app.post("/api/memory/fresh/dismiss")
    def memory_fresh_dismiss(request: Request):
        principal, err = panel_write(request)
        if err:
            return err
        try:
            with tenant_scope(principal.user_id):
                tenant_store().set_pref(FRESH_KEY, None)
        except TenantMigrationError:
            return migration_failed()
        return {"ok": True}
