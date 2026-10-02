"""智能平台：市场开号（开关 / 邀请码 / 限流 / 名额 / Owner 代开）、平台增改与租户隔离、v4→v5 升级、PWA 入口。"""
import struct

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import platforms
from jarvis.accounts import AccountStore, password_policy_error
from jarvis.tenancy import TenantStore

PLATFORM = {"name": "小林奶茶", "tagline": "订单排班一手抓", "icon": "🧋", "accent": "#ff9f0a",
            "profession": "shop_owner", "plugins": ["schedule", "todo", "weather"]}


@pytest.fixture(autouse=True)
def fresh_limiters():
    platforms.recommend_limiter.reset()
    platforms.signup_limiter.reset()
    yield
    platforms.signup_limiter.reset()


@pytest.fixture
def accounts():
    store = AccountStore()
    store._ensure_bootstrap()
    return store


def _client(username=None, password=None):
    client = TestClient(server_mod.app)
    if username:
        assert client.post("/api/login", json={"username": username, "password": password}).status_code == 200
        client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    return client


def _member(accounts, name="member1", password="Member-pass-123"):
    accounts.create_user(name, password, "Member")
    return _client(name, password)


def _audit(action):
    with AccountStore()._connect() as c:
        return [dict(r) for r in c.execute("SELECT user_id, detail FROM audit WHERE action=?", (action,))]


# ---------- 市场开号 ----------

def test_signup_is_off_by_default(accounts):
    response = TestClient(server_mod.app).post("/api/market/signup", json={"platform": PLATFORM})
    assert response.status_code == 403 and "暂未开放" in response.json()["error"]
    assert TestClient(server_mod.app).get("/api/market/catalog").json()["signup"] == "off"


def test_open_signup_returns_credentials_without_a_session_and_they_log_in(accounts, monkeypatch):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP", "open")
    guest = TestClient(server_mod.app)
    response = guest.post("/api/market/signup", json={"platform": PLATFORM})
    assert response.status_code == 201 and response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers                 # 只给账号口令，不替用户登录
    body = response.json()
    assert set(body) == {"username", "password", "platform"}
    username, password, platform = body["username"], body["password"], body["platform"]
    assert username.startswith("jv") and len(username) == 8 and username[2:].isalnum() and username.islower()
    assert len(password) == 12 and password_policy_error(password, username) is None
    assert not set(password) & set("0O1lI")
    assert platform["accent"] == "#FF9F0A" and platform["plugins"] == PLATFORM["plugins"]
    assert platform["url"] == f"http://testserver/p/{platform['slug']}"
    assert platform["home"]["greeting"] and len(platform["home"]["chips"]) == 3
    # 生成的账号口令能登录，登录后看到的就是自己的平台
    member = _client(username, password)
    assert member.get("/api/session").json()["role"] == "Member"
    assert member.get("/api/platform").json()["platform"]["slug"] == platform["slug"]
    audit = _audit("market_signup")
    assert len(audit) == 1 and audit[0]["detail"] == f"guest slug={platform['slug']}"


def test_signup_validates_platform_fields(accounts, monkeypatch):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP", "open")
    guest = TestClient(server_mod.app)
    cases = [
        ({"name": ""}, "平台名称不能为空"),
        ({"name": "名" * 21}, "最多 20 个字"),
        ({"tagline": "介" * 41}, "最多 40 个字"),
        ({"accent": "#123456"}, "六个预设"),
        ({"plugins": ["schedule", "crm"]}, "不在市场清单"),
        ({"profession": "astronaut"}, "没有这个职业"),
        ({"icon": "abc"}, "表情"),
        ({"icon": "<script>"}, "表情"),
    ]
    for patch, message in cases:
        response = guest.post("/api/market/signup", json={"platform": {**PLATFORM, **patch}})
        assert response.status_code == 422 and message in response.json()["error"], patch
    assert len(AccountStore().list_users()) == 1                # 校验失败不建账号


