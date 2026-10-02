"""插件管理 API（仅 Owner；写操作要 CSRF）：导入预览 / 确认、启用 / 停用 / 卸载、检查更新、插件源。

- ``GET  /api/plugins``                          管理清单（含停用的、坏掉的）+ 插件源
- ``POST /api/plugins/import/preview``           {url} 或 {zip_base64, zip_name}（可带 path 子目录）
- ``POST /api/plugins/import/confirm``           {token}
- ``POST /api/plugins/{id}/disable|enable``      内置插件也能停用
- ``DELETE /api/plugins/{id}``                   只能卸载导入的
- ``POST /api/plugins/{id}/check-update``        有新 commit 就返回升级预览（再走 confirm）
- ``GET|POST /api/plugins/sources``              插件源列表 / 添加并同步
- ``POST /api/plugins/sources/{sid}/sync``、``DELETE /api/plugins/sources/{sid}``
- ``POST /api/plugins/sources/{sid}/preview``    {name}：插件源里某个插件的安装预览
- ``POST /api/plugins/mcp/preview``              直接添加 MCP 服务：{name, url, icon?, summary?, headers?, key?}
                                                 → 测试连接 + 工具预览（再走 import/confirm）
- ``POST /api/plugins/{id}/config``              {values, clear}：保存 MCP 插件配置（密钥加密、永不回显）并自动测试
- ``POST /api/plugins/{id}/test``                测试连接、比对工具清单
- ``POST /api/plugins/{id}/approve``             {fingerprint}：确认变化后的工具清单，插件恢复

所有动作写审计日志（accounts.record_audit）。
"""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Path as PathParam, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from jarvis.plugins import importer, loader

log = logging.getLogger(__name__)

MAX_ZIP_B64 = (importer.MAX_DOWNLOAD_BYTES * 4) // 3 + 16
PluginId = Annotated[str, PathParam(min_length=2, max_length=31, pattern=r"^[a-z][a-z0-9_]+$")]


class ImportIn(BaseModel):
    url: str | None = Field(default=None, max_length=500)
    zip_base64: str | None = Field(default=None, max_length=MAX_ZIP_B64)
    zip_name: str | None = Field(default=None, max_length=200)
    path: str | None = Field(default=None, max_length=200)


class ConfirmIn(BaseModel):
    token: str = Field(min_length=8, max_length=100)


class SourcePreviewIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class ConfigIn(BaseModel):
    values: dict[str, str | None] = Field(default_factory=dict, max_length=10)
    clear: list[str] = Field(default_factory=list, max_length=10)


class ApproveIn(BaseModel):
    fingerprint: str = Field(default="", max_length=64)


class HeaderIn(BaseModel):
    name: str = Field(default="", max_length=64)
    value: str = Field(default="", max_length=2000)


class KeyIn(BaseModel):
    value: str = Field(default="", max_length=2000)
    mode: str = Field(default="bearer", pattern=r"^(bearer|header|query)$")
    name: str = Field(default="", max_length=64)


class McpAddIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    url: str = Field(min_length=8, max_length=1000)
    icon: str = Field(default="", max_length=16)
    summary: str = Field(default="", max_length=120)
    category: str = Field(default="info", max_length=20)
    transport: str = Field(default="", pattern=r"^(|streamable-http|sse)$")
    headers: list[HeaderIn] = Field(default_factory=list, max_length=5)
    key: KeyIn | None = None


def _json(content, status: int = 200) -> JSONResponse:
    return JSONResponse(content, status_code=status, headers={"Cache-Control": "no-store"})


def _failure(exc: importer.ImportFailure) -> JSONResponse:
    return _json(exc.body(), exc.status)


