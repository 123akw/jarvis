"""网页端后端：FastAPI。账户、服务端会话 + SSE 流式聊天 + 仪表盘接口。"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from collections import OrderedDict, deque
import datetime
import hashlib
import json
import logging
import os
import secrets
import time
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import AIMessageChunk, ToolMessage
from pydantic import BaseModel, SecretStr

from jarvis import __version__, config, wechat
from jarvis.accounts import AccountStore, Principal, csrf_token, session_secret_configured
from jarvis.graph import build_agent, heal_dangling_tool_calls
from jarvis.provider_runtime import AgentRuntimeManager, probe_integration
from jarvis.provider_settings import (
    ProviderSettingsError, ResolvedLLM, SecretStore, credential_scope,
    normalize_base_url, normalize_searxng_url,
)
from jarvis.tenancy import TenantMigrationError, TenantStore, tenant_scope
from jarvis.tools import TOOLS
from jarvis.tools.location import get_location, locate_by_ip, set_location
from jarvis.voice.gateway import register_voice
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
        if _runtime_manager is not None:
            _runtime_manager.close()


log = logging.getLogger(__name__)

# Agent 长任务专用线程池：与 AnyIO 默认线程池（承载 /api/dashboard 等轻量
# sync 路由）隔离，聊天再慢也不抢轻请求的票；且整段流式在同一线程内运行，
# tenant_scope 等 contextvars 不会因跨线程恢复而断裂。
# 大小可用启动环境变量 JARVIS_AGENT_WORKERS 调整（默认 8，≤20 人够用）。
_agent_pool = ThreadPoolExecutor(
    max_workers=max(1, int(os.getenv("JARVIS_AGENT_WORKERS", "8") or "8")),
    thread_name_prefix="jarvis-agent",
)


def _stream_from_agent_thread(sync_gen_factory):
    """把同步 SSE 生成器整段交给专用线程执行，事件经 asyncio 队列回传前端。"""

    async def event_stream():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        finished = object()

        def pump():
            try:
                for item in sync_gen_factory():
                    loop.call_soon_threadsafe(queue.put_nowait, item)
            except Exception as exc:  # 生成器自身已兜底，这里只防线程静默死亡
                log.exception("agent stream pump crashed: %s", type(exc).__name__)
            finally:
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, finished)
                except RuntimeError:
                    pass  # 事件循环已关闭（连接断开/停机），无人再消费

        _agent_pool.submit(pump)
        while True:
            item = await queue.get()
            if item is finished:
                return
            yield item

    return event_stream()


app = FastAPI(title="J.A.R.V.I.S.", lifespan=lifespan)
_WEB = Path(__file__).parent / "web"
_agent = None
_provider_store = SecretStore()
_runtime_manager: AgentRuntimeManager | None = None
_started = datetime.datetime.now()
_chat_count = 0

_COOKIE = "jws_session"
_accounts = AccountStore()


class LoginAttemptLimiter:
    """Bounded per-identity and source-wide limiter shared by login transports."""

    def __init__(self, *, attempts: int = 5, spray_attempts: int = 25,
                 window_seconds: int = 60, clock=time.monotonic, max_entries: int = 1024) -> None:
        self.attempts = attempts
        self.spray_attempts = spray_attempts
        self.window_seconds = window_seconds
        self.clock = clock
        self.max_entries = max_entries
        self._entries: OrderedDict[tuple[str, str], deque[float]] = OrderedDict()
        self._spray: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def _normalized(value: str, fallback: str = "") -> str:
        normalized = str(value).strip().casefold()
        return (normalized or fallback)[:256]

    def _prune(self, values: deque[float], now: float) -> None:
        while values and now - values[0] >= self.window_seconds:
            values.popleft()

    def _retry_after(self, values: deque[float], now: float) -> int:
        return max(1, int(self.window_seconds - (now - values[0])))

    def check(self, source: str, username: str = "") -> int | None:
        now = self.clock()
        normalized_source = self._normalized(source, "unknown")
        key = (normalized_source, self._normalized(username))
        with self._lock:
            values = self._entries.setdefault(key, deque())
            spray = self._spray.setdefault(normalized_source, deque())
            self._entries.move_to_end(key)
            self._spray.move_to_end(normalized_source)
            self._prune(values, now)
            self._prune(spray, now)
            if len(values) >= self.attempts:
                return self._retry_after(values, now)
            if len(spray) >= self.spray_attempts:
                return self._retry_after(spray, now)
            values.append(now)
            spray.append(now)
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)
            while len(self._spray) > self.max_entries:
                self._spray.popitem(last=False)
        return None

    def success(self, source: str, username: str = "") -> None:
        normalized_source = self._normalized(source, "unknown")
        key = (normalized_source, self._normalized(username))
        with self._lock:
            self._entries.pop(key, None)
            # check() reserves one source slot before password work. Remove only
            # this successful attempt; earlier failures from every username stay.
            spray = self._spray.get(normalized_source)
            if spray:
                spray.pop()
                if not spray:
                    self._spray.pop(normalized_source, None)


_login_limiter = LoginAttemptLimiter()
_settings_limiter = LoginAttemptLimiter(attempts=10, spray_attempts=50, window_seconds=60)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request: Request, _error: RequestValidationError):
    """Avoid FastAPI's default echo of invalid request fields, including passwords."""
    return JSONResponse({"error": "请求格式不正确"}, status_code=422, headers={"Cache-Control": "no-store"})


