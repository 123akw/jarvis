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
from typing import Annotated

from fastapi import FastAPI, Path as PathParam, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import AIMessageChunk, ToolMessage
from pydantic import BaseModel, SecretStr
from starlette.exceptions import HTTPException as StarletteHTTPException

from jarvis import __version__, config, delivery, distill, heartbeat, history_index, mailer, meeting, reminders, wechat
from jarvis.accounts import (
    AccountError, AccountStore, Principal, SessionJanitor, csrf_token, session_secret_configured,
)
from jarvis.channels import feishu
from jarvis.graph import ThreadBusyError, build_agent, heal_dangling_tool_calls, thread_turn
from jarvis.provider_runtime import AgentRuntimeManager, probe_integration
from jarvis.provider_settings import (
    ProviderSettingsError, ResolvedLLM, SecretStore, credential_scope,
    normalize_base_url, normalize_searxng_url,
)
from jarvis.tenancy import MAX_ITEM_ID, TenantMigrationError, TenantStore, canonical_when, tenant_scope
from jarvis.tools import TOOLS
from jarvis.tools.location import get_location, refresh_location
from jarvis.voice.gateway import register_voice
from jarvis.voice.meeting_gateway import register_meeting
from jarvis.wechat_voice import DashScopeASR, VoiceError
from jarvis.tools.memo import all_memos
from jarvis.tools.schedule import all_schedule
from jarvis.tools.todo import all_todos


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """恢复持久微信桥并启动日程提醒扫描；退出时停线程但不删除 Token。"""
    _start_weak_password_scan()
    _check_timezone()
    history_stop = threading.Event()
    _safe_start("history-backfill", lambda: _start_history_backfill(history_stop))
    # 渠道各自隔离启动：任何一个起不来（凭据文件不可读、配置错）都只记日志，
    # 不能让整个网页服务启动失败（此前 resume_on_boot 抛 PermissionError 即全站起不来）。
    _safe_start("wechat", wechat.resume_on_boot)
    _safe_start("feishu", feishu.start)  # 未配置 FEISHU_APP_ID/SECRET 时为 disabled，不起线程
    scanner = None
    radio = None
    distiller = None
    janitor = SessionJanitor(_accounts)  # 定期删掉过期/早已吊销的会话行
    janitor.start()
    hb = heartbeat.maybe_create(
        owner_getter=_accounts.unique_active_owner,
        compose=_heartbeat_compose,
        push_wechat=wechat.push_text,
        outbox=_heartbeat_outbox,
        deliver=_notifier.send,   # 按账号的送达渠道与免打扰分发（jarvis/delivery.py）
    )
    if hb is not None:
        hb.start()
    if os.getenv("JARVIS_REMINDERS_ENABLED", "1") != "0":
        scanner = reminders.ReminderScanner(
            owner_getter=_accounts.unique_active_owner,
            push_wechat=wechat.push_text,
            push_feishu=feishu.push_text,
            feishu_users=feishu.bound_users,
            notifier=_notifier,
        )
        scanner.start()
        radio = reminders.MorningRadio(
            owner_getter=_accounts.unique_active_owner,
            compose=_radio_compose,
            push_voice=wechat.push_voice_then_text,
            push_available=wechat.push_available,
            push_feishu=feishu.push_text,
            feishu_ready=feishu.push_ready,
        )
        radio.start()
        distiller = distill.NightlyDistiller(
            owner_getter=_accounts.unique_active_owner,
            collect=_distill_collect,
            compose=_distill_compose,
            remember=_distill_remember,
        )
        distiller.start()
    try:
        yield
    finally:
        history_stop.set()
        janitor.stop()
        if hb is not None:
            hb.stop()
        if scanner is not None:
            scanner.stop()
        if radio is not None:
            radio.stop()
        if distiller is not None:
            distiller.stop()
        wechat.shutdown()
        feishu.shutdown()
        if _runtime_manager is not None:
            _runtime_manager.close()


log = logging.getLogger(__name__)

# Agent 长任务专用线程池：与 AnyIO 默认线程池（承载 /api/dashboard 等轻量
# sync 路由）隔离，聊天再慢也不抢轻请求的票；且整段流式在同一线程内运行，
# tenant_scope 等 contextvars 不会因跨线程恢复而断裂。
# 大小可用启动环境变量 JARVIS_AGENT_WORKERS 调整（默认 8，≤20 人够用）。
_agent_pool = ThreadPoolExecutor(
    max_workers=config.env_int("JARVIS_AGENT_WORKERS", 8, minimum=1),
    thread_name_prefix="jarvis-agent",
)


def _stream_from_agent_thread(sync_gen_factory):
    """把同步 SSE 生成器整段交给专用线程执行，事件经 asyncio 队列回传前端。"""

    async def event_stream():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        finished = object()
        abandoned = threading.Event()  # 客户端断开（点停止/关页/刷新）后置位

        def pump():
            gen = None
            try:
                gen = sync_gen_factory()
                for item in gen:
                    if abandoned.is_set():
                        break  # 没人听了：停掉 agent，别再烧模型/工具并占着线程池名额
                    loop.call_soon_threadsafe(queue.put_nowait, item)
            except Exception as exc:  # 生成器自身已兜底，这里只防线程静默死亡
                log.exception("agent stream pump crashed: %s", type(exc).__name__)
            finally:
                close = getattr(gen, "close", None)
                if callable(close):
                    close()  # GeneratorExit 沿 agent.stream 传下去，LangGraph 照常落盘已完成的步骤
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, finished)
                except RuntimeError:
                    pass  # 事件循环已关闭（连接断开/停机），无人再消费

        _agent_pool.submit(pump)
        try:
            while True:
                item = await queue.get()
                if item is finished:
                    return
                yield item
        finally:
            abandoned.set()

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


def _check_timezone(now_fn=None) -> bool:
    """日程提醒、晨报、夜间蒸馏、now 工具都按服务器本地时间计算；时区不是北京时间时整体偏移，
    且没有任何报错。启动时自检一次，不对就 WARNING。"""
    now = (now_fn or (lambda: datetime.datetime.now().astimezone()))()
    offset = now.utcoffset()
    if offset == datetime.timedelta(hours=8):
        return True
    hours = (offset or datetime.timedelta()).total_seconds() / 3600
    log.warning("服务器时区是 UTC%+g 而不是北京时间（UTC+8）：日程提醒、晨报、夜间蒸馏会整体偏移，"
                "请在服务环境里设置 TZ=Asia/Shanghai 后重启", hours)
    return False


def _safe_start(name: str, starter) -> None:
    try:
        starter()
    except Exception as exc:
        log.error("%s channel failed to start: %s", name, type(exc).__name__, exc_info=exc)


