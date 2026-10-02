"""智能平台工坊：平台存储、市场接口、PWA 入口与「平台对 Agent 生效」的接线（契约 4.2）。

一个账号一个平台（tenant_platforms，租户 schema v5）。平台对 Member 账号的智能体生效，两处：
- 工具：``agent_tool_names(user_id)`` 给出该账号 Agent 可绑定的工具名（平台插件对应的工具
  + now / calc）；没有平台或是 Owner 返回 None——完整的贾维斯，行为不变。
  平台一改就 ``revision(user_id)`` 加一，AgentRuntimeManager 据此重建该用户的 runtime，
  网页 / 飞书 / 微信 / 语音共用同一个 bundle，一处生效处处生效。
- 人设：``prompt_section()`` 由 prompts.compose_system_prompt 每轮读取，平台名、职业人设、
  装了哪些技能都写进系统提示词。

市场开号（``POST /api/market/signup``）的核心产出是一组专属账号口令：只返回、不种会话，
用户拿它登录后面对的就是按所选插件组成的智能体。游客受 JARVIS_MARKET_SIGNUP 开关、邀请码、
IP 限流与总数上限约束；已登录的 Owner（带 CSRF）不受这些限制，帮客户现场开号。
"""
from __future__ import annotations

from collections import OrderedDict, deque
import datetime as dt
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
import uuid

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict

from jarvis import plugins as catalog
from jarvis.plugins import recommend
from jarvis import platform_home
from jarvis import pwa
from jarvis.accounts import AccountError, password_policy_error
from jarvis.periodic import warn_throttled
from jarvis.tenancy import TenantMigrationError, TenantStore, current_owner_id

log = logging.getLogger(__name__)

NAME_MAX = 20
TAGLINE_MAX = 40
ICON_MAX_CODEPOINTS = 10
DEFAULT_ICON = "✨"
SLUG_LENGTH = 8
SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
_SLUG_RE = re.compile(r"^[a-z0-9]{8}$")
MAX_PLUGIN_IDS = 64

SIGNUP_MODES = ("off", "invite", "open")
DEFAULT_SIGNUP_MAX = 50
DEFAULT_SIGNUP_PER_IP = 3              # 每个 IP 每小时最多开几个（游客）
SIGNUP_WINDOW_SECONDS = 3600
RECOMMEND_PER_IP = 10                  # 每个 IP 每分钟最多推荐几次
RECOMMEND_WINDOW_SECONDS = 60
USERNAME_PREFIX = "jv"
USERNAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
# 口令去掉易混字符（0/O/o、1/l/I）：念给人听、抄到纸上都不容易错
PASSWORD_ALPHABETS = ("abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789")
PASSWORD_LENGTH = 12


class PlatformError(ValueError):
    """平台参数或状态不对：message 直接给用户看。"""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# ---------- 字段校验 ----------

def _clean_text(value, limit: int, label: str, *, required: bool) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise PlatformError(f"{label}格式不对")
    cleaned = " ".join(value.split())
    if required and not cleaned:
        raise PlatformError(f"{label}不能为空")
    if len(cleaned) > limit:
        raise PlatformError(f"{label}最多 {limit} 个字")
    return cleaned


def _clean_icon(value) -> str:
    if value is None or value == "":
        return DEFAULT_ICON
    if not isinstance(value, str):
        raise PlatformError("图标格式不对")
    icon = value.strip()
    if not icon or len(icon) > ICON_MAX_CODEPOINTS:
        raise PlatformError("图标请选一个表情")
    for ch in icon:
        category = unicodedata.category(ch)
        if ord(ch) < 0x80 or category in ("Cc", "Co", "Cn", "Cs", "Zs", "Zl", "Zp") or (
                category == "Cf" and ch != "\u200d"):
            raise PlatformError("图标请选一个表情")
    return icon


def _clean_accent(value) -> str:
    accent = value.strip().upper() if isinstance(value, str) else ""
    if accent not in catalog.ACCENT_VALUES:
        raise PlatformError("主题色请从六个预设里选一个")
    return accent


def _clean_profession(value) -> str:
    if value in (None, ""):
        return ""
    if not catalog.is_profession(value):
        raise PlatformError("没有这个职业")
    return value


