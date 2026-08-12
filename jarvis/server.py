"""网页端后端：FastAPI。账户、服务端会话 + SSE 流式聊天 + 仪表盘接口。"""
from contextlib import asynccontextmanager
from collections import OrderedDict, deque
import datetime
import json
import os
import time
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import AIMessageChunk, ToolMessage
from pydantic import BaseModel

from jarvis import __version__, config, wechat
from jarvis.accounts import AccountStore, Principal, csrf_token
from jarvis.graph import build_agent, heal_dangling_tool_calls
from jarvis.tenancy import TenantMigrationError, TenantStore, tenant_scope
from jarvis.tools import TOOLS
from jarvis.tools.location import get_location, locate_by_ip, set_location
from jarvis.tools.memo import all_memos
from jarvis.tools.schedule import all_schedule
from jarvis.tools.todo import all_todos


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """恢复持久微信桥；退出时停线程但不删除 Token。"""
    wechat.resume_on_boot()
    try:
        yield
    finally:
        wechat.shutdown()


app = FastAPI(title="J.A.R.V.I.S.", lifespan=lifespan)
_WEB = Path(__file__).parent / "web"
_agent = None
_started = datetime.datetime.now()
_chat_count = 0

_COOKIE = "jws_session"
_accounts = AccountStore()


class LoginAttemptLimiter:
    """Bounded in-memory rate limiter keyed by the direct ASGI client address."""

    def __init__(self, *, attempts: int = 5, window_seconds: int = 60, clock=time.monotonic) -> None:
        self.attempts = attempts
        self.window_seconds = window_seconds
        self.clock = clock
        self._entries: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def check(self, source: str) -> int | None:
        now = self.clock()
        with self._lock:
            values = self._entries.setdefault(source, deque())
            self._entries.move_to_end(source)
            while values and now - values[0] >= self.window_seconds:
                values.popleft()
            if len(values) >= self.attempts:
                return max(1, int(self.window_seconds - (now - values[0])))
            values.append(now)
            while len(self._entries) > 1024:
                self._entries.popitem(last=False)
        return None

    def success(self, source: str) -> None:
        with self._lock:
            self._entries.pop(source, None)


_login_limiter = LoginAttemptLimiter()


@app.exception_handler(RequestValidationError)
async def invalid_request(_request: Request, _error: RequestValidationError):
    """Avoid FastAPI's default echo of invalid request fields, including passwords."""
    return JSONResponse({"error": "请求格式不正确"}, status_code=422, headers={"Cache-Control": "no-store"})


def _request_principal(request: Request) -> tuple[Principal | None, str]:
    """Resolve only normal API transports: web cookie or desktop header."""
    cookie = request.cookies.get(_COOKIE, "")
    if cookie:
        return _accounts.principal_for_token(cookie, "web"), cookie
    desktop_token = request.headers.get("x-jws-token", "")
    if desktop_token:
        return _accounts.principal_for_token(desktop_token, "desktop"), desktop_token
    return None, ""