def register(app, *, accounts, request_principal, write_authorized, deny, csrf_deny) -> None:
    try:   # 启动时加载一次：插件包提供的积木要先注册进流程引擎
        loader.registry()
    except Exception as exc:
        log.warning("plugin registry load failed: %s", type(exc).__name__)

    def owner_reader(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return None, deny()
        if not principal.is_owner:
            return None, _json({"error": "只有管理员能管理插件"}, 403)
        return principal, None

    def owner_writer(request: Request):
        principal, err = owner_reader(request)
        if err:
            return None, err
        if not write_authorized(request):
            return None, csrf_deny()
        return principal, None

    def audit(action: str, principal, detail: str) -> None:
        try:
            accounts.record_audit(action, principal.user_id, f"{principal.username} {detail}")
        except Exception as exc:
            log.warning("plugin audit failed: %s", type(exc).__name__)

    def run(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs), None
        except importer.ImportFailure as exc:
            return None, _failure(exc)

    @app.get("/api/plugins")
    def plugins_list(request: Request):
        principal, err = owner_reader(request)
        if err:
            return err
        current = loader.registry()
        return _json({"plugins": current.management(), "sources": importer.list_sources(),
                      "generation": current.generation})

    @app.post("/api/plugins/import/preview")
    def plugins_preview(request: Request, body: ImportIn):
        principal, err = owner_writer(request)
        if err:
            return err
        if body.zip_base64:
            preview, fail = run(importer.preview_from_zip, body.zip_base64, body.zip_name or "", principal.user_id,
                                subpath=body.path or "")
        elif body.url:
            preview, fail = run(importer.preview_from_url, body.url, principal.user_id)
        else:
            return _json({"error": "填一个仓库地址，或上传插件 zip", "code": "BAD_REQUEST"}, 422)
        if fail:
            return fail
        audit("plugin_preview", principal, f"{preview['plugin']['id']} {preview['source'].get('type', '')}")
        return _json(preview)

    @app.post("/api/plugins/import/confirm")
    def plugins_confirm(request: Request, body: ConfirmIn):
        principal, err = owner_writer(request)
        if err:
            return err
        result, fail = run(importer.confirm, body.token, principal.user_id)
        if fail:
            return fail
        pack = loader.registry().by_id.get(result["id"])
        source = (pack.installed.get("source") if pack else None) or {}
        where = f"{source.get('type', '')}:{source.get('repo') or source.get('name') or ''}@{source.get('ref', '')[:12]}"
        audit("plugin_upgrade" if result["upgraded"] else "plugin_import", principal,
              f"id={result['id']} v={result['version']} {where}")
        return _json(result, 201)

    def toggle(request: Request, plugin_id: str, enabled: bool):
        principal, err = owner_writer(request)
        if err:
            return err
        current = loader.registry()
        if plugin_id not in current.by_id:
            return _json({"error": "没有这个插件", "code": "NOT_FOUND"}, 404)
        loader.set_enabled(plugin_id, enabled)
        audit("plugin_enable" if enabled else "plugin_disable", principal, f"id={plugin_id}")
        pack = loader.registry().by_id.get(plugin_id)
        return _json({"id": plugin_id, "enabled": enabled, "status": pack.status if pack else "unavailable",
                      "reason": pack.reason if pack else ""})

    @app.post("/api/plugins/{plugin_id}/disable")
    def plugins_disable(request: Request, plugin_id: PluginId):
        return toggle(request, plugin_id, False)

    @app.post("/api/plugins/{plugin_id}/enable")
    def plugins_enable(request: Request, plugin_id: PluginId):
        return toggle(request, plugin_id, True)

    @app.delete("/api/plugins/{plugin_id}")
    def plugins_delete(request: Request, plugin_id: PluginId):
        principal, err = owner_writer(request)
        if err:
            return err
        result, fail = run(importer.uninstall, plugin_id)
        if fail:
            return fail
        audit("plugin_uninstall", principal, f"id={plugin_id} removed={','.join(result['removed'])}")
        return _json(result)

    @app.post("/api/plugins/{plugin_id}/check-update")
    def plugins_check_update(request: Request, plugin_id: PluginId):
        principal, err = owner_writer(request)
        if err:
            return err
        result, fail = run(importer.check_update, plugin_id, principal.user_id)
        if fail:
            return fail
        audit("plugin_check_update", principal, f"id={plugin_id} update={result['has_update']}")
        return _json(result)

    # ---- MCP 插件（第十五轮）：配置、测试连接、确认工具变更、直接添加 ----

    @app.post("/api/plugins/mcp/preview")
    def mcp_add_preview(request: Request, body: McpAddIn):
        principal, err = owner_writer(request)
        if err:
            return err
        from jarvis.plugins import mcp
        preview, fail = run(mcp.preview_direct, principal.user_id, name=body.name, url=body.url, icon=body.icon,
                            summary=body.summary, category=body.category, transport=body.transport,
                            headers=[h.model_dump() for h in body.headers],
                            key=body.key.model_dump() if body.key else None)
        if fail:
            return fail
        audit("plugin_preview", principal, f"{preview['plugin']['id']} mcp {preview['source'].get('url', '')[:120]}")
        return _json(preview)

    @app.post("/api/plugins/{plugin_id}/config")
    def plugins_config(request: Request, plugin_id: PluginId, body: ConfigIn):
        principal, err = owner_writer(request)
        if err:
            return err
        from jarvis.plugins import mcp
        result, fail = run(mcp.configure, plugin_id, body.values, body.clear)
        if fail:
            return fail
        audit("plugin_config", principal, f"id={plugin_id} keys={','.join(result['saved'])[:200]}")   # 只记键名，不记值
        return _json(result)

    @app.post("/api/plugins/{plugin_id}/test")
    def plugins_test(request: Request, plugin_id: PluginId):
        principal, err = owner_writer(request)
        if err:
            return err
        from jarvis.plugins import mcp
        result, fail = run(mcp.test_connection, plugin_id)
        if fail:
            return fail
        audit("plugin_mcp_test", principal, f"id={plugin_id} outcome={result['outcome']} tools={len(result['tools'])}")
        return _json(result)

    @app.post("/api/plugins/{plugin_id}/approve")
    def plugins_approve(request: Request, plugin_id: PluginId, body: ApproveIn):
        principal, err = owner_writer(request)
        if err:
            return err
        from jarvis.plugins import mcp
        result, fail = run(mcp.approve, plugin_id, body.fingerprint)
        if fail:
            return fail
        audit("plugin_mcp_approve", principal, f"id={plugin_id} tools={len(result['tools'])}")
        return _json(result)

    # ---- 插件源 ----

    @app.get("/api/plugins/sources")
    def sources_list(request: Request):
        principal, err = owner_reader(request)
        if err:
            return err
        return _json({"sources": importer.list_sources()})

    @app.post("/api/plugins/sources")
    def sources_add(request: Request, body: ImportIn):
        principal, err = owner_writer(request)
        if err:
            return err
        result, fail = run(importer.add_source, principal.user_id, url=body.url or "",
                           zip_base64=body.zip_base64 or "", zip_name=body.zip_name or "")
        if fail:
            return fail
        audit("plugin_source_add", principal, f"id={result['id']} plugins={len(result['plugins'])}")
        return _json(result, 201)

    @app.post("/api/plugins/sources/{source_id}/sync")
    def sources_sync(request: Request, source_id: PluginId):
        principal, err = owner_writer(request)
        if err:
            return err
        result, fail = run(importer.sync_source, source_id)
        if fail:
            return fail
        audit("plugin_source_sync", principal, f"id={source_id}")
        return _json(result)

    @app.delete("/api/plugins/sources/{source_id}")
    def sources_delete(request: Request, source_id: PluginId):
        principal, err = owner_writer(request)
        if err:
            return err
        result, fail = run(importer.remove_source, source_id)
        if fail:
            return fail
        audit("plugin_source_remove", principal, f"id={source_id}")
        return _json(result)

    @app.post("/api/plugins/sources/{source_id}/preview")
    def sources_preview(request: Request, source_id: PluginId, body: SourcePreviewIn):
        principal, err = owner_writer(request)
        if err:
            return err
        preview, fail = run(importer.source_preview, source_id, body.name, principal.user_id)
        if fail:
            return fail
        audit("plugin_preview", principal, f"{preview['plugin']['id']} source={source_id}")
        return _json(preview)