def _clean_plugins(value) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_PLUGIN_IDS:
        raise PlatformError("插件列表格式不对")
    unknown = [item for item in value if not catalog.is_plugin(item)]
    if unknown:
        raise PlatformError("有插件不在市场清单里，请刷新后重选")
    return list(dict.fromkeys(value))


_CLEANERS = {
    "name": lambda v: _clean_text(v, NAME_MAX, "平台名称", required=True),
    "tagline": lambda v: _clean_text(v, TAGLINE_MAX, "一句话介绍", required=False),
    "icon": _clean_icon,
    "accent": _clean_accent,
    "profession": _clean_profession,
    "plugins": _clean_plugins,
}


def clean_platform(data: dict, *, partial: bool = False) -> dict:
    """PlatformIn → 入库字段。partial=True 时只校验出现的字段（PUT 部分更新）。"""
    if not isinstance(data, dict):
        raise PlatformError("平台信息格式不对")
    return {key: cleaner(data.get(key)) for key, cleaner in _CLEANERS.items() if key in data or not partial}


class PlatformIn(BaseModel):
    """字段类型放宽、逐项手动校验：要给出中文原因，而不是框架的「请求格式不正确」。"""

    model_config = ConfigDict(extra="ignore")
    name: object = None
    tagline: object = None
    icon: object = None
    accent: object = None
    profession: object = None
    plugins: object = None


# ---------- 存储 ----------

_REVISIONS: dict[str, int] = {}
_REVISIONS_LOCK = threading.Lock()


def revision(user_id: str) -> int:
    """该账号平台的进程内版本号：创建 / 修改后加一，runtime 据此判断要不要重建 Agent。"""
    with _REVISIONS_LOCK:
        return _REVISIONS.get(user_id, 0)


def _bump(user_id: str) -> None:
    with _REVISIONS_LOCK:
        _REVISIONS[user_id] = _REVISIONS.get(user_id, 0) + 1


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _new_slug() -> str:
    return "".join(secrets.choice(SLUG_ALPHABET) for _ in range(SLUG_LENGTH))


class PlatformStore:
    """tenant_platforms 读写。owner_id 显式传入：公开入口按 slug 查时没有租户上下文。"""

    _SELECT = ("SELECT p.owner_id, p.id, p.slug, p.name, p.tagline, p.icon, p.accent, p.profession, p.plugins, "
               "p.created_via, p.created_by, p.created_at, p.updated_at, u.role AS owner_role "
               "FROM tenant_platforms p JOIN users u ON u.id = p.owner_id")

    def __init__(self, tenant_store: TenantStore | None = None) -> None:
        self.tenant = tenant_store or TenantStore()

    @staticmethod
    def _row(row) -> dict | None:
        if not row:
            return None
        data = dict(row)
        try:
            plugins = json.loads(data["plugins"])
        except ValueError:
            plugins = []
        data["plugins"] = [p for p in plugins if catalog.is_plugin(p)] if isinstance(plugins, list) else []
        return data

    def get(self, owner_id: str) -> dict | None:
        with self.tenant._connect() as c:
            row = c.execute(self._SELECT + " WHERE p.owner_id=?", (owner_id,)).fetchone()
        return self._row(row)

    def by_slug(self, slug: str) -> dict | None:
        if not isinstance(slug, str) or not _SLUG_RE.match(slug):
            return None
        with self.tenant._connect() as c:
            row = c.execute(self._SELECT + " WHERE p.slug=? AND u.active=1", (slug,)).fetchone()
        return self._row(row)

    def count_via(self, via: str) -> int:
        with self.tenant._connect() as c:
            return int(c.execute("SELECT COUNT(*) FROM tenant_platforms WHERE created_via=?", (via,)).fetchone()[0])

    def create(self, owner_id: str, fields: dict, *, via: str = "account", created_by: str = "") -> dict:
        now = _now()
        for _attempt in range(8):
            slug = _new_slug()
            try:
                with self.tenant._connect() as c:
                    c.execute("BEGIN IMMEDIATE")
                    if c.execute("SELECT 1 FROM tenant_platforms WHERE owner_id=?", (owner_id,)).fetchone():
                        c.rollback()
                        raise PlatformError("这个账号已经有平台了", 409)
                    try:
                        c.execute(
                            "INSERT INTO tenant_platforms(owner_id,id,slug,name,tagline,icon,accent,profession,"
                            "plugins,created_via,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (owner_id, uuid.uuid4().hex, slug, fields["name"], fields["tagline"], fields["icon"],
                             fields["accent"], fields["profession"], json.dumps(fields["plugins"]), via,
                             created_by, now, now))
                        c.commit()
                    except Exception:
                        c.rollback()
                        raise
            except sqlite3.IntegrityError as exc:
                if "slug" in str(exc):
                    continue   # 8 位随机 slug 撞车的概率极低，换一个再试
                raise
            _bump(owner_id)
            return self.get(owner_id)
        raise PlatformError("平台地址生成失败，请再试一次", 500)

    def update(self, owner_id: str, fields: dict) -> dict | None:
        if not fields:
            return self.get(owner_id)
        values = {key: (json.dumps(value) if key == "plugins" else value) for key, value in fields.items()}
        assignments = ", ".join(f"{key}=?" for key in values)
        with self.tenant._connect() as c:
            changed = c.execute(f"UPDATE tenant_platforms SET {assignments}, updated_at=? WHERE owner_id=?",
                                (*values.values(), _now(), owner_id)).rowcount
        if not changed:
            return None
        _bump(owner_id)
        return self.get(owner_id)