def _start_history_backfill(stop: threading.Event) -> None:
    """翻旧账：启动后稍等片刻，在后台把各用户的存量对话补进检索索引（不挡启动）。"""
    if os.getenv("JARVIS_HISTORY_BACKFILL", "1") == "0":
        return
    for user in _accounts.list_users():
        if user.get("active"):
            history_index.backfill_async(user["id"], delay=5.0, stop=stop)


def _start_weak_password_scan() -> None:
    """启动时后台核查默认/弱口令并打 WARNING（Argon2 逐个校验要几秒，不挡启动）。"""
    if os.getenv("JARVIS_WEAK_PASSWORD_SCAN", "1") == "0":
        return

    def scan() -> None:
        try:
            _accounts.scan_weak_passwords()
        except Exception as exc:  # 核查失败只少一条告警，绝不影响服务
            log.warning("weak password scan failed: %s", type(exc).__name__)

    threading.Thread(target=scan, name="jarvis-password-audit", daemon=True).start()


# 路径里的条目编号：SQLite INTEGER 是 64 位，超界数字此前直接 OverflowError → 500
ItemId = Annotated[int, PathParam(ge=1, le=MAX_ITEM_ID)]

# 聊天入口护栏：会议追问会把纪要+6000 字转写注入一条消息，上限要留足余量
MAX_CHAT_CHARS = 50_000
MAX_THREAD_ID_CHARS = 128
TURN_WAIT_SECONDS = 90.0   # 同一会话上一轮还在答时，新消息最多排队等这么久
_BUSY_MESSAGE = "上一条消息还在处理中，请等它答完再发"
# 后台任务（_service_invoke）的别名线程：照常注册（蒸馏豁免依赖它），但不进会话侧栏、
# 不接受网页直接写入——它们的 checkpoint 每次用完即删，点开永远是空的。
SERVICE_THREAD_ALIASES = frozenset({"radio", "heartbeat", "distill", "meeting"})


@app.exception_handler(RequestValidationError)
async def invalid_request(_request: Request, _error: RequestValidationError):
    """Avoid FastAPI's default echo of invalid request fields, including passwords."""
    return JSONResponse({"error": "请求格式不正确"}, status_code=422, headers={"Cache-Control": "no-store"})


_HTTP_ERROR_TEXT = {404: "接口不存在", 405: "请求方法不对"}


@app.exception_handler(StarletteHTTPException)
async def http_error(_request: Request, error: StarletteHTTPException):
    """框架层 404/405 等也回中文 JSON（默认是英文 {"detail": "Not Found"}）。"""
    message = _HTTP_ERROR_TEXT.get(error.status_code) or (
        error.detail if isinstance(error.detail, str) and error.detail else "请求失败")
    return JSONResponse({"error": message}, status_code=error.status_code,
                        headers=getattr(error, "headers", None))


@app.exception_handler(Exception)
async def unhandled_error(request: Request, error: Exception):
    """兜底：未捕获异常回人话 JSON，不回裸文本 Internal Server Error，也不泄露细节。
    （Starlette 发完响应会继续上抛，uvicorn 照常打印完整堆栈，这里只补一行定位信息。）"""
    log.error("unhandled error on %s %s: %s", request.method, request.url.path, type(error).__name__)
    return JSONResponse({"error": "服务器开小差了，请稍后再试"}, status_code=500,
                        headers={"Cache-Control": "no-store"})


@app.exception_handler(AccountError)
async def account_error(_request: Request, error: AccountError):
    """账户写操作的人话原因（口令太弱、用户名已被占用、当前口令不对…）原样回给前端。"""
    return JSONResponse({"error": error.message}, status_code=error.status,
                        headers={"Cache-Control": "no-store"})


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
    return JSONResponse({"error": "页面已过期，请刷新后重试"}, status_code=403, headers={"Cache-Control": "no-store"})


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


@contextmanager
def _history_reader(owner_id: str):
    """翻旧账同步用：借该用户的 runtime 按 checkpoint 线程读出完整消息列表。"""
    with _bundle_for(owner_id) as bundle:
        def read(checkpoint_thread_id: str) -> list:
            state = bundle.agent.get_state({"configurable": {"thread_id": checkpoint_thread_id}})
            return (state.values or {}).get("messages", [])
        yield read


history_index.configure(_history_reader, SERVICE_THREAD_ALIASES)


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
    if isinstance(error, ThreadBusyError):
        return _BUSY_MESSAGE
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
        # 弱口令/默认口令提示位（供前端提醒改密）；只提示，不改密、不锁号
        "password_weak": _accounts.password_weak(principal.user_id),
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
        return _sensitive_json({"error": "页面已过期，请刷新后重试"}, 403)
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
    created = _accounts.create_user_checked(body.username, body.password, body.role)  # 失败抛 AccountError
    return _sensitive_json(created, 201)


@app.patch("/api/admin/users/{user_id}")
def update_user(user_id: str, request: Request, body: UserPatchIn):
    allowed = _owner_for_write(request)
    if isinstance(allowed, JSONResponse):
        return allowed
    updated = _accounts.update_user_checked(user_id, **body.model_dump(exclude_unset=True))
    return _sensitive_json(updated)


@app.post("/api/account/password")
def change_password(request: Request, body: PasswordChangeIn):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    # 拿到会话的人不能无限次猜当前口令：与设置页的二次验证共用限速
    source = _client_address(request)
    if retry := _settings_limiter.check(source, principal.username):
        return JSONResponse({"error": "尝试过多，请稍后再试"}, status_code=429,
                            headers={"Retry-After": str(retry), "Cache-Control": "no-store"})
    _accounts.change_password_checked(principal, body.current_password, body.new_password)
    _settings_limiter.success(source, principal.username)
    resp = _sensitive_json({"ok": True})
    resp.delete_cookie(_COOKIE, path="/")
    return resp


# ---------- 日程主动提醒：网页/桌面轮询领取 ----------

@app.get("/api/reminders/pending")
def reminders_pending(request: Request):
    """返回该账号到点未提醒的日程并按 transport 记账：同一通道只弹一次。"""
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    channel = "desktop" if principal.transport == "desktop" else "web"
    floor, ceiling = reminders.reminder_window(datetime.datetime.now())
    try:
        with tenant_scope(principal.user_id):
            store = _tenant_store()
            if not delivery.load_prefs(store).allows(channel):
                return {"items": []}   # 用户在设置里关掉了这个渠道：不弹也不记账
            due = store.due_reminders(floor=floor, ceiling=ceiling, channel=channel)
            for item in due:
                store.mark_reminded(item["id"], item["at"], channel)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    # 心跳主动唤醒共用本端点送达：领取即清，谁先轮询谁收到
    return {"items": due + _heartbeat_outbox.drain(principal.user_id)}


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
            return [t for t in _tenant_store().list_threads() if t["id"] not in SERVICE_THREAD_ALIASES]
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


HISTORY_SEARCH_MAX_LIMIT = 20
HISTORY_SYNC_BUDGET = 0.4   # 检索前补同步最近活跃线程的时间预算（秒）；剩下的交给后台回填


