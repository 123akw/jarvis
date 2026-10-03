"""新手引导的「看过没」（第十八轮，归新手引导代理）。

- ``GET /api/onboarding``  → ``{"seen": {tour_id: {"status": "done"|"skipped", "at": iso}}}``
- ``PUT /api/onboarding``  ``{"tour": id, "status": "done"|"skipped"}`` 记一笔；``{"reset": true}`` 清空（重新看全部引导）。

按账号存 tenant_prefs（键 ``onboarding``，JSON），换设备也只出现一次；游客由前端存 localStorage。
引导 id 只收 ``^[a-z][a-z0-9-]{1,31}$``，每个账号最多记 50 个（防止被灌爆）；库里读到的脏数据一律丢弃。
"""
from __future__ import annotations

import datetime
import json
import re

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from jarvis.tenancy import TenantMigrationError, tenant_scope

PREF_KEY = "onboarding"
TOUR_ID = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
STATUSES = ("done", "skipped")
MAX_TOURS = 50


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def valid_tour(value: object) -> bool:
    return isinstance(value, str) and bool(TOUR_ID.match(value))


def load_seen(store) -> dict[str, dict[str, str]]:
    """读出该账号看过的引导；JSON 坏了、条目不合规都当没有。"""
    raw = store.get_pref(PREF_KEY)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    seen: dict[str, dict[str, str]] = {}
    for tour, entry in data.items():
        if len(seen) >= MAX_TOURS:
            break
        if not valid_tour(tour) or not isinstance(entry, dict) or entry.get("status") not in STATUSES:
            continue
        seen[tour] = {"status": entry["status"], "at": str(entry.get("at") or "")[:40]}
    return seen


def record(store, tour: str, status: str, *, at: str | None = None) -> dict[str, dict[str, str]]:
    """记一笔（同一个引导覆盖旧记录）。调用方先校验 tour / status；满 50 个且是新引导时抛 ValueError。"""
    seen = load_seen(store)
    if tour not in seen and len(seen) >= MAX_TOURS:
        raise ValueError("看过的引导记录太多了，先重置一下再试")
    seen[tour] = {"status": status, "at": at or _now()}
    store.set_pref(PREF_KEY, json.dumps(seen, ensure_ascii=False))
    return seen


def reset(store) -> None:
    store.set_pref(PREF_KEY, None)


class OnboardingIn(BaseModel):
    tour: str | None = None
    status: str | None = None
    reset: bool = False


def register(app, *, request_principal, panel_write, deny, tenant_store) -> None:
    """挂上 GET / PUT /api/onboarding（鉴权、CSRF、租户隔离与任务台写接口同一套）。"""

    def migration_failed() -> JSONResponse:
        return JSONResponse({"error": "个人数据迁移失败"}, status_code=503, headers={"Cache-Control": "no-store"})

    def bad(message: str) -> JSONResponse:
        return JSONResponse({"error": message}, status_code=400, headers={"Cache-Control": "no-store"})

    @app.get("/api/onboarding")
    def onboarding_get(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                seen = load_seen(tenant_store())
        except TenantMigrationError:
            return migration_failed()
        return JSONResponse({"seen": seen}, headers={"Cache-Control": "no-store"})

    @app.put("/api/onboarding")
    def onboarding_put(request: Request, body: OnboardingIn):
        principal, err = panel_write(request)
        if err:
            return err
        if not body.reset:
            if not valid_tour(body.tour):
                return bad("不认识这个引导")
            if body.status not in STATUSES:
                return bad("引导状态只能是「看完」或「跳过」")
        try:
            with tenant_scope(principal.user_id):
                store = tenant_store()
                if body.reset:
                    reset(store)
                    seen: dict = {}
                else:
                    try:
                        seen = record(store, body.tour, body.status)
                    except ValueError as exc:
                        return bad(str(exc))
        except TenantMigrationError:
            return migration_failed()
        return JSONResponse({"ok": True, "seen": seen}, headers={"Cache-Control": "no-store"})