# ---------- 对外视图 ----------

def home_for(row: dict) -> dict:
    """主页定制（问候 + 4 个快捷问题，见 jarvis/platform_home.py）：生成过就用生成的，否则现算规则版。
    附 source（model / rules）与 chip_plugins（每个问题对应的插件 id）。"""
    return platform_home.view(row)


def public_view(row: dict) -> dict:
    return {key: row[key] for key in ("slug", "name", "tagline", "icon", "accent")}


def platform_view(row: dict, base_url: str) -> dict:
    return {
        "id": row["id"], "slug": row["slug"], "name": row["name"], "tagline": row["tagline"],
        "icon": row["icon"], "accent": row["accent"], "profession": row["profession"] or None,
        "plugins": list(row["plugins"]), "url": f"{base_url}/p/{row['slug']}", "home": home_for(row),
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def platform_for_user(user_id: str) -> dict | None:
    """给结果页等后端模块显示品牌：{id, slug, name, tagline, icon, accent, profession, plugins, home}。

    没有平台、账号不存在或读库失败一律返回 None（调用方按「贾维斯」默认品牌显示）。"""
    try:
        row = PlatformStore().get(user_id)
    except Exception as exc:
        log.info("platform lookup failed: %s", type(exc).__name__)
        return None
    if row is None:
        return None
    view = platform_view(row, "")
    view.pop("url")
    view.pop("created_at")
    view.pop("updated_at")
    return view


_HOST_RE = re.compile(r"^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$")


def public_base_url(request: Request) -> str:
    """平台对外地址的前缀：JARVIS_PUBLIC_URL 优先；否则按反代转发头（nginx 后的 https 与域名）拼。"""
    override = os.getenv("JARVIS_PUBLIC_URL", "").strip().rstrip("/")
    if override.startswith(("http://", "https://")):
        return override
    proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if proto not in ("http", "https"):
        proto = request.url.scheme
    host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip() or request.headers.get("host", "")
    if not _HOST_RE.match(host):
        host = request.url.netloc
    return f"{proto}://{host}"


# ---------- 平台对 Agent 生效 ----------

def agent_platform(user_id: str) -> dict | None:
    """对该账号智能体生效的平台：Member 账号的平台；Owner 永远是完整的贾维斯，没有平台也一样。"""
    row = PlatformStore().get(user_id)
    return row if row is not None and row["owner_role"] != "Owner" else None


def agent_tool_names(user_id: str) -> frozenset[str] | None:
    """该账号 Agent 可绑定的工具名：平台插件对应的工具 + now / calc；不受平台约束时返回 None（行为不变）。"""
    row = agent_platform(user_id)
    if row is None:
        return None
    return frozenset(set(catalog.BASE_TOOLS) | catalog.tools_for(row["plugins"]))


def prompt_section(owner_id: str | None = None) -> str:
    """当前租户的平台身份段（系统提示词）；不受平台约束时返回空串。"""
    row = agent_platform(owner_id or current_owner_id())
    if row is None:
        return ""
    name = row["name"]
    intro = f"- 你是「{name}」{row['icon']}" + (f"：{row['tagline']}" if row["tagline"] else "")
    lines = [
        "\n## 智能体身份（本账号的专属智能体，以此为准）",
        intro + f"。你由贾维斯驱动，但对外自称「{name}」，不自称贾维斯；被问起来历时可以说「我由贾维斯驱动」。",
        "- 定位是干活的工作助手：任务导向、务实简洁，直接给结果和下一步；不用管家腔，不做陪聊式寒暄。",
    ]
    profession = catalog.get_profession(row["profession"] or "")
    if profession:
        lines.append(f"- 人设：{profession['persona']}")
    skills = [catalog.get_plugin(pid) for pid in row["plugins"]]
    names = [item["name"] for item in skills if item and item["kind"] in ("tool", "channel")]
    if names:
        lines.append(f"- 本智能体装了这些技能：{'、'.join(names)}。")
    else:
        lines.append("- 本智能体还没装对话技能，只能看时间和算数。")
    lines.append("- 上文提到、但本智能体没装的工具都用不了：用户要用时直接说「我还没装这项技能，"
                 "可以在智能体市场里加上」，不要假装办成了。对用户只说「智能体」，不说「平台」。")
    return "\n".join(lines)


# ---------- 市场开号 ----------

def signup_mode() -> str:
    """游客自助开通开关：off（默认）/ invite / open。invite 却没配邀请码时按 off 处理（fail closed）。"""
    mode = os.getenv("JARVIS_MARKET_SIGNUP", "off").strip().lower()
    if mode == "invite" and not os.getenv("JARVIS_MARKET_INVITE_CODE", "").strip():
        warn_throttled("market-invite-missing", "JARVIS_MARKET_SIGNUP=invite 但没配 JARVIS_MARKET_INVITE_CODE，"
                       "游客自助开通按关闭处理")
        return "off"
    return mode if mode in SIGNUP_MODES else "off"


def _env_count(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    try:
        return max(0, int(raw)) if raw else default
    except ValueError:
        return default


def signup_per_ip() -> int:
    return max(1, _env_count("JARVIS_MARKET_SIGNUP_PER_IP", DEFAULT_SIGNUP_PER_IP))


def signup_max() -> int:
    return _env_count("JARVIS_MARKET_SIGNUP_MAX", DEFAULT_SIGNUP_MAX)


def invite_code_matches(supplied) -> bool:
    expected = os.getenv("JARVIS_MARKET_INVITE_CODE", "").strip()
    if not expected or not isinstance(supplied, str):
        return False
    return hmac.compare_digest(expected.encode("utf-8"), supplied.strip().encode("utf-8"))


def generate_username() -> str:
    return USERNAME_PREFIX + "".join(secrets.choice(USERNAME_ALPHABET) for _ in range(6))


def generate_password(username: str = "") -> str:
    """12 位强口令：大小写字母 + 数字各至少两个，去掉易混字符，且必须通过账户口令策略。"""
    lower, upper, digits = PASSWORD_ALPHABETS
    pool = lower + upper + digits
    while True:
        chars = [secrets.choice(lower) for _ in range(2)] + [secrets.choice(upper) for _ in range(2)] \
            + [secrets.choice(digits) for _ in range(2)] + [secrets.choice(pool) for _ in range(PASSWORD_LENGTH - 6)]
        secrets.SystemRandom().shuffle(chars)
        password = "".join(chars)
        if password_policy_error(password, username) is None:
            return password


class WindowLimiter:
    """按来源计数的滑动窗口限流（内存、有界）。hit 超限返回需等待的秒数。"""

    def __init__(self, limit: int, window_seconds: float, *, clock=time.monotonic, max_entries: int = 4096):
        self.limit = limit
        self.window = window_seconds
        self.clock = clock
        self.max_entries = max_entries
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def hit(self, key: str) -> int | None:
        now = self.clock()
        with self._lock:
            values = self._hits.setdefault(key or "unknown", deque())
            self._hits.move_to_end(key or "unknown")
            while values and now - values[0] >= self.window:
                values.popleft()
            if len(values) >= self.limit:
                return max(1, int(self.window - (now - values[0])))
            values.append(now)
            while len(self._hits) > self.max_entries:
                self._hits.popitem(last=False)
        return None

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


recommend_limiter = WindowLimiter(RECOMMEND_PER_IP, RECOMMEND_WINDOW_SECONDS)
signup_limiter = WindowLimiter(DEFAULT_SIGNUP_PER_IP, SIGNUP_WINDOW_SECONDS)
_SIGNUP_LOCK = threading.Lock()


class RecommendIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    profession: object = None
    description: object = None


class SignupIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    platform: dict = {}
    invite_code: object = None


def _json(content, status: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(content, status_code=status, headers={"Cache-Control": "no-store", **(headers or {})})


def _error(message: str, status: int, headers: dict | None = None) -> JSONResponse:
    return _json({"error": message}, status, headers)


def _too_many(retry_after: int) -> JSONResponse:
    return _error("操作太频繁了，请稍后再试", 429, {"Retry-After": str(retry_after)})


def open_account(accounts, fields: dict, *, opened_by=None) -> tuple[dict, str, dict]:
    """建 Member 账号 + 平台；返回 (用户, 口令, 平台行)。平台建失败就停用刚建的账号，不留半成品。"""
    for _attempt in range(6):
        username = generate_username()
        password = generate_password(username)
        try:
            user = accounts.create_user_checked(username, password, "Member")
            break
        except AccountError as exc:
            if exc.status != 409:
                raise
    else:
        raise PlatformError("账号生成失败，请再试一次", 500)
    via = "owner" if opened_by is not None else "guest"
    try:
        row = PlatformStore().create(user["id"], fields, via=via,
                                     created_by=opened_by.user_id if opened_by is not None else "")
    except Exception:
        accounts.update_user(user["id"], active=False)
        raise
    who = f"owner:{opened_by.username}" if opened_by is not None else "guest"
    accounts.record_audit("market_signup", user["id"], f"{who} slug={row['slug']}")
    return user, password, row


def register(app, *, accounts, request_principal, write_authorized, deny, csrf_deny, client_address,
             environment_llm=None) -> None:
    """挂上 /api/market/*、/api/platform、/api/p/{slug} 与 PWA 入口（manifest / 图标 / sw.js）。"""
    def complete(system: str, user: str) -> str:
        return recommend.model_complete(environment_llm(), system, user)

    def recommender() -> recommend.Recommender:
        # 服务器默认模型（环境变量里的那套）有 key 才走模型
        try:
            usable = environment_llm is not None and bool(environment_llm().api_key)
        except Exception:
            usable = False
        return recommend.Recommender(complete if usable else None)

    def home_model():
        # 主页生成同样只用服务器默认模型；没 key 返回 None（只走规则版，也不排后台任务）
        try:
            llm = environment_llm() if environment_llm is not None else None
        except Exception:
            return None
        if llm is None or not llm.api_key:
            return None
        return lambda system, user: platform_home.model_complete(llm, system, user)

    platform_home.configure(platform_home.HomeService(home_model))

    def migration_failed() -> JSONResponse:
        return _error("个人数据迁移失败", 503)

    def platform_error(exc: PlatformError) -> JSONResponse:
        return _error(exc.message, exc.status)

    # ---- 市场（公开） ----

    @app.get("/api/market/catalog")
    def market_catalog(request: Request):
        principal, _token = request_principal(request)
        mode = signup_mode()
        data = catalog.catalog(principal.user_id if principal else None)
        data["signup"] = mode
        # 当前访问者能不能开平台账号：游客看开关；Owner 总能代开；Member 不能
        data["signup_allowed"] = principal.is_owner if principal else mode != "off"
        return _json(data)

    @app.post("/api/market/recommend")
    def market_recommend(request: Request, body: RecommendIn):
        if retry := recommend_limiter.hit(client_address(request)):
            return _too_many(retry)
        profession = body.profession if body.profession not in ("", None) else None
        description = body.description if body.description is not None else ""
        if not isinstance(description, str) or (profession is not None and not isinstance(profession, str)):
            return _error("请求格式不正确", 422)
        principal, _token = request_principal(request)
        try:
            return _json(recommender().recommend(profession, description,
                                                 owner=bool(principal and principal.is_owner)))
        except recommend.RecommendError as exc:
            return _error(str(exc), 422)

    @app.post("/api/market/signup")
    def market_signup(request: Request, body: SignupIn):
        principal, _token = request_principal(request)
        opened_by = None
        if principal is not None:
            if not principal.is_owner:
                return _error("你已经有账号了，开新的平台账号请找管理员", 403)
            if not write_authorized(request):
                return csrf_deny()
            opened_by = principal
        mode = signup_mode()
        if opened_by is None and mode == "off":
            return _error("暂未开放自助开通，请联系管理员", 403)
        try:
            fields = clean_platform(body.platform)
        except PlatformError as exc:
            return platform_error(exc)
        if opened_by is None:
            signup_limiter.limit = signup_per_ip()
            if retry := signup_limiter.hit(client_address(request)):
                return _too_many(retry)
            if mode == "invite" and not invite_code_matches(body.invite_code):
                return _error("邀请码不对", 403)
        try:
            accounts.list_users()   # 全新部署时游客可能比任何人登录都早：先让账户库建好表
            with _SIGNUP_LOCK:   # 「数名额 → 开号」串行，并发注册不会冲过上限
                if opened_by is None and PlatformStore().count_via("guest") >= signup_max():
                    return _error("这一批名额已经用完了，请联系管理员", 403)
                user, password, row = open_account(accounts, fields, opened_by=opened_by)
        except PlatformError as exc:
            return platform_error(exc)
        except TenantMigrationError:
            return migration_failed()
        platform_home.schedule(row)   # 主页问候与快捷问题在后台生成，不拖慢开号
        return _json({"username": user["username"], "password": password,
                      "platform": platform_view(row, public_base_url(request))}, 201)

    # ---- 当前账号的平台 ----

    @app.get("/api/platform")
    def platform_get(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            row = PlatformStore().get(principal.user_id)
        except TenantMigrationError:
            return migration_failed()
        if row:
            platform_home.schedule(row)   # 旧智能体没生成过主页：这次先回规则版，后台补生成
        return _json({"platform": platform_view(row, public_base_url(request)) if row else None})

    def _writer(request: Request):
        principal = write_authorized(request)
        if principal:
            return principal, None
        return None, (csrf_deny() if request_principal(request)[0] else deny())

    @app.post("/api/platform")
    def platform_create(request: Request, body: PlatformIn):
        principal, err = _writer(request)
        if err:
            return err
        try:
            row = PlatformStore().create(principal.user_id, clean_platform(body.model_dump()))
        except PlatformError as exc:
            return platform_error(exc)
        except TenantMigrationError:
            return migration_failed()
        platform_home.schedule(row)
        return _json({"platform": platform_view(row, public_base_url(request))}, 201)

    @app.put("/api/platform")
    def platform_update(request: Request, body: PlatformIn):
        principal, err = _writer(request)
        if err:
            return err
        try:
            fields = clean_platform(body.model_dump(exclude_unset=True), partial=True)
            row = PlatformStore().update(principal.user_id, fields)
        except PlatformError as exc:
            return platform_error(exc)
        except TenantMigrationError:
            return migration_failed()
        if row is None:
            return _error("还没有智能体，先去智能体市场生成一个", 404)
        platform_home.schedule(row)   # 名称 / 介绍 / 职业 / 插件改了才会真的重生成（按内容签名判断）
        return _json({"platform": platform_view(row, public_base_url(request))})

    # ---- 公开入口与 PWA ----

    def _by_slug(slug: str) -> dict | None:
        try:
            return PlatformStore().by_slug(slug)
        except TenantMigrationError:
            return None

    @app.get("/api/p/{slug}")
    def platform_public(slug: str):
        row = _by_slug(slug)
        if row is None:
            return _error("没有找到这个平台", 404)
        return JSONResponse(public_view(row), headers={"Cache-Control": "no-cache"})

    @app.get("/p/{slug}/manifest.webmanifest")
    def platform_manifest(slug: str):
        row = _by_slug(slug)
        if row is None:
            return _error("没有找到这个平台", 404)
        data = pwa.manifest(row)
        for icon in data["icons"]:
            icon["src"] += f"?v={row['accent'].lstrip('#').lower()}"   # 换了主题色就换图标地址，不吃旧缓存
        return JSONResponse(data, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})

    @app.get("/p/{slug}/icon-{size}.png")
    def platform_icon(slug: str, size: int):
        if size not in pwa.ICON_SIZES:
            return _error("没有这个尺寸的图标", 404)
        row = _by_slug(slug)
        if row is None:
            return _error("没有找到这个平台", 404)
        return Response(pwa.icon_png(row["accent"], size), media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})

    @app.get("/sw.js")
    def service_worker():
        return Response(pwa.SERVICE_WORKER, media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})