def _client_address(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _rate_limited(request: Request) -> JSONResponse | None:
    retry_after = _login_limiter.check(_client_address(request))
    if retry_after is None:
        return None
    return JSONResponse(
        {"error": "尝试过多，请稍后再试"}, status_code=429,
        headers={"Retry-After": str(retry_after), "Cache-Control": "no-store"},
    )


def _authed(request: Request) -> bool:
    return _request_principal(request)[0] is not None


def _write_authorized(request: Request) -> Principal | None:
    principal, token = _request_principal(request)
    if not principal:
        return None
    if principal.transport == "web" and not _accounts.csrf_valid(
        principal, token, request.headers.get("x-jws-csrf", "")
    ):
        return None
    return principal


def _deny() -> JSONResponse:
    return JSONResponse({"error": "未登录"}, status_code=401, headers={"Cache-Control": "no-store"})


def _csrf_deny() -> JSONResponse:
    return JSONResponse({"error": "CSRF 校验失败"}, status_code=403, headers={"Cache-Control": "no-store"})


def _sensitive_json(content: object, status_code: int = 200) -> JSONResponse:
    return JSONResponse(content, status_code=status_code, headers={"Cache-Control": "no-store"})


def _get_agent():
    global _agent
    if _agent is None:
        _agent = build_agent()
    return _agent


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# ---------- 登录 ----------

class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(request: Request, body: LoginIn):
    if not os.getenv("JARVIS_SESSION_SECRET") or len(os.getenv("JARVIS_SESSION_SECRET", "").encode("utf-8")) < 32:
        return JSONResponse({"error": "服务未配置"}, status_code=503, headers={"Cache-Control": "no-store"})
    if limited := _rate_limited(request):
        return limited
    authenticated = _accounts.authenticate(body.username, body.password, "web")
    if not authenticated:
        return JSONResponse({"error": "账号或口令不对"}, status_code=401, headers={"Cache-Control": "no-store"})
    _login_limiter.success(_client_address(request))
    _principal, token, _csrf = authenticated
    resp = JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
    resp.set_cookie(
        _COOKIE, token, max_age=30 * 86400, httponly=True, samesite="strict", path="/",
        secure=not (os.getenv("JARVIS_ENV", "").lower() in {"development", "dev", "test"}
                    and os.getenv("JARVIS_ALLOW_INSECURE_COOKIE") == "1"),
    )
    return resp


@app.post("/api/desktop/login")
def desktop_login(request: Request, body: LoginIn):
    if limited := _rate_limited(request):
        return limited
    user = _accounts.authenticate_user(body.username, body.password)
    if not user:
        return JSONResponse({"error": "账号或口令不对"}, status_code=401, headers={"Cache-Control": "no-store"})
    issued = _accounts.issue_desktop_and_openai(user[0])
    if not issued:
        return JSONResponse({"error": "服务不可用"}, status_code=503, headers={"Cache-Control": "no-store"})
    _login_limiter.success(_client_address(request))
    (_desktop_principal, token), (_openai_principal, openai_token) = issued
    return JSONResponse(
        {
            "access_token": token,
            "token_type": "x-jws-token",
            "openai_token": openai_token,
            "openai_token_type": "bearer",
        },
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/logout")
def logout(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    if principal.transport == "web" and not _write_authorized(request):
        return _csrf_deny()
    _accounts.revoke_session(principal.session_id)
    resp = _sensitive_json({"ok": True})
    resp.delete_cookie(_COOKIE, path="/")
    return resp


@app.get("/api/session")
def session(request: Request):
    principal, token = _request_principal(request)
    if not principal:
        return JSONResponse({"authed": False}, headers={"Cache-Control": "no-store"})
    response = {
        "authed": True,
        "username": principal.username,
        "role": principal.role,
        "expires_at": _accounts.expiry_for(principal),
    }
    if principal.transport == "web":
        response["csrf_token"] = csrf_token(token, principal.session_id)
    return JSONResponse(response, headers={"Cache-Control": "no-store"})


class UserCreateIn(BaseModel):
    username: str
    password: str
    role: str = "Member"


class UserPatchIn(BaseModel):
    username: str | None = None
    password: str | None = None
    role: str | None = None
    active: bool | None = None


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


def _owner_for_write(request: Request) -> Principal | JSONResponse:
    principal, _token = _request_principal(request)
    if not principal:
        return _sensitive_json({"error": "未登录"}, 401)
    if not _write_authorized(request):
        return _sensitive_json({"error": "CSRF 校验失败"}, 403)
    if not principal.is_owner:
        return _sensitive_json({"error": "权限不足"}, 403)
    return principal


@app.get("/api/admin/users")
def users(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _sensitive_json({"error": "未登录"}, 401)
    if not principal.is_owner:
        return _sensitive_json({"error": "权限不足"}, 403)
    return _sensitive_json(_accounts.list_users())


@app.post("/api/admin/users")
def create_user(request: Request, body: UserCreateIn):
    allowed = _owner_for_write(request)
    if isinstance(allowed, JSONResponse):
        return allowed
    created = _accounts.create_user(body.username, body.password, body.role)
    if not created:
        return _sensitive_json({"error": "无法创建用户"}, 400)
    return _sensitive_json(created, 201)


@app.patch("/api/admin/users/{user_id}")
def update_user(user_id: str, request: Request, body: UserPatchIn):
    allowed = _owner_for_write(request)
    if isinstance(allowed, JSONResponse):
        return allowed
    updated = _accounts.update_user(user_id, **body.model_dump(exclude_unset=True))
    if not updated:
        return _sensitive_json({"error": "无法更新用户"}, 409)
    return _sensitive_json(updated)


@app.post("/api/account/password")
def change_password(request: Request, body: PasswordChangeIn):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    if not _accounts.change_password(principal, body.current_password, body.new_password):
        return _sensitive_json({"error": "当前口令不对或新口令无效"}, 400)
    resp = _sensitive_json({"ok": True})
    resp.delete_cookie(_COOKIE, path="/")
    return resp


# ---------- 会话管理 ----------

def _tenant_store() -> TenantStore:
    """Migrate only after account bootstrap; malformed legacy state fails closed."""
    store = TenantStore()
    store.migrate_legacy()
    return store


def _upsert_thread(owner_id: str, alias: str, first_message: str):
    with tenant_scope(owner_id):
        return _tenant_store().upsert_thread(alias, first_message)


@app.get("/api/threads")
def threads(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            return _tenant_store().list_threads()
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)


@app.get("/api/history")
def history(request: Request, thread_id: str):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            thread = _tenant_store().get_thread(thread_id)
            if not thread:
                return JSONResponse({"error": "未找到对话"}, status_code=404)
            state = _get_agent().get_state({"configurable": {"thread_id": thread.checkpoint_thread_id}})
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    out = []
    for m in (state.values or {}).get("messages", []):
        if m.type == "human":
            out.append({"role": "user", "content": _chunk_text(m.content)})
        elif m.type == "ai":
            text = _chunk_text(m.content)
            if text.strip():
                out.append({"role": "assistant", "content": text})
    return out


@app.delete("/api/thread")
def delete_thread(request: Request, thread_id: str):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    try:
        with tenant_scope(principal.user_id):
            thread = _tenant_store().delete_thread(thread_id)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not thread:
        return JSONResponse({"error": "未找到对话"}, status_code=404)
    try:
        _get_agent().checkpointer.delete_thread(thread.checkpoint_thread_id)
    except Exception:
        pass  # 记忆库里没有该线程也算删除成功
    return {"ok": True}


# ---------- 个人微信接入 ----------

@app.get("/api/wechat/status")
def wechat_status(request: Request):
    if not _authed(request):
        return _deny()
    return wechat.status()


@app.post("/api/wechat/connect")
def wechat_connect(request: Request):
    if not _write_authorized(request):
        return _csrf_deny() if _authed(request) else _deny()
    return wechat.connect()


@app.post("/api/wechat/disconnect")
def wechat_disconnect(request: Request):
    if not _write_authorized(request):
        return _csrf_deny() if _authed(request) else _deny()
    return wechat.disconnect()


# ---------- 桌面端状态同步 ----------

class LocalStatusIn(BaseModel):
    coding: list[dict] = []


@app.post("/api/local-status")
def local_status(request: Request, body: LocalStatusIn):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    with tenant_scope(principal.user_id):
        _tenant_store().set_local_status(body.coding)
    return {"ok": True}


# ---------- 业务接口（登录后可用） ----------

@app.get("/api/dashboard")
def dashboard(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            _tenant_store()
            todos = all_todos()
            pending = [t for t in todos if not t["done"]]
            location = get_location()
            memos = all_memos()
            schedule = all_schedule()
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {
        "version": __version__,
        "tools": len(TOOLS),
        "place": (location or {}).get("place", ""),
        "model": config.model_name(),
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "uptime_min": int((datetime.datetime.now() - _started).total_seconds() // 60),
        "chats": _chat_count,
        "memos": memos,
        "schedule": schedule,
        "todos": pending,
        "todos_done": len(todos) - len(pending),
    }


class ChatIn(BaseModel):
    message: str
    thread_id: str = "web"
    location: dict | None = None  # 浏览器定位 {lat, lon}，可选


def _update_location(request: Request, body: "ChatIn") -> None:
    loc = body.location or {}
    if isinstance(loc.get("lat"), (int, float)) and isinstance(loc.get("lon"), (int, float)):
        set_location(loc["lat"], loc["lon"], source="浏览器")
        return
    if get_location() is None:  # 没有任何定位时才用 IP 兜底
        ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "")
        hit = locate_by_ip(ip)
        if hit:
            set_location(hit["lat"], hit["lon"], source="IP")


def _chunk_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


@app.post("/api/chat")
def chat(request: Request, body: ChatIn):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    try:
        with tenant_scope(principal.user_id):
            _tenant_store()
            try:
                _update_location(request, body)
            except Exception:
                pass  # 定位失败不拦对话
            thread = _tenant_store().upsert_thread(body.thread_id, body.message)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)

    def gen():
        global _chat_count
        _chat_count += 1
        seen_calls: set[str] = set()
        try:
            with tenant_scope(principal.user_id):
                heal_dangling_tool_calls(_get_agent(), thread.checkpoint_thread_id)
                stream = _get_agent().stream(
                    {"messages": [{"role": "user", "content": body.message}]},
                    config={"configurable": {"thread_id": thread.checkpoint_thread_id}}, stream_mode="messages")
                for chunk, _meta in stream:
                    if isinstance(chunk, ToolMessage):
                        yield _sse({"type": "tool_result", "name": chunk.name})
                    elif isinstance(chunk, AIMessageChunk):
                        for tc in chunk.tool_call_chunks or []:
                            name, cid = tc.get("name"), tc.get("id")
                            if name and cid and cid not in seen_calls:
                                seen_calls.add(cid)
                                yield _sse({"type": "tool_start", "name": name})
                        text = _chunk_text(chunk.content)
                        if text:
                            yield _sse({"type": "token", "text": text})
            yield _sse({"type": "done"})
        except Exception as e:  # 网络/模型异常兜底，前端提示而不是断流
            yield _sse({"type": "error", "message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------- OpenAI 兼容接口（供 Hermes 等生态工具把贾维斯当模型接入） ----------

class OAIMessage(BaseModel):
    role: str
    content: object = ""


class OAIChatIn(BaseModel):
    model: str = "jarvis"
    messages: list[OAIMessage] = []
    stream: bool = False


def _bearer_principal(request: Request) -> Principal | None:
    auth = request.headers.get("authorization", "")
    return _accounts.principal_for_token(auth[7:], "openai") if auth.startswith("Bearer ") else None


def _oai_user_text(messages: list[OAIMessage]) -> str:
    for m in reversed(messages):
        if m.role != "user":
            continue
        c = m.content
        if isinstance(c, list):
            c = "".join(p.get("text", "") for p in c if isinstance(p, dict))
        return str(c)
    return ""


@app.post("/v1/chat/completions")
def oai_chat(request: Request, body: OAIChatIn):
    principal = _bearer_principal(request)
    if not principal:
        return JSONResponse({"error": {"message": "unauthorized"}}, status_code=401)
    text = _oai_user_text(body.messages)
    if not text.strip():
        return JSONResponse({"error": {"message": "empty user message"}}, status_code=400)
    # 多轮记忆在贾维斯侧（按线程），外部只需传最后一句
    alias = request.headers.get("x-thread-id", "openai")
    try:
        with tenant_scope(principal.user_id):
            _tenant_store()
            thread = _tenant_store().upsert_thread(alias, text)
    except TenantMigrationError:
        return JSONResponse({"error": {"message": "tenant migration failed"}}, status_code=503)
    rid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    if not body.stream:
        with tenant_scope(principal.user_id):
            heal_dangling_tool_calls(_get_agent(), thread.checkpoint_thread_id)
            result = _get_agent().invoke({"messages": [{"role": "user", "content": text}]}, config={"configurable": {"thread_id": thread.checkpoint_thread_id}})
        reply = _chunk_text(result["messages"][-1].content)
        return {
            "id": rid, "object": "chat.completion", "created": created, "model": "jarvis",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": reply}}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    def gen():
        def chunk(delta, finish=None):
            return "data: " + json.dumps({
                "id": rid, "object": "chat.completion.chunk", "created": created,
                "model": "jarvis",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }, ensure_ascii=False) + "\n\n"
        yield chunk({"role": "assistant"})
        try:
            with tenant_scope(principal.user_id):
                heal_dangling_tool_calls(_get_agent(), thread.checkpoint_thread_id)
                stream = _get_agent().stream({"messages": [{"role": "user", "content": text}]}, config={"configurable": {"thread_id": thread.checkpoint_thread_id}}, stream_mode="messages")
                for ck, _meta in stream:
                    if isinstance(ck, AIMessageChunk):
                        t = _chunk_text(ck.content)
                        if t:
                            yield chunk({"content": t})
        except Exception as e:
            yield chunk({"content": f"（出错了：{type(e).__name__}）"})
        yield chunk({}, finish="stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


# ---------- 静态页 ----------

@app.get("/")
def index():
    return FileResponse(_WEB / "index.html")


if (_WEB / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=_WEB / "assets"), name="assets")


wechat.init(_get_agent, _chunk_text, _accounts.unique_active_owner)


def run() -> None:
    import uvicorn

    config.load_env()
    port = int(os.getenv("JARVIS_PORT", "7789"))
    print(f"J.A.R.V.I.S. 网页端已上线：http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    run()
