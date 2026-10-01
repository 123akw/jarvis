"""飞书桥的 Web 接口：状态、领取绑定码、解绑。鉴权函数由 server.py 注入，规则与微信接口一致。"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from jarvis.channels.feishu.bindings import BIND_CODE_TTL_SECONDS


def _no_store(payload: dict, status_code: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store"})


def register_routes(app, bridge, *, request_principal, write_authorized, deny, csrf_deny) -> None:
    def _writer(request: Request):
        principal = write_authorized(request)
        if principal:
            return principal, None
        return None, (csrf_deny() if request_principal(request)[0] else deny())

    @app.get("/api/feishu/status")
    def feishu_status(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        payload = bridge.status()
        if not principal.is_owner:
            payload["error"] = ""  # 连接错误细节（凭据/后台配置）只给 Owner 看
        payload["bound"] = bridge.bindings.count_for(principal.user_id) > 0
        return _no_store(payload)

    @app.post("/api/feishu/bind-code")
    def feishu_bind_code(request: Request):
        principal, error = _writer(request)
        if error is not None:
            return error
        code = bridge.bindings.issue_code(principal.user_id)
        return _no_store({"code": code, "expires_in": BIND_CODE_TTL_SECONDS, "command": f"绑定 {code}"})

    @app.post("/api/feishu/unbind")
    def feishu_unbind(request: Request):
        principal, error = _writer(request)
        if error is not None:
            return error
        return _no_store({"ok": True, "removed": bridge.bindings.unbind_user(principal.user_id)})