@app.exception_handler(ProviderSettingsError)
async def provider_settings_error(_request: Request, error: ProviderSettingsError):
    """Return only stable, redacted Provider errors."""
    return JSONResponse(
        {"error": error.message, "code": error.code},
        status_code=error.status,
        headers={"Cache-Control": "no-store"},
    )


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


def _rate_limited(request: Request, username: str) -> JSONResponse | None:
    retry_after = _login_limiter.check(_client_address(request), username)
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


@contextmanager
def _bundle_for(user_id: str):
    """Use leased per-user runtimes in production; keep test/legacy injection compatible."""
    if _runtime_manager is None:
        yield type("LegacyBundle", (), {"agent": _get_agent()})()
        return
    with _runtime_manager.acquire(user_id) as bundle:
        yield bundle


def _initialize_runtime() -> None:
    global _provider_store, _runtime_manager
    _provider_store = SecretStore()
    _runtime_manager = AgentRuntimeManager(_provider_store)
    wechat.init(
        _get_agent, _chunk_text, _accounts.unique_active_owner,
        runtime_getter=lambda user_id: _runtime_manager.acquire(user_id),
    )


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _public_runtime_error(error: Exception) -> str:
    if isinstance(error, ProviderSettingsError):
        return error.message
    return "模型或网络请求失败，请检查当前 API 配置后重试"


# ---------- 登录 ----------

class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(request: Request, body: LoginIn):
    if not session_secret_configured():
        return JSONResponse({"error": "服务未配置"}, status_code=503, headers={"Cache-Control": "no-store"})
    if limited := _rate_limited(request, body.username):
        return limited
    authenticated = _accounts.authenticate(body.username, body.password, "web")
    if not authenticated:
        return JSONResponse({"error": "账号或口令不对"}, status_code=401, headers={"Cache-Control": "no-store"})
    _login_limiter.success(_client_address(request), body.username)
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
    if limited := _rate_limited(request, body.username):
        return limited
    user = _accounts.authenticate_user(body.username, body.password)
    if not user:
        return JSONResponse({"error": "账号或口令不对"}, status_code=401, headers={"Cache-Control": "no-store"})
    issued = _accounts.issue_desktop_and_openai(user[0])
    if not issued:
        return JSONResponse({"error": "服务不可用"}, status_code=503, headers={"Cache-Control": "no-store"})
    _login_limiter.success(_client_address(request), body.username)
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
            with _bundle_for(principal.user_id) as bundle:
                state = bundle.agent.get_state({"configurable": {"thread_id": thread.checkpoint_thread_id}})
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
        with _bundle_for(principal.user_id) as bundle:
            bundle.agent.checkpointer.delete_thread(thread.checkpoint_thread_id)
    except Exception:
        pass  # 记忆库里没有该线程也算删除成功
    return {"ok": True}


# ---------- 个人微信接入 ----------