def test_invite_mode_checks_code(accounts, monkeypatch):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP", "invite")
    guest = TestClient(server_mod.app)
    # 没配邀请码：按关闭处理
    assert guest.post("/api/market/signup", json={"platform": PLATFORM, "invite_code": ""}).status_code == 403
    assert guest.get("/api/market/catalog").json()["signup"] == "off"
    monkeypatch.setenv("JARVIS_MARKET_INVITE_CODE", "JWS-2026")
    assert guest.get("/api/market/catalog").json()["signup"] == "invite"
    wrong = guest.post("/api/market/signup", json={"platform": PLATFORM, "invite_code": "jws-2026"})
    assert wrong.status_code == 403 and wrong.json()["error"] == "邀请码不对"
    assert guest.post("/api/market/signup", json={"platform": PLATFORM, "invite_code": " JWS-2026 "}).status_code == 201


def test_guest_signup_is_rate_limited_per_ip(accounts, monkeypatch):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP", "open")
    guest = TestClient(server_mod.app)
    for _ in range(platforms.DEFAULT_SIGNUP_PER_IP):
        assert guest.post("/api/market/signup", json={"platform": PLATFORM}).status_code == 201
    limited = guest.post("/api/market/signup", json={"platform": PLATFORM})
    assert limited.status_code == 429 and limited.headers["Retry-After"]


def test_guest_signup_total_is_capped(accounts, monkeypatch):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP", "open")
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP_MAX", "1")
    guest = TestClient(server_mod.app)
    assert guest.post("/api/market/signup", json={"platform": PLATFORM}).status_code == 201
    full = guest.post("/api/market/signup", json={"platform": PLATFORM})
    assert full.status_code == 403 and "名额" in full.json()["error"]


def test_owner_opens_accounts_regardless_of_switch_and_keeps_own_session(accounts, monkeypatch):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP_MAX", "0")       # 游客名额为零也不影响 Owner 代开
    owner = _client("admin", "admin")
    catalog = owner.get("/api/market/catalog").json()
    assert catalog["signup"] == "off" and catalog["signup_allowed"] is True
    created = []
    for _ in range(platforms.DEFAULT_SIGNUP_PER_IP + 1):       # 也不受 IP 限流
        response = owner.post("/api/market/signup", json={"platform": PLATFORM})
        assert response.status_code == 201 and "set-cookie" not in response.headers
        created.append(response.json()["username"])
    assert owner.get("/api/session").json()["username"] == "admin"   # Owner 自己的会话不变
    assert len(set(created)) == len(created)
    owner_id = accounts.unique_active_owner().user_id
    audit = _audit("market_signup")
    assert len(audit) == len(created) and all(a["detail"].startswith("owner:admin ") for a in audit)
    row = platforms.PlatformStore().get([u["id"] for u in accounts.list_users() if u["username"] == created[0]][0])
    assert row["created_via"] == "owner" and row["created_by"] == owner_id
    # 没带 CSRF 的 Owner 请求不行
    del owner.headers["X-JWS-CSRF"]
    assert owner.post("/api/market/signup", json={"platform": PLATFORM}).status_code == 403


def test_logged_in_member_cannot_open_accounts(accounts, monkeypatch):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP", "open")
    member = _member(accounts)
    assert member.get("/api/market/catalog").json()["signup_allowed"] is False
    response = member.post("/api/market/signup", json={"platform": PLATFORM})
    assert response.status_code == 403 and "管理员" in response.json()["error"]


def test_failed_platform_creation_deactivates_the_new_account(accounts, monkeypatch):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP", "open")

    def broken(self, *args, **kwargs):
        raise platforms.PlatformError("平台地址生成失败，请再试一次", 500)

    monkeypatch.setattr(platforms.PlatformStore, "create", broken)
    assert TestClient(server_mod.app).post("/api/market/signup", json={"platform": PLATFORM}).status_code == 500
    created = [u for u in AccountStore().list_users() if u["username"].startswith("jv")]
    assert len(created) == 1 and created[0]["active"] == 0