@app.get("/api/history/search")
def history_search(request: Request, q: str = "", limit: int = 8):
    """翻旧账：跨会话全文检索本人的历史消息，返回会话、时间、角色和带高亮区间的片段。"""
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    query = q.strip()
    if not query:
        return _sensitive_json({"items": []})
    if len(query) > history_index.MAX_QUERY_CHARS:
        return JSONResponse({"error": "关键词太长了"}, status_code=422)
    limit = max(1, min(limit, HISTORY_SEARCH_MAX_LIMIT))
    try:
        with tenant_scope(principal.user_id):
            _tenant_store()
            if history_index.refresh(principal.user_id, budget=HISTORY_SYNC_BUDGET):
                history_index.backfill_async(principal.user_id)
            items = history_index.HistoryIndex().search(query, limit=limit)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    for item in items:
        item.pop("content", None)   # 片段够用；整条原文不出接口
    return _sensitive_json({"items": items})


def _index_turn(owner_id: str, alias: str, thread, agent) -> None:
    """一轮答完立即把本线程同步进翻旧账索引；任何失败都只留给后续补同步。"""
    try:
        state = agent.get_state({"configurable": {"thread_id": thread.checkpoint_thread_id}})
        messages = (state.values or {}).get("messages", [])
    except Exception:
        return
    history_index.sync_thread(owner_id, alias, messages, thread_updated_at=thread.updated)


class ThreadRenameIn(BaseModel):
    title: str