def _wechat_owner(principal: Principal) -> bool:
    """WeChat has one fixed account, not merely an Owner role permission."""
    owner = _accounts.unique_active_owner()
    return bool(owner and owner.user_id == principal.user_id)

@app.get("/api/wechat/status")
def wechat_status(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    if not _wechat_owner(principal):
        return _sensitive_json({"error": "权限不足"}, 403)
    return wechat.status()


@app.post("/api/wechat/connect")
def wechat_connect(request: Request):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    if not _wechat_owner(principal):
        return _sensitive_json({"error": "权限不足"}, 403)
    return wechat.connect()


@app.post("/api/wechat/disconnect")
def wechat_disconnect(request: Request):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    if not _wechat_owner(principal):
        return _sensitive_json({"error": "权限不足"}, 403)
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
        "model": _provider_store.status(principal.user_id, owner=principal.is_owner)["llm"]["model"],
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
                with _bundle_for(principal.user_id) as bundle:
                    heal_dangling_tool_calls(bundle.agent, thread.checkpoint_thread_id)
                    stream = bundle.agent.stream(
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
        except Exception as e:  # 不把上游响应、URL 或凭据带回前端
            log.exception("chat stream failed: %s", type(e).__name__)
            yield _sse({"type": "error", "message": _public_runtime_error(e)})

    return StreamingResponse(
        _stream_from_agent_thread(gen), media_type="text/event-stream",
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
            with _bundle_for(principal.user_id) as bundle:
                heal_dangling_tool_calls(bundle.agent, thread.checkpoint_thread_id)
                result = bundle.agent.invoke({"messages": [{"role": "user", "content": text}]}, config={"configurable": {"thread_id": thread.checkpoint_thread_id}})
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
                with _bundle_for(principal.user_id) as bundle:
                    heal_dangling_tool_calls(bundle.agent, thread.checkpoint_thread_id)
                    stream = bundle.agent.stream({"messages": [{"role": "user", "content": text}]}, config={"configurable": {"thread_id": thread.checkpoint_thread_id}}, stream_mode="messages")
                    for ck, _meta in stream:
                        if isinstance(ck, AIMessageChunk):
                            t = _chunk_text(ck.content)
                            if t:
                                yield chunk({"content": t})
        except Exception as e:
            yield chunk({"content": f"（{_public_runtime_error(e)}）"})
        yield chunk({}, finish="stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(_stream_from_agent_thread(gen), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


# ---------- Provider / API Key 设置 ----------

class LLMSettingsIn(BaseModel):
    provider: str
    base_url: str = ""
    model: str
    api_key: SecretStr | None = None
    keep_existing_key: bool = False
    admin_password: SecretStr
    expected_generation: int


class SettingsDeleteIn(BaseModel):
    admin_password: SecretStr
    expected_generation: int


class IntegrationSettingsIn(BaseModel):
    enabled: bool
    base_url: str = ""
    api_key: SecretStr | None = None
    keep_existing_key: bool = False
    admin_password: SecretStr
    expected_generation: int


def _settings_manager() -> AgentRuntimeManager:
    global _runtime_manager
    if _runtime_manager is None:
        _runtime_manager = AgentRuntimeManager(_provider_store)
    return _runtime_manager


def _settings_identity(request: Request, password: SecretStr, *, owner: bool = False) -> Principal | JSONResponse:
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    if owner and not principal.is_owner:
        return _sensitive_json({"error": "权限不足", "code": "AUTH_FAILED"}, 403)
    source = _client_address(request)
    if retry := _settings_limiter.check(source, principal.username):
        return JSONResponse(
            {"error": "尝试过多，请稍后再试", "code": "RATE_LIMITED"},
            status_code=429,
            headers={"Retry-After": str(retry), "Cache-Control": "no-store"},
        )
    verified = _accounts.authenticate_user(principal.username, password.get_secret_value())
    if not verified or verified[0] != principal.user_id:
        return _sensitive_json({"error": "身份验证失败", "code": "AUTH_FAILED"}, 401)
    _settings_limiter.success(source, principal.username)
    return principal


def _llm_candidate(user_id: str, body: LLMSettingsIn) -> ResolvedLLM:
    current = _provider_store.resolved_llm(user_id)
    if current.generation != body.expected_generation:
        from jarvis.provider_settings import ConfigConflict
        raise ConfigConflict()
    provider = body.provider.strip().lower()
    base = normalize_base_url(provider, body.base_url)
    model = body.model.strip()
    if not model or len(model) > 200:
        raise ProviderSettingsError("MODEL_NOT_FOUND", "模型名称无效")
    key = body.api_key.get_secret_value() if body.api_key is not None else ""
    if not key and body.keep_existing_key and credential_scope(provider, base) == credential_scope(current.provider, current.base_url):
        key = current.api_key
    if not key:
        raise ProviderSettingsError("PROVIDER_AUTH", "请填写新的 API Key")
    return ResolvedLLM(provider, base, model, key, body.expected_generation + 1, "managed")


@app.get("/api/settings/providers")
def provider_status(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    return _sensitive_json(_provider_store.status(principal.user_id, owner=principal.is_owner))


@app.post("/api/settings/llm/test")
def provider_test(request: Request, body: LLMSettingsIn):
    principal = _settings_identity(request, body.admin_password)
    if isinstance(principal, JSONResponse): return principal
    result = _settings_manager().test_llm(_llm_candidate(principal.user_id, body))
    return _sensitive_json(result)


@app.put("/api/settings/llm")
def provider_save(request: Request, body: LLMSettingsIn):
    principal = _settings_identity(request, body.admin_password)
    if isinstance(principal, JSONResponse): return principal
    candidate = _llm_candidate(principal.user_id, body)
    committed, probe = _settings_manager().apply_llm(
        principal.user_id,
        {"provider": candidate.provider, "base_url": candidate.base_url, "model": candidate.model,
         "api_key": candidate.api_key},
        expected_generation=body.expected_generation,
        keep_existing_key=body.keep_existing_key,
    )
    return _sensitive_json({"llm": {
        "provider": committed.provider, "base_url": committed.base_url, "model": committed.model,
        "key_configured": True, "source": committed.source, "generation": committed.generation,
    }, "probe": probe})


@app.delete("/api/settings/llm")
def provider_restore(request: Request, body: SettingsDeleteIn):
    principal = _settings_identity(request, body.admin_password)
    if isinstance(principal, JSONResponse): return principal
    restored = _settings_manager().restore_llm(principal.user_id, expected_generation=body.expected_generation)
    return _sensitive_json({"llm": {
        "provider": restored.provider, "base_url": restored.base_url, "model": restored.model,
        "key_configured": bool(restored.api_key), "source": restored.source,
        "generation": restored.generation,
    }})


def _integration_candidate(name: str, body: IntegrationSettingsIn) -> dict:
    if name == "searxng":
        return {"enabled": body.enabled, "base_url": normalize_searxng_url(body.base_url)}
    if name not in {"tavily", "pandascore"}:
        raise ProviderSettingsError("INVALID_URL", "未知联网 Provider")
    current = _provider_store.integration_values()[name]
    key = body.api_key.get_secret_value() if body.api_key is not None else ""
    if not key and body.keep_existing_key: key = current.get("api_key", "")
    if body.enabled and not key: raise ProviderSettingsError("PROVIDER_AUTH", "启用后必须填写 API Key")
    return {"enabled": body.enabled, "api_key": key}


@app.post("/api/settings/integrations/{name}/test")
def integration_test(name: str, request: Request, body: IntegrationSettingsIn):
    principal = _settings_identity(request, body.admin_password, owner=True)
    if isinstance(principal, JSONResponse): return principal
    candidate = _integration_candidate(name, body)
    if not candidate["enabled"]:
        return _sensitive_json({"ok": True, "disabled": True, "latency_ms": 0})
    return _sensitive_json(probe_integration(name, candidate))


@app.put("/api/settings/integrations/{name}")
def integration_save(name: str, request: Request, body: IntegrationSettingsIn):
    principal = _settings_identity(request, body.admin_password, owner=True)
    if isinstance(principal, JSONResponse): return principal
    candidate = _integration_candidate(name, body)
    probe = {"ok": True, "disabled": True, "latency_ms": 0} if not candidate["enabled"] else probe_integration(name, candidate)
    status = _provider_store.commit_integration(
        name, {**candidate, "healthy": True if candidate["enabled"] else None},
        expected_generation=body.expected_generation,
        keep_existing_key=body.keep_existing_key,
    )
    _settings_manager().invalidate_search()
    return _sensitive_json({"integration": status, "probe": probe})


@app.delete("/api/settings/integrations/{name}")
def integration_restore(name: str, request: Request, body: SettingsDeleteIn):
    principal = _settings_identity(request, body.admin_password, owner=True)
    if isinstance(principal, JSONResponse): return principal
    status = _provider_store.delete_integration(name, expected_generation=body.expected_generation)
    _settings_manager().invalidate_search()
    return _sensitive_json({"integration": status})


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
    _initialize_runtime()
    port = int(os.getenv("JARVIS_PORT", "7789"))
    print(f"J.A.R.V.I.S. 网页端已上线：http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


# ---- 语音 ----

def _count_voice_chat() -> None:
    """语音回合与文字聊天共用同一个仪表盘计数。"""
    global _chat_count
    _chat_count += 1


register_voice(
    app,
    cookie_name=_COOKIE,
    accounts=_accounts,
    bundle_for=_bundle_for,
    tenant_store=_tenant_store,
    chunk_text=_chunk_text,
    public_error=_public_runtime_error,
    count_chat=_count_voice_chat,
)


if __name__ == "__main__":
    run()


# ---- 桌面接管 ----
# 一次性接管票据：网页会话领票（60 秒时效、绑定用户、内存存储重启即失效），
# 桌面端凭票换令牌（复用 issue_desktop_and_openai，不经过密码）。
# 票据仅存 sha256 哈希，明文不落库不落日志。

_HANDOFF_TTL_SECONDS = 60
_handoff_lock = threading.Lock()
_handoff_tickets: dict[str, tuple[str, float]] = {}  # sha256(票) -> (user_id, 过期时刻)
_handoff_now = time.time  # 测试可注入的时钟


def _handoff_digest(ticket: str) -> str:
    return hashlib.sha256(ticket.encode("utf-8")).hexdigest()


def _handoff_prune_locked() -> None:
    """持锁调用：清掉已过期票据，保证内存表有界。"""
    deadline = _handoff_now()
    for digest in [d for d, (_uid, expires) in _handoff_tickets.items() if expires <= deadline]:
        del _handoff_tickets[digest]


def _handoff_deny() -> JSONResponse:
    """过期 / 重复 / 未知票据统一响应，不区分原因。"""
    return _sensitive_json({"error": "票据无效"}, 401)


class HandoffExchangeIn(BaseModel):
    ticket: str


@app.post("/api/desktop/handoff")
def desktop_handoff(request: Request):
    """网页会话领取一次性接管票据（需登录 + CSRF）。"""
    principal = _write_authorized(request)
    if not principal or principal.transport != "web":
        return _csrf_deny() if _authed(request) else _deny()
    ticket = secrets.token_urlsafe(32)
    with _handoff_lock:
        _handoff_prune_locked()
        _handoff_tickets[_handoff_digest(ticket)] = (principal.user_id, _handoff_now() + _HANDOFF_TTL_SECONDS)
    return _sensitive_json({"ticket": ticket, "expires_in": _HANDOFF_TTL_SECONDS})


@app.post("/api/desktop/handoff/exchange")
def desktop_handoff_exchange(body: HandoffExchangeIn):
    """桌面端凭票换令牌：只接受票据，不接受密码；响应与 /api/desktop/login 同构。"""
    if not body.ticket or len(body.ticket) > 512:
        return _handoff_deny()
    digest = _handoff_digest(body.ticket)
    with _handoff_lock:
        _handoff_prune_locked()
        entry = _handoff_tickets.get(digest)
        _handoff_tickets.pop(digest, None)  # 换票即删：票据一次性
    if entry is None or entry[1] <= _handoff_now():
        return _handoff_deny()
    issued = _accounts.issue_desktop_and_openai(entry[0])
    if not issued:
        return _handoff_deny()
    (_desktop_principal, token), (_openai_principal, openai_token) = issued
    return _sensitive_json(
        {
            "access_token": token,
            "token_type": "x-jws-token",
            "openai_token": openai_token,
            "openai_token_type": "bearer",
        }
    )