def test_generated_passwords_always_pass_policy():
    for _ in range(200):
        password = platforms.generate_password("jvabc123")
        assert len(password) == 12 and password_policy_error(password, "jvabc123") is None
        assert sum(c.isdigit() for c in password) >= 2 and any(c.isupper() for c in password)


# ---------- 平台增改与隔离 ----------

def test_platform_crud_for_current_account(accounts):
    member = _member(accounts)
    assert member.get("/api/platform").json() == {"platform": None}
    assert member.put("/api/platform", json={"name": "新名字"}).status_code == 404
    created = member.post("/api/platform", json={**PLATFORM, "profession": None, "icon": None})
    assert created.status_code == 201
    platform = created.json()["platform"]
    assert platform["icon"] == "✨" and platform["profession"] is None
    assert platform["home"]["greeting"] == "你好，我是「小林奶茶」，有什么可以帮你？"
    assert member.post("/api/platform", json=PLATFORM).status_code == 409   # 一个账号一个平台
    updated = member.put("/api/platform", json={"name": "  小林 奶茶铺 ", "plugins": ["todo", "search"]}).json()["platform"]
    assert updated["name"] == "小林 奶茶铺" and updated["plugins"] == ["todo", "search"]
    assert updated["tagline"] == PLATFORM["tagline"] and updated["slug"] == platform["slug"]   # 没传的字段不动
    assert member.put("/api/platform", json={"accent": "red"}).status_code == 422
    # 写接口要 CSRF，读接口要登录
    del member.headers["X-JWS-CSRF"]
    assert member.put("/api/platform", json={"name": "x"}).status_code == 403
    assert TestClient(server_mod.app).get("/api/platform").status_code == 401
    assert TestClient(server_mod.app).post("/api/platform", json=PLATFORM).status_code == 401


def test_platforms_are_isolated_per_account(accounts):
    alice = _member(accounts, "alice", "Alice-pass-123")
    bob = _member(accounts, "bob", "Bob-pass-12345")
    a = alice.post("/api/platform", json=PLATFORM).json()["platform"]
    assert bob.get("/api/platform").json() == {"platform": None}
    b = bob.post("/api/platform", json={**PLATFORM, "name": "老王修车", "plugins": ["weather"]}).json()["platform"]
    assert a["slug"] != b["slug"] and a["id"] != b["id"]
    bob.put("/api/platform", json={"name": "老王修车行"})
    assert alice.get("/api/platform").json()["platform"]["name"] == "小林奶茶"


def test_slug_collision_retries(accounts, monkeypatch):
    first = accounts.create_user("u1", "Member-pass-123", "Member")["id"]
    second = accounts.create_user("u2", "Member-pass-123", "Member")["id"]
    slugs = iter(["aaaa1111", "aaaa1111", "bbbb2222"])
    monkeypatch.setattr(platforms, "_new_slug", lambda: next(slugs))
    fields = platforms.clean_platform(PLATFORM)
    store = platforms.PlatformStore()
    assert store.create(first, fields)["slug"] == "aaaa1111"
    assert store.create(second, fields)["slug"] == "bbbb2222"


def test_platform_for_user_and_revision(accounts):
    member = accounts.create_user("u1", "Member-pass-123", "Member")["id"]
    assert platforms.platform_for_user(member) is None
    before = platforms.revision(member)
    platforms.PlatformStore().create(member, platforms.clean_platform(PLATFORM))
    view = platforms.platform_for_user(member)
    assert {"name", "icon", "accent", "slug"} <= set(view) and view["name"] == "小林奶茶"
    assert "url" not in view and "owner_role" not in view
    platforms.PlatformStore().update(member, {"name": "新店"})
    assert platforms.revision(member) == before + 2
    assert platforms.platform_for_user("no-such-user") is None