@app.patch("/api/thread")
def rename_thread(request: Request, thread_id: str, body: ThreadRenameIn):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    if not " ".join(body.title.split()):
        return JSONResponse({"error": "标题不能为空"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            thread = _tenant_store().rename_thread(thread_id, body.title)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not thread:
        return JSONResponse({"error": "未找到对话"}, status_code=404)
    return {"ok": True, "title": thread.title}


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


# ---------- 任务台写接口：待办 / 备忘 / 日程直接点操作，不必绕道对话 ----------

def _panel_write(request: Request):
    """共用鉴权：返回 (principal, 错误响应)；错误响应非 None 时直接返回。"""
    principal = _write_authorized(request)
    if not principal:
        return None, (_csrf_deny() if _authed(request) else _deny())
    return principal, None


def _clean_line(value: str, limit: int = 200) -> str:
    return " ".join(str(value).split())[:limit]


class PanelItemIn(BaseModel):
    content: str


class TodoPatchIn(BaseModel):
    done: bool


class ScheduleCreateIn(BaseModel):
    title: str
    when: str


@app.post("/api/todos")
def todo_create(request: Request, body: PanelItemIn):
    principal, err = _panel_write(request)
    if err:
        return err
    content = _clean_line(body.content)
    if not content:
        return JSONResponse({"error": "内容不能为空"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            item = _tenant_store().add_todo(content)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True, "id": item["id"]}


@app.patch("/api/todos/{item_id}")
def todo_patch(request: Request, item_id: ItemId, body: TodoPatchIn):
    principal, err = _panel_write(request)
    if err:
        return err
    try:
        with tenant_scope(principal.user_id):
            found = _tenant_store().set_todo_done(item_id, body.done)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not found:
        return JSONResponse({"error": "未找到待办"}, status_code=404)
    return {"ok": True}


@app.delete("/api/todos/{item_id}")
def todo_delete(request: Request, item_id: ItemId):
    principal, err = _panel_write(request)
    if err:
        return err
    try:
        with tenant_scope(principal.user_id):
            found = _tenant_store().delete_todo(item_id)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not found:
        return JSONResponse({"error": "未找到待办"}, status_code=404)
    return {"ok": True}


@app.post("/api/memos")
def memo_create(request: Request, body: PanelItemIn):
    principal, err = _panel_write(request)
    if err:
        return err
    content = _clean_line(body.content)
    if not content:
        return JSONResponse({"error": "内容不能为空"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            item = _tenant_store().add_memo(content)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True, "id": item["id"]}


@app.delete("/api/memos/{item_id}")
def memo_delete(request: Request, item_id: ItemId):
    principal, err = _panel_write(request)
    if err:
        return err
    try:
        with tenant_scope(principal.user_id):
            found = _tenant_store().delete_memo(item_id)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not found:
        return JSONResponse({"error": "未找到备忘"}, status_code=404)
    return {"ok": True}


@app.post("/api/schedule")
def schedule_create(request: Request, body: ScheduleCreateIn):
    principal, err = _panel_write(request)
    if err:
        return err
    title = _clean_line(body.title)
    if not title:
        return JSONResponse({"error": "内容不能为空"}, status_code=422)
    try:
        when = canonical_when(body.when)
    except ValueError:
        return JSONResponse({"error": "时间需要 YYYY-MM-DD HH:MM 格式"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            item = _tenant_store().add_schedule(title, when)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True, "id": item["id"]}


@app.delete("/api/schedule/{item_id}")
def schedule_delete(request: Request, item_id: ItemId):
    principal, err = _panel_write(request)
    if err:
        return err
    try:
        with tenant_scope(principal.user_id):
            found = _tenant_store().delete_schedule(item_id)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not found:
        return JSONResponse({"error": "未找到日程"}, status_code=404)
    return {"ok": True}


# ---------- 语音设置：每用户音色 / 语速（非密钥，不走加密存储） ----------

class VoiceSettingsIn(BaseModel):
    voice: str
    speed: float


@app.get("/api/voice/settings")
def voice_settings_get(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    from jarvis.voice import scenes as voice_scenes
    from jarvis.voice.gateway import VOICE_CATALOG
    try:
        with tenant_scope(principal.user_id):
            store = _tenant_store()
            voice = store.get_pref("tts_voice") or "male-qn-qingse"
            speed = store.get_pref("tts_speed") or "1.0"
            scene = store.get_pref("voice_scene") or "butler"
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if voice_scenes.scene_by_id(scene) is None:
        scene = "butler"
    return {"voice": voice, "speed": float(speed), "catalog": VOICE_CATALOG,
            "scene": scene, "scenes": voice_scenes.catalog()}


@app.put("/api/voice/settings")
def voice_settings_put(request: Request, body: VoiceSettingsIn):
    principal, err = _panel_write(request)
    if err:
        return err
    from jarvis.voice.gateway import VOICE_CATALOG
    if body.voice not in {item["id"] for item in VOICE_CATALOG}:
        return JSONResponse({"error": "音色不在可选目录里"}, status_code=422)
    if not (0.5 <= body.speed <= 2.0):
        return JSONResponse({"error": "语速需在 0.5–2.0 之间"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            store = _tenant_store()
            store.set_pref("tts_voice", body.voice)
            store.set_pref("tts_speed", f"{body.speed:.2f}")
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True}


# ---------- 文档上传解析：PDF / docx / TXT / MD → 纯文本注入对话 ----------

class UploadIn(BaseModel):
    name: str
    content_b64: str


@app.post("/api/upload")
def upload_document(request: Request, body: UploadIn):
    principal, err = _panel_write(request)
    if err:
        return err
    name = Path(body.name).name.strip() or "文档"
    from jarvis import documents, files
    # 先按编码长度拦超限文件：此前 30MB 也要先整段解码（多占一份内存）才报超限
    if len(body.content_b64) > (documents.MAX_UPLOAD_BYTES + 2) // 3 * 4 + 4:
        return JSONResponse({"error": "文件超过 10MB 上限"}, status_code=422)
    try:
        import base64 as b64_mod
        data = b64_mod.b64decode(body.content_b64, validate=True)
    except Exception:
        return JSONResponse({"error": "文件内容编码不合法"}, status_code=422)
    # 图片 / 短视频：qwen3-vl 转成详细中文描述注入对话（与文档解析同一模式）
    from jarvis import vision
    image_ext = vision.image_extension(name)
    video_ext = vision.video_extension(name)
    if image_ext or video_ext:
        try:
            if image_ext:
                text = vision.describe_image(data, image_ext)
            else:
                text = vision.describe_video(data, video_ext)
        except vision.VisionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=422)
        return {"ok": True, "kind": "image" if image_ext else "video", "name": name,
                "chars": len(text), "truncated": False, "text": text}
    # PDF / Word / Excel / CSV 另存一份进文件空间：办公插件要的是原文件，不是解析后的文字
    keep = name.lower().endswith(files.ATTACHABLE_EXTENSIONS)
    note = ""
    try:
        text = documents.extract_text(name, data)
    except documents.DocumentError as exc:
        if not keep:
            return JSONResponse({"error": str(exc)}, status_code=422)
        text, note = "", str(exc)   # 读不出文字（扫描件 / 加密）也先存下，工具可能还能处理
    attached, file_error = None, ""
    if keep:
        try:
            meta = files.save(principal.user_id, name, data, source="upload")
            attached = {**meta, "marker": files.attachment_marker(meta)}
        except files.FileSpaceError as exc:
            if not text:
                return JSONResponse({"error": str(exc)}, status_code=422)
            file_error = f"{exc}（这次只读取了文字，原文件没有保存）"
    truncated = len(text) > documents.MAX_DOC_CHARS
    if truncated:
        text = text[: documents.MAX_DOC_CHARS]
    kind = "table" if name.lower().endswith((".xlsx", ".xlsm", ".csv")) else "document"
    return {"ok": True, "kind": kind, "name": name, "chars": len(text),
            "truncated": truncated, "text": text, "note": note,
            "file": attached, "file_error": file_error}


# ---------- Heartbeat 主动唤醒：定期读关注清单，模型裁量后主动开口 ----------

_heartbeat_outbox = heartbeat.PendingOutbox()


def _wechat_user() -> str | None:
    owner = _accounts.unique_active_owner()
    return owner.user_id if owner is not None else None


# 巡检等非日程主动消息的统一出口：按账号渠道分发、免打扰期间先攒着（jarvis/delivery.py）
_notifier = delivery.Notifier(push_wechat=wechat.push_text, wechat_user=_wechat_user,
                              push_feishu=feishu.push_text, outbox=_heartbeat_outbox)


def _service_invoke(owner_id: str, alias: str, title: str, prompt: str) -> str:
    """服务线程（heartbeat/distill/radio/meeting）的一次性 Agent 调用。

    alias 线程照常注册（网页排除与蒸馏豁免都依赖它），但每次调用用全新的
    checkpoint 上下文并用完即删——此前这些定时任务在同一 checkpoint 上无限追加，
    heartbeat 每 30 分钟一轮，历史会持续累积并整段重放给模型（成本与延迟爬坡）。
    这些任务的提示词都是自包含的，不需要跨轮记忆。"""
    with tenant_scope(owner_id):
        store = _tenant_store()
        thread = store.upsert_thread(alias, title)
        ephemeral = f"{thread.checkpoint_thread_id}#{uuid.uuid4().hex[:12]}"
        config = {"configurable": {"thread_id": ephemeral}}
        with _bundle_for(owner_id) as bundle:
            try:
                result = bundle.agent.invoke(
                    {"messages": [{"role": "user", "content": prompt}]}, config=config)
            finally:
                try:
                    bundle.agent.checkpointer.delete_thread(ephemeral)
                except Exception:
                    pass  # 一次性上下文清不掉也无害（不会再被读到）
    return _chunk_text(result["messages"][-1].content)


def _heartbeat_compose(owner, content: str, now) -> str:
    """用 Owner 自己的 Agent 裁量关注清单（独立 heartbeat 线程，不混日常对话）。"""
    prompt = heartbeat.HEARTBEAT_PROMPT.format(
        now=now.strftime("%Y-%m-%d %H:%M"), content=content)
    return _service_invoke(owner.user_id, "heartbeat", "主动唤醒", prompt)


# ---------- 夜间记忆蒸馏：把最近一天的对话浓缩进长期画像 ----------

_DISTILL_MAX_CHARS = 6000


def _distill_collect(owner) -> str:
    """取最近 24 小时更新过的日常对话线程，拼成蒸馏摘录；没有就返回空串。"""
    cutoff = (datetime.datetime.now(datetime.timezone.utc)
              - datetime.timedelta(days=1)).isoformat()
    parts: list[str] = []
    with tenant_scope(owner.user_id):
        store = _tenant_store()
        recent = [t for t in store.list_threads()
                  if t["id"] not in SERVICE_THREAD_ALIASES and (t["updated"] or "") >= cutoff]
        with _bundle_for(owner.user_id) as bundle:
            for t in recent:
                thread = store.get_thread(t["id"])
                if not thread:
                    continue
                state = bundle.agent.get_state(
                    {"configurable": {"thread_id": thread.checkpoint_thread_id}})
                for m in (state.values or {}).get("messages", []):
                    if m.type == "human":
                        parts.append(f"主人：{_chunk_text(m.content)}")
                    elif m.type == "ai":
                        text = _chunk_text(m.content)
                        if text.strip():
                            parts.append(f"贾维斯：{text}")
                if sum(len(p) for p in parts) > _DISTILL_MAX_CHARS:
                    break
    return "\n".join(parts)[:_DISTILL_MAX_CHARS]


def _distill_compose(owner, transcript: str) -> str:
    """用 Owner 自己的 Agent 提炼画像（独立 distill 线程，不混日常对话）。"""
    prompt = distill.DISTILL_PROMPT.format(transcript=transcript)
    return _service_invoke(owner.user_id, "distill", "记忆蒸馏", prompt)


def _distill_remember(owner, fact: str) -> bool:
    """写入 tenant_profile（与 profile_remember 工具同一存储，内容级去重）。"""
    with tenant_scope(owner.user_id):
        return not _tenant_store().add_profile(fact)["existed"]


# ---------- 晨报电台：每天定时用 Agent 生成晨报，经微信语音条+文字推送 ----------

def _radio_compose(owner) -> str:
    """用 Owner 自己的 Agent 跑一轮固定晨报指令（独立 radio 线程，不混日常对话）。"""
    return _service_invoke(owner.user_id, "radio", "晨报电台", reminders.RADIO_PROMPT)


class RadioIn(BaseModel):
    time: str = ""


@app.get("/api/radio")
def radio_get(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            return {"time": _tenant_store().get_pref("radio_time") or ""}
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)


@app.put("/api/radio")
def radio_put(request: Request, body: RadioIn):
    principal, err = _panel_write(request)
    if err:
        return err
    value = body.time.strip()
    if value:
        try:
            datetime.datetime.strptime(value, "%H:%M")
        except ValueError:
            return JSONResponse({"error": "时间需要 HH:MM 格式"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            store = _tenant_store()
            store.set_pref("radio_time", value or None)
            store.set_pref("radio_last_sent", None)   # 改时间后当天仍可按新时间发
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True, "time": value}


# ---------- 人设工坊：称呼 / 语气（人格只有 J.A.R.V.I.S. 一种；MOSS 已下线） ----------

PERSONA_STYLES = {"jarvis"}


def _persona_style(stored: str | None) -> str:
    """旧数据里存着已下线人格（如 moss）的账号，读取时一律按 jarvis 处理。"""
    return stored if stored in PERSONA_STYLES else "jarvis"


class PersonaIn(BaseModel):
    style: str = "jarvis"
    address: str = ""
    flavor: str = ""


@app.get("/api/persona")
def persona_get(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            store = _tenant_store()
            return {
                "style": _persona_style(store.get_pref("persona_style")),
                "address": store.get_pref("persona_address") or "",
                "flavor": store.get_pref("persona_flavor") or "",
            }
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)


@app.put("/api/persona")
def persona_put(request: Request, body: PersonaIn):
    principal, err = _panel_write(request)
    if err:
        return err
    if body.style not in PERSONA_STYLES:
        msg = "MOSS 人格已下线，目前只有 J.A.R.V.I.S. 一种人格" if body.style == "moss" else "人格只支持 J.A.R.V.I.S.（jarvis）"
        return JSONResponse({"error": msg}, status_code=422)
    address = _clean_line(body.address, 12)
    flavor = _clean_line(body.flavor, 120)
    try:
        with tenant_scope(principal.user_id):
            store = _tenant_store()
            store.set_pref("persona_style", body.style)
            store.set_pref("persona_address", address or None)
            store.set_pref("persona_flavor", flavor or None)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True}


# ---------- 长期记忆画像：网页「记忆」面板可查可删 ----------

@app.get("/api/profile")
def profile_list_api(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            items = _tenant_store().list_profile()
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"items": items}


@app.post("/api/profile")
def profile_create(request: Request, body: PanelItemIn):
    principal, err = _panel_write(request)
    if err:
        return err
    content = _clean_line(body.content)
    if not content:
        return JSONResponse({"error": "内容不能为空"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            item = _tenant_store().add_profile(content)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True, "id": item["id"]}


@app.delete("/api/profile/{item_id}")
def profile_delete(request: Request, item_id: ItemId):
    principal, err = _panel_write(request)
    if err:
        return err
    try:
        with tenant_scope(principal.user_id):
            found = _tenant_store().delete_profile(item_id)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not found:
        return JSONResponse({"error": "未找到画像"}, status_code=404)
    return {"ok": True}


class ChatIn(BaseModel):
    message: str
    thread_id: str = "web"
    location: dict | None = None  # 浏览器定位 {lat, lon}，可选


def _update_location(request: Request, body: "ChatIn") -> None:
    """浏览器坐标优先；没有任何定位时用 IP 兜底。需联网的查询在后台做，不挡首 token。"""
    loc = body.location or {}
    if isinstance(loc.get("lat"), (int, float)) and isinstance(loc.get("lon"), (int, float)):
        refresh_location(loc["lat"], loc["lon"])
        return
    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "")
    refresh_location(ip=ip)


def _chunk_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _chat_input_error(message: str, thread_id: str) -> str:
    """聊天入口参数校验：返回人话错误（空串表示通过）。挡在模型和建线程之前。"""
    if not message.strip():
        return "消息不能为空"
    if len(message) > MAX_CHAT_CHARS:
        return f"消息太长了（上限 {MAX_CHAT_CHARS} 字），请精简或分几次发送"
    if not thread_id.strip() or len(thread_id) > MAX_THREAD_ID_CHARS or thread_id in SERVICE_THREAD_ALIASES:
        return "会话编号无效，请刷新页面后重试"
    return ""


@app.post("/api/chat")
def chat(request: Request, body: ChatIn):
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    if problem := _chat_input_error(body.message, body.thread_id):
        return JSONResponse({"error": problem}, status_code=422)
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
        call_started: dict[str, float] = {}
        try:
            with tenant_scope(principal.user_id), \
                    thread_turn(thread.checkpoint_thread_id, TURN_WAIT_SECONDS):
                with _bundle_for(principal.user_id) as bundle:
                    heal_dangling_tool_calls(bundle.agent, thread.checkpoint_thread_id)
                    stream = bundle.agent.stream(
                        {"messages": [{"role": "user", "content": body.message}]},
                        config={"configurable": {"thread_id": thread.checkpoint_thread_id}}, stream_mode="messages")
                    for chunk, _meta in stream:
                        if isinstance(chunk, ToolMessage):
                            cid = getattr(chunk, "tool_call_id", "") or ""
                            started = call_started.pop(cid, None)
                            yield _sse({
                                "type": "tool_result", "name": chunk.name, "id": cid,
                                "ok": getattr(chunk, "status", "success") != "error",
                                "ms": int((time.monotonic() - started) * 1000) if started is not None else None,
                                "detail": _chunk_text(chunk.content)[:400],
                                **memory_receipts.sse_fields(chunk),   # 记住/忘记：附结构化回执（可撤销）
                            })
                        elif isinstance(chunk, AIMessageChunk):
                            for tc in chunk.tool_call_chunks or []:
                                name, cid = tc.get("name"), tc.get("id")
                                if name and cid and cid not in seen_calls:
                                    seen_calls.add(cid)
                                    call_started[cid] = time.monotonic()
                                    yield _sse({"type": "tool_start", "name": name, "id": cid})
                            text = _chunk_text(chunk.content)
                            if text:
                                yield _sse({"type": "token", "text": text})
                    _index_turn(principal.user_id, body.thread_id, thread, bundle.agent)
            yield _sse({"type": "done"})
        except ThreadBusyError:
            yield _sse({"type": "error", "message": _BUSY_MESSAGE})
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
    if len(text) > MAX_CHAT_CHARS:
        return JSONResponse({"error": {"message": "user message too long"}}, status_code=400)
    # 多轮记忆在贾维斯侧（按线程），外部只需传最后一句
    alias = request.headers.get("x-thread-id", "").strip() or "openai"
    if len(alias) > MAX_THREAD_ID_CHARS:
        return JSONResponse({"error": {"message": "invalid x-thread-id"}}, status_code=400)
    try:
        with tenant_scope(principal.user_id):
            _tenant_store()
            thread = _tenant_store().upsert_thread(alias, text)
    except TenantMigrationError:
        return JSONResponse({"error": {"message": "tenant migration failed"}}, status_code=503)
    rid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    if not body.stream:
        try:
            with tenant_scope(principal.user_id), \
                    thread_turn(thread.checkpoint_thread_id, TURN_WAIT_SECONDS):
                with _bundle_for(principal.user_id) as bundle:
                    heal_dangling_tool_calls(bundle.agent, thread.checkpoint_thread_id)
                    result = bundle.agent.invoke({"messages": [{"role": "user", "content": text}]}, config={"configurable": {"thread_id": thread.checkpoint_thread_id}})
        except ThreadBusyError:
            return JSONResponse({"error": {"message": _BUSY_MESSAGE}}, status_code=409)
        except Exception as e:  # 此前直接 500 裸文本；外部客户端需要可解析的 OpenAI 风格错误
            log.exception("openai-compatible chat failed: %s", type(e).__name__)
            return JSONResponse({"error": {"message": _public_runtime_error(e)}}, status_code=502)
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
            with tenant_scope(principal.user_id), \
                    thread_turn(thread.checkpoint_thread_id, TURN_WAIT_SECONDS):
                with _bundle_for(principal.user_id) as bundle:
                    heal_dangling_tool_calls(bundle.agent, thread.checkpoint_thread_id)
                    stream = bundle.agent.stream({"messages": [{"role": "user", "content": text}]}, config={"configurable": {"thread_id": thread.checkpoint_thread_id}}, stream_mode="messages")
                    for ck, _meta in stream:
                        if isinstance(ck, AIMessageChunk):
                            t = _chunk_text(ck.content)
                            if t:
                                yield chunk({"content": t})
        except ThreadBusyError:
            yield chunk({"content": f"（{_BUSY_MESSAGE}）"})
        except Exception as e:
            log.exception("openai-compatible stream failed: %s", type(e).__name__)
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


# 前端顶层页面（web-src/src/routes.js）：市场、平台入口、流程拼接都是同一个单页应用
@app.get("/market")
@app.get("/flows")
def spa_page():
    return FileResponse(_WEB / "index.html")


@app.get("/p/{slug}")
def spa_platform(slug: str):
    return FileResponse(_WEB / "index.html")


# ---- 文件空间：办公插件读写的原文件，按账号隔离（逻辑在 jarvis/files.py） ----
from jarvis import files  # noqa: E402

files.register(
    app, request_principal=_request_principal, write_authorized=_write_authorized,
    deny=_deny, csrf_deny=_csrf_deny,
)


# ---- 智能平台工坊：插件市场、平台开通、/p/<slug> 的 PWA 入口（逻辑在 jarvis/platforms.py） ----
from jarvis import platforms  # noqa: E402

platforms.register(
    app, accounts=_accounts, request_principal=_request_principal, write_authorized=_write_authorized,
    deny=_deny, csrf_deny=_csrf_deny, client_address=_client_address,
    environment_llm=lambda: _provider_store._environment_llm(),
)

# ---- 插件管理（第十四轮）：导入 / 启停 / 卸载 / 插件源，仅 Owner（逻辑在 jarvis/plugins/） ----
from jarvis.plugins import routes as plugin_routes  # noqa: E402

plugin_routes.register(
    app, accounts=_accounts, request_principal=_request_principal, write_authorized=_write_authorized,
    deny=_deny, csrf_deny=_csrf_deny,
)


if (_WEB / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=_WEB / "assets"), name="assets")


wechat.init(_get_agent, _chunk_text, _accounts.unique_active_owner)
feishu.register(
    app, bundle_for=_bundle_for, chunk_text=_chunk_text, tenant_store=_tenant_store,
    accounts=_accounts, request_principal=_request_principal,
    write_authorized=_write_authorized, deny=_deny, csrf_deny=_csrf_deny,
    quick_reply=lambda user_id, text: _reminder_quick_reply(user_id, "feishu", text),
)


# ---- 主动送达（F5 可操作的提醒 + F6 送达与免打扰）：逻辑在 jarvis/delivery.py / reminders.py ----

def _reminder_quick_reply(user_id: str, channel: str, text: str) -> str | None:
    """微信 / 飞书里回「稍后」「好了」：作用于该渠道最近一条提醒；不是短语就返回 None 交给模型。"""
    if reminders.parse_quick_reply(text) is None:
        return None   # 绝大多数消息在这里就放行，不碰数据库
    with tenant_scope(user_id):
        return reminders.handle_quick_reply(_tenant_store(), channel, text, datetime.datetime.now())


def _wechat_quick_reply(text: str) -> str | None:
    owner = _accounts.unique_active_owner()
    return _reminder_quick_reply(owner.user_id, "wechat", text) if owner is not None else None


def _delivery_channel_status(principal) -> dict:
    return {
        "wechat": principal.is_owner and wechat.push_bound(),
        "feishu": feishu.status().get("configured", False) and feishu.get_bridge().bindings.count_for(principal.user_id) > 0,
    }


wechat.set_quick_reply(_wechat_quick_reply)
delivery.register(app, request_principal=_request_principal, panel_write=_panel_write,
                  tenant_store=lambda: _tenant_store(), deny=_deny,
                  channel_status=_delivery_channel_status)


def run() -> None:
    import uvicorn

    config.load_env()   # 先读 .env：此前 basicConfig 在它之前，写在 .env 里的 JARVIS_LOG_LEVEL 不生效
    # JARVIS_LOG_LEVEL=INFO 可看到心跳/提醒等后台线程的推送记录；默认维持 WARNING
    logging.basicConfig(level=config.log_level())
    _initialize_runtime()
    port = config.env_int("JARVIS_PORT", 7789, minimum=1, maximum=65535)
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


# ---- 记忆回执 / 今日简报卡：路由与逻辑在各自模块里，这里只注入鉴权与运行时依赖 ----
from jarvis import briefing, memory_receipts  # noqa: E402

memory_receipts.register(app, request_principal=_request_principal, panel_write=_panel_write,
                         tenant_store=lambda: _tenant_store(), deny=_deny)
briefing.register(app, request_principal=_request_principal, panel_write=_panel_write,
                  tenant_store=lambda: _tenant_store(), bundle_for=lambda uid: _bundle_for(uid),
                  chunk_text=_chunk_text, deny=_deny)


# ---- 积木流程（第十三轮平台工坊）：/api/flows*、公开结果页 /r/<token>，逻辑在 jarvis/flows/ ----
from jarvis import flows, vision  # noqa: E402

flows.install(app, request_principal=_request_principal, panel_write=_panel_write, deny=_deny,
              deps=flows.FlowDeps(
                  tenant_store=lambda: _tenant_store(),
                  compose=lambda uid, prompt: flows.model_compose(lambda u: _bundle_for(u), _chunk_text, uid, prompt),
                  describe_image=lambda data, ext: vision.describe_image(data, ext),
                  feishu_ready=feishu.push_ready,
                  push_feishu=feishu.push_text,
                  feishu_doc_target=feishu.doc_target,
                  wechat_owner=lambda uid: _wechat_user() == uid,
                  wechat_ready=wechat.push_available,
                  push_wechat=wechat.push_text,
              ))


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


# ---- 会议纪要 / 悬浮窗远程控制 / 语音唤醒 ----
# 会议链路：桌面端双路推流 → /api/meeting/stream（jarvis/voice/meeting_gateway.py）
# → 结束时 _meeting_finalize：Agent 总结（独立 meeting 线程）→ tenant_meetings 入库
# → SMTP 发送（jarvis/mailer.py，默认收件人 JARVIS_MEETING_MAIL_TO）。


def _meeting_compose(owner_id: str, date_str: str, transcript: str) -> str:
    """用 Owner 自己的 Agent 总结转写（独立 meeting 线程，不混日常对话）。"""
    prompt = meeting.MEETING_PROMPT.format(date=date_str, transcript=transcript)
    return _service_invoke(owner_id, "meeting", "会议纪要", prompt)


def _meeting_live_compose(owner_id: str, transcript_tail: str) -> str:
    """会中实时要点（对标飞书妙记）：对最近一段转写做增量小结，失败返空不打扰。"""
    prompt = meeting.LIVE_POINTS_PROMPT.format(transcript=transcript_tail)
    try:
        return _service_invoke(owner_id, "meeting", "会议纪要", prompt).strip()
    except Exception as exc:
        log.warning("meeting live compose failed: %s", type(exc).__name__)
        return ""


def _meeting_recipient(owner_id: str) -> str:
    with tenant_scope(owner_id):
        pref = _tenant_store().get_pref("meeting_mail_to")
    return (pref or "").strip() or mailer.default_meeting_recipient()


def _meeting_mail_body(minutes: str, transcript: str) -> str:
    body = minutes.strip() or "（纪要生成失败，请见下方原始转写）"
    return (body + "\n\n——由贾维斯（JWS-Agent）自动整理\n\n"
            "===== 原始转写 =====\n" + transcript[:20000])


def _meeting_finalize(owner_id: str, session) -> dict:
    """会议结束：说话人分离（尽力）→ 总结 → 入库 → 发邮件；失败保产物、回报人话。"""
    session.close_audio()
    speakers_note = ""
    audio_path = session.audio_path
    try:
        if audio_path:
            from jarvis.voice import diarize
            try:
                sentences = diarize.diarize_wav(audio_path)
                count = session.relabel_others(sentences)
                if count >= 2:
                    speakers_note = f"已自动区分出 {count} 位对方说话人（对方1/对方2…）"
            except diarize.DiarizeError as exc:
                log.info("meeting diarize skipped: %s", exc)
            except Exception as exc:
                log.warning("meeting diarize failed: %s", type(exc).__name__)
    finally:
        if audio_path:
            try:
                os.remove(audio_path)
            except OSError:
                pass
    transcript = session.transcript_text()
    if not transcript.strip():
        return {"ok": False, "empty": True, "message": "没有捕捉到任何发言，未生成纪要"}
    date_str = session.started_at.strftime("%Y-%m-%d %H:%M")
    message = ""
    try:
        minutes = _meeting_compose(owner_id, date_str, transcript).strip()
    except Exception as exc:
        log.warning("meeting compose failed: %s", type(exc).__name__)
        minutes = ""
    if not minutes:
        message = "纪要生成失败（模型暂不可用），已保存原始转写，可稍后在网页端查看"
    try:
        with tenant_scope(owner_id):
            record = _tenant_store().add_meeting(
                title=session.title, started_at=date_str,
                ended_at=(session.ended_at or session.started_at).strftime("%Y-%m-%d %H:%M"),
                transcript=transcript, minutes=minutes)
    except Exception as exc:
        log.warning("meeting store failed: %s", type(exc).__name__)
        return {"ok": False, "minutes": minutes, "message": message or "纪要保存失败", "mail": None}
    mail_to = _meeting_recipient(owner_id)
    mail = {"ok": False, "to": mail_to, "message": ""}
    try:
        mailer.send_mail(f"会议纪要 · {session.title} · {date_str}",
                         _meeting_mail_body(minutes, transcript), mail_to)
        mail["ok"] = True
        with tenant_scope(owner_id):
            _tenant_store().mark_meeting_mailed(record["id"], mail_to)
    except mailer.MailError as exc:
        mail["message"] = str(exc)
    except Exception as exc:
        log.warning("meeting mail failed: %s", type(exc).__name__)
        mail["message"] = "邮件发送失败"
    if speakers_note:
        message = f"{message}；{speakers_note}" if message else speakers_note
    return {"ok": True, "meeting_id": record["id"], "minutes": minutes,
            "message": message, "mail": mail}


register_meeting(app, cookie_name=_COOKIE, accounts=_accounts,
                 finalize=_meeting_finalize, live_compose=_meeting_live_compose)


@app.get("/api/meetings")
def meetings_list(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            items = _tenant_store().list_meetings()
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"items": items,
            "active": meeting.active_meetings.get(principal.user_id) is not None}


@app.get("/api/meetings/{item_id}")
def meeting_detail(request: Request, item_id: ItemId):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            item = _tenant_store().get_meeting(item_id)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not item:
        return JSONResponse({"error": "没有这场会议"}, status_code=404)
    return item


@app.post("/api/meetings/{item_id}/email")
def meeting_email(request: Request, item_id: ItemId):
    """把已保存的纪要（重新）发送到当前收件邮箱。"""
    principal, err = _panel_write(request)
    if err:
        return err
    try:
        with tenant_scope(principal.user_id):
            item = _tenant_store().get_meeting(item_id)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not item:
        return JSONResponse({"error": "没有这场会议"}, status_code=404)
    mail_to = _meeting_recipient(principal.user_id)
    try:
        mailer.send_mail(f"会议纪要 · {item['title']} · {item['started_at']}",
                         _meeting_mail_body(item["minutes"], item["transcript"]), mail_to)
    except mailer.MailError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)
    with tenant_scope(principal.user_id):
        _tenant_store().mark_meeting_mailed(item_id, mail_to)
    return {"ok": True, "to": mail_to}


class MeetingSettingsIn(BaseModel):
    mail_to: str = ""


@app.get("/api/meeting/settings")
def meeting_settings_get(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            pref = _tenant_store().get_pref("meeting_mail_to") or ""
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"mail_to": pref, "default": mailer.default_meeting_recipient(),
            "smtp_configured": mailer.smtp_configured()}


@app.put("/api/meeting/settings")
def meeting_settings_put(request: Request, body: MeetingSettingsIn):
    principal, err = _panel_write(request)
    if err:
        return err
    value = body.mail_to.strip()
    if value and not mailer.valid_address(value):
        return JSONResponse({"error": "邮箱格式不对"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            _tenant_store().set_pref("meeting_mail_to", value or None)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True, "mail_to": value or mailer.default_meeting_recipient()}


# 悬浮窗显隐偏好：网页写、桌面端轮询读（同机时另有 wake-server 快路径秒级生效）

class DesktopSettingsIn(BaseModel):
    ball_visible: bool


@app.get("/api/desktop/settings")
def desktop_settings_get(request: Request):
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            visible = _tenant_store().get_pref("desktop_ball_visible") != "0"
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ball_visible": visible}


@app.put("/api/desktop/settings")
def desktop_settings_put(request: Request, body: DesktopSettingsIn):
    principal, err = _panel_write(request)
    if err:
        return err
    try:
        with tenant_scope(principal.user_id):
            _tenant_store().set_pref("desktop_ball_visible", "1" if body.ball_visible else "0")
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True, "ball_visible": body.ball_visible}


@app.get("/api/desktop/commands")
def desktop_commands_get(request: Request):
    """桌面端 10 秒轮询：领取指令（领取即清）+ 顺带回带悬浮球显隐偏好。"""
    principal, _token = _request_principal(request)
    if not principal:
        return _deny()
    try:
        with tenant_scope(principal.user_id):
            visible = _tenant_store().get_pref("desktop_ball_visible") != "0"
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"commands": meeting.desktop_commands.drain(principal.user_id),
            "ball_visible": visible}


# 语音唤醒：桌面端本地 VAD 圈出短语音段送检，静音零请求；识别用现成的
# 文件级百炼 ASR（qwen3-asr-flash，与微信语音同一条链）。

DEFAULT_WAKE_WORDS = ("贾维斯", "佳维斯", "加维斯", "家维斯", "嘉维斯", "jarvis")
_WAKE_AUDIO_B64_MAX = 1_400_000   # ~1MB（约 30s@16k PCM16），唤醒片段远小于此
create_wake_asr = DashScopeASR    # 测试可整体替换为假识别器


def _normalize_wake(text: str) -> str:
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


def _wake_words() -> tuple[str, ...]:
    raw = os.getenv("JARVIS_WAKE_WORDS", "")
    # 唤醒词与转写做同一套归一化：否则配了「hey jarvis」这类带空格/标点的词永远匹配不上
    words = tuple(w for w in (_normalize_wake(item) for item in raw.split(",")) if w)
    return words or DEFAULT_WAKE_WORDS


def wake_matched(text: str) -> bool:
    normalized = _normalize_wake(text)
    return any(word in normalized for word in _wake_words())


class WakeCheckIn(BaseModel):
    audio_b64: str


@app.post("/api/voice/wake")
def voice_wake(request: Request, body: WakeCheckIn):
    """桌面端语音唤醒送检：一小段 wav → 一次性识别 → 是否命中唤醒词。"""
    principal = _write_authorized(request)
    if not principal:
        return _csrf_deny() if _authed(request) else _deny()
    if len(body.audio_b64) > _WAKE_AUDIO_B64_MAX:
        return JSONResponse({"error": "音频片段太长"}, status_code=422)
    try:
        import base64 as b64_mod
        wav = b64_mod.b64decode(body.audio_b64, validate=True)
    except Exception:
        return JSONResponse({"error": "音频编码不合法"}, status_code=422)
    if not wav:
        return JSONResponse({"error": "音频为空"}, status_code=422)
    try:
        text = create_wake_asr()(wav)
    except VoiceError as exc:
        # 未配置/识别失败不是致命错：桌面端跳过本段，首次给一条人话提示即可
        return {"ok": False, "matched": False, "text": "", "message": str(exc)}
    return {"ok": True, "matched": wake_matched(text), "text": text}


@app.post("/api/meetings/{item_id}/todos")
def meeting_import_todos(request: Request, item_id: ItemId):
    """把纪要「待办事项」里属于我的条目一键导入任务台（去重，别人的任务不导）。"""
    principal, err = _panel_write(request)
    if err:
        return err
    try:
        with tenant_scope(principal.user_id):
            item = _tenant_store().get_meeting(item_id)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    if not item:
        return JSONResponse({"error": "没有这场会议"}, status_code=404)
    todos = meeting.extract_todos(item["minutes"])
    mine = [t for t in todos if not t["owner"] or "我" in t["owner"]]
    imported = 0
    with tenant_scope(principal.user_id):
        store = _tenant_store()
        existing = {x["content"] for x in store.list_todos()}
        for t in mine:
            content = t["content"] + (f"（{t['due']}）" if t["due"] else "")
            if content in existing:
                continue
            store.add_todo(content)
            existing.add(content)
            imported += 1
    return {"ok": True, "found": len(todos), "mine": len(mine), "imported": imported}


class SpeakerRenameIn(BaseModel):
    speaker: str
    name: str


@app.patch("/api/meetings/{item_id}/speaker")
def meeting_rename_speaker(request: Request, item_id: ItemId, body: SpeakerRenameIn):
    """说话人改名（对标飞书妙记）：把「对方1」全局改成真名，转写与纪要一起改。"""
    principal, err = _panel_write(request)
    if err:
        return err
    import re as re_mod
    speaker = body.speaker.strip()
    name = " ".join(body.name.split())[:24]
    if not re_mod.fullmatch(r"对方\d*", speaker) or not name or "对方" in name:
        return JSONResponse({"error": "只能把「对方N」改成一个具体称呼"}, status_code=422)
    try:
        with tenant_scope(principal.user_id):
            store = _tenant_store()
            item = store.get_meeting(item_id)
            if not item:
                return JSONResponse({"error": "没有这场会议"}, status_code=404)
            # (?!\d) 防止「对方1」误伤「对方10」；纪要里「对方1（张三）」的括号注记一并替换
            pattern = re_mod.compile(re_mod.escape(speaker) + r"(?!\d)(（[^）]*）)?")
            transcript = pattern.sub(name, item["transcript"])
            minutes = pattern.sub(name, item["minutes"])
            store.update_meeting_texts(item_id, transcript=transcript, minutes=minutes)
    except TenantMigrationError:
        return _sensitive_json({"error": "个人数据迁移失败"}, 503)
    return {"ok": True, "speaker": speaker, "name": name}
