"""账户与会话的安全边界测试。"""
import hashlib
import base64
from concurrent.futures import ThreadPoolExecutor
import hmac
import sqlite3

import pytest
from jarvis.accounts import AccountStore
import jarvis.server as server_mod
from fastapi.testclient import TestClient


def _client() -> TestClient:
    return TestClient(server_mod.app)


def _bootstrap(monkeypatch) -> None:
    monkeypatch.setenv("JARVIS_ADMIN_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_ADMIN_PASSWORD", "owner-password")
    monkeypatch.setenv("JARVIS_ENV", "test")
    monkeypatch.setenv("JARVIS_ALLOW_INSECURE_COOKIE", "1")
    monkeypatch.setenv("JARVIS_SESSION_SECRET", "test-session-secret-is-at-least-256-bits-long")


def _login(client: TestClient, username="owner", password="owner-password") -> str:
    response = client.post("/api/login", json={"username": username, "password": password})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    session = client.get("/api/session")
    assert session.status_code == 200
    return session.json()["csrf_token"]


def _desktop_token(client: TestClient, username="owner", password="owner-password") -> str:
    response = client.post("/api/desktop/login", json={"username": username, "password": password})
    assert response.status_code == 200
    return response.json()["access_token"]


def test_unconfigured_first_start_fails_closed_and_login_errors_do_not_enumerate(monkeypatch):
    """Removing bootstrap credentials must not create a default account or distinguish usernames."""
    monkeypatch.delenv("JARVIS_ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("JARVIS_ADMIN_PASSWORD", raising=False)
    client = _client()

    missing = client.post("/api/login", json={"username": "nobody", "password": "bad"})
    guessed = client.post("/api/login", json={"username": "admin", "password": "admin"})

    assert (missing.status_code, missing.json()) == (401, {"error": "账号或口令不对"})
    assert (guessed.status_code, guessed.json()) == (401, {"error": "账号或口令不对"})


def test_invalid_login_payload_does_not_echo_password(monkeypatch):
    """Validation errors must not reflect a submitted password to clients."""
    _bootstrap(monkeypatch)

    response = _client().post(
        "/api/login", json={"username": "owner", "password": {"value": "password-must-not-leak"}}
    )

    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert "password-must-not-leak" not in response.text


def test_v1_to_v2_migration_rolls_back_copy_failure_and_retries_without_losing_sessions(tmp_path, monkeypatch):
    """A failed v2 copy leaves the v1 schema untouched, so a retry retains every session."""
    path = tmp_path / "accounts.sqlite3"
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (1, '2026-01-01T00:00:00+00:00');
        CREATE TABLE users (
          id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
          password_hash TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
          transport TEXT NOT NULL CHECK (transport IN ('web', 'desktop')),
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
        );
        INSERT INTO users VALUES ('user-1', 'owner', 'Owner', 'hash', 1, 't', 't');
        INSERT INTO sessions VALUES ('session-1', 'user-1', 'digest-1', 'desktop', 't', 'future', NULL);
        """
    )
    db.close()

    def explode_at_copy(_connection):
        raise RuntimeError("copy interrupted")

    monkeypatch.setattr(AccountStore, "_copy_v1_sessions", staticmethod(explode_at_copy), raising=False)
    with pytest.raises(RuntimeError, match="copy interrupted"):
        AccountStore(path)._connect()

    after_failure = sqlite3.connect(path)
    assert after_failure.execute("SELECT id, token_hash, transport FROM sessions").fetchall() == [
        ("session-1", "digest-1", "desktop")
    ]
    assert after_failure.execute("SELECT 1 FROM schema_migrations WHERE version = 2").fetchone() is None
    assert after_failure.execute("SELECT 1 FROM sqlite_master WHERE name = 'sessions_v1'").fetchone() is None
    after_failure.close()

    monkeypatch.undo()
    connection = AccountStore(path)._connect()
    connection.close()
    migrated = sqlite3.connect(path)
    assert migrated.execute("SELECT id, token_hash, transport FROM sessions").fetchall() == [
        ("session-1", "digest-1", "desktop")
    ]
    assert migrated.execute("SELECT 1 FROM schema_migrations WHERE version = 2").fetchone()
    assert migrated.execute("SELECT 1 FROM sqlite_master WHERE name = 'sessions_v1'").fetchone() is None


def test_desktop_dual_session_issuance_rolls_back_when_openai_insert_fails(monkeypatch, isolated_data_dir):
    """Desktop login must leave no active session if its paired OpenAI session cannot be inserted."""
    _bootstrap(monkeypatch)
    calls = [0]
    original_insert = AccountStore._insert_session

    def fail_second_insert(*args):
        calls[0] += 1
        if calls[0] == 2:
            raise sqlite3.IntegrityError("openai insert failed")
        original_insert(*args)

    monkeypatch.setattr(AccountStore, "_insert_session", staticmethod(fail_second_insert), raising=False)
    response = _client().post("/api/desktop/login", json={"username": "owner", "password": "owner-password"})

    assert response.status_code == 503
    db = sqlite3.connect(isolated_data_dir / "accounts.sqlite3")
    assert db.execute("SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL").fetchone()[0] == 0


def test_bootstrap_owner_uses_argon2id_and_stores_only_token_digests(monkeypatch, isolated_data_dir):
    """A bootstrap login must persist an Owner safely without retaining password or raw tokens."""
    _bootstrap(monkeypatch)
    client = _client()

    csrf_token = _login(client)
    db = sqlite3.connect(isolated_data_dir / "accounts.sqlite3")
    user_id, role, password_hash = db.execute(
        "SELECT id, role, password_hash FROM users WHERE username = 'owner'"
    ).fetchone()
    token_hash = db.execute("SELECT token_hash FROM sessions").fetchone()[0]
    schema = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}

    assert len(user_id) == 36
    assert role == "Owner"
    assert password_hash.startswith("$argon2id$")
    assert "owner-password" not in password_hash
    assert token_hash == hashlib.sha256(client.cookies[server_mod._COOKIE].encode()).hexdigest()
    assert "csrf_hash" not in schema
    assert csrf_token


def test_csrf_is_deterministically_bound_to_raw_256_bit_session_token(monkeypatch, isolated_data_dir):
    """CSRF proof uses the raw CSPRNG session bytes and session UUID, not stored state."""
    _bootstrap(monkeypatch)
    client = _client()
    csrf = _login(client)
    raw_token = base64.urlsafe_b64decode(client.cookies[server_mod._COOKIE] + "=")
    session_id = sqlite3.connect(isolated_data_dir / "accounts.sqlite3").execute(
        "SELECT id FROM sessions"
    ).fetchone()[0]
    expected = hmac.new(
        b"test-session-secret-is-at-least-256-bits-long",
        b"csrf-v1\0" + raw_token + b"\0" + session_id.encode(),
        hashlib.sha256,
    ).hexdigest()

    assert csrf == expected


def test_web_login_is_cookie_only_and_cookie_writes_require_csrf(monkeypatch):
    """A web session cannot become a bearer and cannot mutate state without its CSRF secret."""
    _bootstrap(monkeypatch)
    client = _client()
    csrf_token = _login(client)

    assert client.post("/api/logout").status_code == 403
    assert client.post("/api/logout", headers={"X-JWS-CSRF": csrf_token}).status_code == 200


def test_production_web_cookie_is_secure_httponly_and_strict(monkeypatch):
    """A production deployment must never weaken cookie transport protection by request host."""
    monkeypatch.setenv("JARVIS_ADMIN_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_ADMIN_PASSWORD", "owner-password")
    monkeypatch.setenv("JARVIS_ENV", "production")
    monkeypatch.setenv("JARVIS_SESSION_SECRET", "production-session-secret-is-at-least-256-bits")
    monkeypatch.delenv("JARVIS_ALLOW_INSECURE_COOKIE", raising=False)

    response = _client().post("/api/login", json={"username": "owner", "password": "owner-password"})

    cookie = response.headers["set-cookie"].lower()
    assert "secure" in cookie and "httponly" in cookie and "samesite=strict" in cookie


def test_web_login_fails_closed_without_session_secret(monkeypatch):
    """Missing session-secret configuration must not create an unusable web session."""
    monkeypatch.setenv("JARVIS_ADMIN_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_ADMIN_PASSWORD", "owner-password")
    monkeypatch.delenv("JARVIS_SESSION_SECRET", raising=False)

    response = _client().post("/api/login", json={"username": "owner", "password": "owner-password"})

    assert response.status_code == 503
    assert server_mod._COOKIE not in response.cookies


def test_session_is_no_store_and_reports_expiry(monkeypatch):
    """Session discovery must not be cached and tells clients when it ends."""
    _bootstrap(monkeypatch)
    client = _client()
    _login(client)

    response = client.get("/api/session")

    assert response.headers["cache-control"] == "no-store"
    assert response.json()["expires_at"].endswith("+00:00")


def test_web_cookie_token_cannot_be_replayed_as_desktop_bearer(monkeypatch):
    """Transport-bound sessions prevent a leaked cookie from becoming an API bearer."""
    _bootstrap(monkeypatch)
    client = _client()
    _login(client)
    cookie = client.cookies[server_mod._COOKIE]

    assert _client().get("/api/dashboard", headers={"X-JWS-Token": cookie}).status_code == 401


def test_desktop_login_and_session_responses_are_no_store(monkeypatch):
    """Credential-bearing responses must opt out of HTTP caches."""
    _bootstrap(monkeypatch)
    client = _client()

    desktop = client.post("/api/desktop/login", json={"username": "owner", "password": "owner-password"})
    web = client.post("/api/login", json={"username": "owner", "password": "owner-password"})

    assert desktop.headers["cache-control"] == "no-store"
    assert web.headers["cache-control"] == "no-store"


def test_desktop_bearer_is_separate_session_and_does_not_need_csrf(monkeypatch):
    """Desktop bearer sessions authenticate independently and are CSRF-exempt."""
    _bootstrap(monkeypatch)
    client = _client()

    token = _desktop_token(client)
    response = client.post("/api/logout", headers={"X-JWS-Token": token})

    assert response.status_code == 200
    assert client.get("/api/dashboard", headers={"X-JWS-Token": token}).status_code == 401


def test_last_active_owner_cannot_be_demoted_or_disabled(monkeypatch):
    """No owner update may leave the system without an active Owner."""
    _bootstrap(monkeypatch)
    client = _client()
    csrf = _login(client)
    headers = {"X-JWS-CSRF": csrf}
    owner_id = client.get("/api/admin/users").json()[0]["id"]

    demoted = client.patch(f"/api/admin/users/{owner_id}", json={"role": "Member"}, headers=headers)
    disabled = client.patch(f"/api/admin/users/{owner_id}", json={"active": False}, headers=headers)

    assert demoted.status_code == 409
    assert disabled.status_code == 409
    assert client.get("/api/admin/users").json()[0]["role"] == "Owner"


def test_desktop_and_openai_tokens_are_header_and_transport_bound(monkeypatch):
    """Desktop tokens work only via X-JWS-Token; a distinct OpenAI token works only as Bearer."""
    _bootstrap(monkeypatch)
    client = _client()
    issued = client.post("/api/desktop/login", json={"username": "owner", "password": "owner-password"}).json()

    assert issued["token_type"] == "x-jws-token"
    assert issued["openai_token_type"] == "bearer"
    assert client.get("/api/dashboard", headers={"Authorization": f"Bearer {issued['access_token']}"}).status_code == 401
    assert client.post(
        "/v1/chat/completions", headers={"Authorization": f"Bearer {issued['access_token']}"},
        json={"messages": [{"role": "assistant", "content": "not a user message"}]},
    ).status_code == 401
    assert client.get("/api/dashboard", headers={"X-JWS-Token": issued["openai_token"]}).status_code == 401
    assert client.post(
        "/v1/chat/completions", headers={"Authorization": f"Bearer {issued['openai_token']}"},
        json={"messages": [{"role": "assistant", "content": "not a user message"}]},
    ).status_code == 400


def test_login_attempts_are_rate_limited_by_direct_client_address(monkeypatch):
    """The limiter rejects excess attempts before password work and returns a stable retry hint."""
    _bootstrap(monkeypatch)
    clock = [0.0]
    monkeypatch.setattr(server_mod, "_login_limiter", server_mod.LoginAttemptLimiter(
        attempts=2, window_seconds=30, clock=lambda: clock[0]
    ))
    client = _client()

    first = client.post("/api/login", json={"username": "owner", "password": "wrong"})
    second = client.post("/api/login", json={"username": "owner", "password": "wrong"})
    limited = client.post("/api/login", json={"username": "owner", "password": "wrong"},
                          headers={"X-Forwarded-For": "different-client"})

    assert [first.status_code, second.status_code, limited.status_code] == [401, 401, 429]
    assert limited.headers["retry-after"] == "30"


def test_eighty_local_failed_logins_are_limited_without_sqlite_errors(monkeypatch):
    """A local burst is bounded before it can turn login auditing into SQLite 500s."""
    _bootstrap(monkeypatch)
    monkeypatch.setattr(server_mod, "_login_limiter", server_mod.LoginAttemptLimiter(attempts=3, window_seconds=60))

    def attempt() -> int:
        return _client().post("/api/login", json={"username": "owner", "password": "wrong"}).status_code

    with ThreadPoolExecutor(max_workers=16) as pool:
        statuses = list(pool.map(lambda _: attempt(), range(80)))

    assert set(statuses) <= {401, 429}
    assert statuses.count(429) >= 77


def test_sensitive_account_responses_are_not_cacheable(monkeypatch):
    """User records and account mutations must not be stored by clients or intermediaries."""
    _bootstrap(monkeypatch)
    client = _client()
    csrf = _login(client)
    headers = {"X-JWS-CSRF": csrf}

    listed = client.get("/api/admin/users")
    created = client.post("/api/admin/users", json={"username": "member", "password": "member-pass", "role": "Member"}, headers=headers)
    patched = client.patch(f"/api/admin/users/{created.json()['id']}", json={"username": "member2"}, headers=headers)
    password = client.post("/api/account/password", json={"current_password": "owner-password", "new_password": "new-owner-password"}, headers=headers)

    assert all(response.headers["cache-control"] == "no-store" for response in (listed, created, patched, password))


def test_owner_manages_members_and_password_change_revokes_every_session(monkeypatch):
    """A member cannot administer accounts; changing a password invalidates all old sessions."""
    _bootstrap(monkeypatch)
    owner = _client()
    csrf_token = _login(owner)
    headers = {"X-JWS-CSRF": csrf_token}
    created = owner.post(
        "/api/admin/users",
        json={"username": "member", "password": "member-password", "role": "Member"},
        headers=headers,
    )
    assert created.status_code == 201
    member = _client()
    member_token = _desktop_token(member, "member", "member-password")
    assert member.get("/api/admin/users", headers={"X-JWS-Token": member_token}).status_code == 403

    second = _client()
    old_token = _desktop_token(second)
    changed = owner.post(
        "/api/account/password",
        json={"current_password": "owner-password", "new_password": "new-owner-password"},
        headers=headers,
    )
    assert changed.status_code == 200
    assert second.get("/api/dashboard", headers={"X-JWS-Token": old_token}).status_code == 401
    assert _desktop_token(_client(), "owner", "new-owner-password")


def test_expired_session_is_rejected(monkeypatch, isolated_data_dir):
    """An expired server session cannot be reused even when its cookie is intact."""
    _bootstrap(monkeypatch)
    client = _client()
    _login(client)
    db = sqlite3.connect(isolated_data_dir / "accounts.sqlite3")
    db.execute("UPDATE sessions SET expires_at = '2000-01-01T00:00:00+00:00'")
    db.commit()

    assert client.get("/api/dashboard").status_code == 401