def test_v4_database_upgrades_to_v5(accounts):
    store = TenantStore()
    with store._connect() as c:   # 造一个只到 v4 的旧库
        c.execute("DROP TABLE tenant_platforms")
        c.execute("DELETE FROM tenant_schema_migrations WHERE version=5")
        c.commit()
    TenantStore.reset_migration_cache()   # 模拟新进程首连旧库
    member = accounts.create_user("u1", "Member-pass-123", "Member")["id"]
    row = platforms.PlatformStore().create(member, platforms.clean_platform(PLATFORM))
    assert row["slug"]
    with store._connect() as c:
        assert c.execute("SELECT 1 FROM tenant_schema_migrations WHERE version=5").fetchone()


def test_deleting_account_removes_platform(accounts):
    member = accounts.create_user("u1", "Member-pass-123", "Member")["id"]
    row = platforms.PlatformStore().create(member, platforms.clean_platform(PLATFORM))
    with TenantStore()._connect() as c:
        c.execute("DELETE FROM users WHERE id=?", (member,))
    assert platforms.PlatformStore().by_slug(row["slug"]) is None


# ---------- 公开入口、地址与 PWA ----------

def _png_size(data: bytes) -> tuple[int, int]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
    return struct.unpack(">II", data[16:24])


def test_public_entry_manifest_icons_and_service_worker(accounts):
    member = _member(accounts)
    slug = member.post("/api/platform", json=PLATFORM).json()["platform"]["slug"]
    guest = TestClient(server_mod.app)
    assert guest.get(f"/api/p/{slug}").json() == {"slug": slug, "name": "小林奶茶", "tagline": "订单排班一手抓",
                                                   "icon": "🧋", "accent": "#FF9F0A"}
    assert guest.get("/api/p/zzzzzzzz").status_code == 404 and guest.get("/api/p/BAD").status_code == 404
    manifest = guest.get(f"/p/{slug}/manifest.webmanifest")
    assert manifest.headers["content-type"].startswith("application/manifest+json")
    data = manifest.json()
    assert data["start_url"] == f"/p/{slug}" and data["display"] == "standalone"
    assert data["theme_color"] == "#FF9F0A" and data["name"] == "小林奶茶"
    for icon in data["icons"]:
        size = int(icon["sizes"].split("x")[0])
        png = guest.get(icon["src"])
        assert png.status_code == 200 and png.headers["content-type"] == "image/png"
        assert _png_size(png.content) == (size, size)
    assert guest.get(f"/p/{slug}/icon-64.png").status_code == 404
    assert guest.get("/p/zzzzzzzz/manifest.webmanifest").status_code == 404
    worker = guest.get("/sw.js")
    assert worker.headers["content-type"].startswith("application/javascript")
    assert "/api/" in worker.text and "caches" not in worker.text
    assert guest.get(f"/p/{slug}").status_code == 200        # 地基的单页入口照旧


def test_icon_png_pixels_follow_accent():
    import zlib
    data = platforms.pwa.icon_png("#34C759", 192)
    assert _png_size(data) == (192, 192)
    length = struct.unpack(">I", data[33:37])[0]
    raw = zlib.decompress(data[41:41 + length])
    corner = raw[1:4]                                         # 左上角：主题色底（略提亮）
    assert corner[1] > corner[0] and corner[1] > corner[2]    # 绿色占主导


def test_platform_url_respects_proxy_headers_and_override(accounts, monkeypatch):
    member = _member(accounts)
    member.post("/api/platform", json=PLATFORM)
    url = member.get("/api/platform", headers={"X-Forwarded-Proto": "https", "X-Forwarded-Host": "jws.example.cn"})
    slug = url.json()["platform"]["slug"]
    assert url.json()["platform"]["url"] == f"https://jws.example.cn/p/{slug}"
    bad = member.get("/api/platform", headers={"X-Forwarded-Proto": "javascript", "X-Forwarded-Host": "a b/c"})
    assert bad.json()["platform"]["url"] == f"http://testserver/p/{slug}"
    monkeypatch.setenv("JARVIS_PUBLIC_URL", "https://jarvis.example.com/")
    assert member.get("/api/platform").json()["platform"]["url"] == f"https://jarvis.example.com/p/{slug}"
