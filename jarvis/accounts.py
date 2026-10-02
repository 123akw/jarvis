"""SQLite-backed account and session primitives for every JARVIS client."""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import logging
import os
import secrets
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

from pwdlib import PasswordHash

from jarvis import config
from jarvis.db import ClosingConnection, file_identity


log = logging.getLogger(__name__)

_PASSWORDS = PasswordHash.recommended()
_SESSION_DAYS = 30
_DUMMY_HASH = _PASSWORDS.hash("not-a-real-password")
_ROLES = frozenset(("Owner", "Member"))
_AUDIT_LIMIT = 10_000
_MIGRATION_LOCK = threading.Lock()
# 迁移成功过的库（路径+inode）：同进程内不再逐连接重跑版本检查。每个已登录请求都会
# principal_for_token → _connect，此前每次都在全进程锁里多跑 3 条迁移语句。只缓存成功。
_MIGRATED: set[tuple[str, int, int]] = set()
_KNOWN_PLACEHOLDERS = frozenset({
    "<initial-owner-username>",
    "<initial-owner-password>",
    "<at-least-32-byte-random-secret>",
    "changeme",
    "change-me",
    "replace-me",
})


@dataclass(frozen=True)
class Principal:
    """The authenticated server-side identity used by every transport."""

    user_id: str
    username: str
    role: str
    session_id: str
    transport: str

    @property
    def is_owner(self) -> bool:
        return self.role == "Owner"


def _utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _is_placeholder(value: str) -> bool:
    normalized = value.strip().casefold()
    return normalized in _KNOWN_PLACEHOLDERS or (
        normalized.startswith("<") and normalized.endswith(">")
    )


def _session_secret() -> bytes | None:
    """Read the explicitly configured CSRF secret; never create a fallback secret."""
    value = os.getenv("JARVIS_SESSION_SECRET", "").strip()
    if _is_placeholder(value):
        return None
    encoded = value.encode("utf-8")
    return encoded if len(encoded) >= 32 else None


def session_secret_configured() -> bool:
    """Report configuration readiness without exposing the session secret."""
    return _session_secret() is not None


def csrf_token(token: str, session_id: str) -> str | None:
    """Derive a CSRF proof without persisting it, bound to one web session."""
    secret = _session_secret()
    if secret is None:
        return None
    try:
        token_bytes = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    except ValueError:
        return None
    message = b"csrf-v1\0" + token_bytes + b"\0" + session_id.encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def _clean_username(value: str) -> str:
    return value.strip()


# ---------- 弱口令识别：只提示（日志 WARNING + /api/session 的 password_weak），不改密、不锁号 ----------

MIN_PASSWORD_LENGTH = 8
_COMMON_PASSWORDS = frozenset({
    "admin", "administrator", "root", "password", "passw0rd", "p@ssw0rd", "jarvis", "changeme",
    "123456", "1234567", "12345678", "123456789", "1234567890", "111111", "000000", "666666",
    "888888", "abc123", "abcd1234", "qwerty", "qwerty123", "qwertyuiop", "iloveyou",
    "admin123", "admin1234", "admin888", "password1", "password123", "welcome", "letmein",
    "1qaz2wsx", "a123456", "a12345678", "woaini", "woaini1314", "5201314",
})
# 启动核查时拿来与已存哈希比对的候选（Argon2 校验较慢，只试最常见的几条）
_SCAN_CANDIDATES = ("admin", "123456", "password", "12345678", "admin123", "jarvis", "changeme",
                    "111111", "000000", "qwerty", "123456789", "88888888")
_WEAK_FLAGS: dict[str, tuple[str, bool]] = {}   # user_id -> (password_hash, 是否弱口令)
_WEAK_FLAGS_LOCK = threading.Lock()


def password_is_weak(password: str, username: str = "") -> bool:
    """规则判定：过短、常见口令、与用户名相同、字符种类过少、短纯数字。"""
    value = password or ""
    folded = value.casefold()
    if len(value) < MIN_PASSWORD_LENGTH or folded in _COMMON_PASSWORDS:
        return True
    name = (username or "").strip().casefold()
    if name and (folded == name or folded.startswith(name) and folded[len(name):].isdigit()):
        return True
    if len(set(value)) <= 2:
        return True
    return value.isdigit() and len(value) < 12


def _weak_warning(username: str) -> None:
    log.warning(
        "账号「%s」仍在使用默认或弱口令，请尽快登录网页修改口令（系统不会自动改密或锁号）", username)


def _remember_weak(user_id: str, username: str, password_hash: str, weak: bool) -> None:
    """缓存某个口令哈希的强弱结论；同一哈希首次判为弱口令时打一条 WARNING。"""
    with _WEAK_FLAGS_LOCK:
        previous = _WEAK_FLAGS.get(user_id)
        _WEAK_FLAGS[user_id] = (password_hash, weak)
    if weak and previous != (password_hash, True):
        _weak_warning(username)


class AccountStore:
    """Small, per-operation SQLite store; raw passwords and tokens never reach disk."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        path = self.path or (config.data_dir() / "accounts.sqlite3")
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path, timeout=5, isolation_level=None, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        if file_identity(path) not in _MIGRATED:
            try:
                with _MIGRATION_LOCK:
                    self._migrate(connection)
            except Exception:
                connection.close()
                raise
            identity = file_identity(path)
            if identity is not None:
                _MIGRATED.add(identity)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return connection

    @staticmethod
    def _migrate(connection: sqlite3.Connection) -> None:
        AccountStore._migrate_versions(connection)
        # 幂等索引（不占版本号）：每次写审计都要按 created_at 排序裁剪到 1 万行，无索引即全表排序
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit'").fetchone():
            connection.execute("CREATE INDEX IF NOT EXISTS audit_created_at ON audit(created_at)")

    @staticmethod
    def _migrate_versions(connection: sqlite3.Connection) -> None:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        if not connection.execute("SELECT 1 FROM schema_migrations WHERE version = 1").fetchone():
            connection.executescript(
                """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                role TEXT NOT NULL CHECK (role IN ('Owner', 'Member')),
                password_hash TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                transport TEXT NOT NULL CHECK (transport IN ('web', 'desktop', 'openai')),
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                revoked_at TEXT
            );
            CREATE INDEX IF NOT EXISTS sessions_active_token
                ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;
            CREATE TABLE IF NOT EXISTS audit (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                action TEXT NOT NULL,
                created_at TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT ''
            );
                """
            )
            connection.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)", (_utcnow(),)
            )
        if connection.execute("SELECT 1 FROM schema_migrations WHERE version = 2").fetchone():
            return
        connection.execute("BEGIN IMMEDIATE")
        try:
            if connection.execute("SELECT 1 FROM schema_migrations WHERE version = 2").fetchone():
                connection.commit()
                return
            has_backup = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions_v1'"
            ).fetchone()
            if has_backup:
                # Recover old autocommit-era partial migration before retrying atomically.
                connection.execute("DROP INDEX IF EXISTS sessions_active_token")
                has_current = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"
                ).fetchone()
                if has_current:
                    connection.execute("DROP TABLE sessions")
                connection.execute("ALTER TABLE sessions_v1 RENAME TO sessions")
            sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"
            ).fetchone()[0]
            if "'openai'" not in sql:
                connection.execute("DROP INDEX IF EXISTS sessions_active_token")
                connection.execute("ALTER TABLE sessions RENAME TO sessions_v1")
                connection.execute(
                    "CREATE TABLE sessions ("
                    "id TEXT PRIMARY KEY, "
                    "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                    "token_hash TEXT NOT NULL UNIQUE, "
                    "transport TEXT NOT NULL CHECK (transport IN ('web', 'desktop', 'openai')), "
                    "created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)"
                )
                connection.execute(
                    "CREATE INDEX sessions_active_token "
                    "ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL"
                )
                AccountStore._copy_v1_sessions(connection)
                connection.execute("DROP TABLE sessions_v1")
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)", (_utcnow(),)
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    @staticmethod
    def _copy_v1_sessions(connection: sqlite3.Connection) -> None:
        connection.execute(
            "INSERT INTO sessions(id, user_id, token_hash, transport, created_at, expires_at, revoked_at) "
            "SELECT id, user_id, token_hash, transport, created_at, expires_at, revoked_at FROM sessions_v1"
        )

    @staticmethod
    def _audit(connection: sqlite3.Connection, action: str, user_id: str | None = None, detail: str = "") -> None:
        connection.execute(
            "INSERT INTO audit(id, user_id, action, created_at, detail) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), user_id, action, _utcnow(), detail),
        )
        connection.execute(
            "DELETE FROM audit WHERE id IN ("
            "SELECT id FROM audit ORDER BY created_at DESC LIMIT -1 OFFSET ?)", (_AUDIT_LIMIT,)
        )

    def _ensure_bootstrap(self) -> None:
        with self._connect() as connection:
            if connection.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                return
        username = _clean_username(os.getenv("JARVIS_ADMIN_USERNAME", ""))
        password = os.getenv("JARVIS_ADMIN_PASSWORD", "")
        if (not username or not password or _is_placeholder(username)
                or _is_placeholder(password) or not session_secret_configured()):
            return
        now = _utcnow()
        user_id = str(uuid.uuid4())
        password_hash = _PASSWORDS.hash(password)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if not connection.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                connection.execute(
                    "INSERT INTO users(id, username, role, password_hash, created_at, updated_at) "
                    "VALUES (?, ?, 'Owner', ?, ?, ?)",
                    (user_id, username, password_hash, now, now),
                )
                self._audit(connection, "bootstrap_owner", user_id)
            connection.commit()

    def authenticate_user(self, username: str, password: str) -> tuple[str, str, str] | None:
        """Verify credentials without holding a SQLite write transaction during Argon2 work."""
        username = _clean_username(username)
        self._ensure_bootstrap()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, username, role, password_hash FROM users WHERE username = ? AND active = 1",
                (username,),
            ).fetchone()
        candidate = row["password_hash"] if row else _DUMMY_HASH
        try:
            verified = _PASSWORDS.verify(password, candidate)
        except Exception:
            verified = False
        if not row or not verified:
            with self._connect() as connection:
                self._audit(connection, "login_failed")
            return None
        _remember_weak(row["id"], row["username"], row["password_hash"],
                       password_is_weak(password, row["username"]))
        return row["id"], row["username"], row["role"]

    def password_weak(self, user_id: str) -> bool:
        """该用户当前口令是否被判为弱口令（登录或启动核查时得出；未知按 False）。"""
        with _WEAK_FLAGS_LOCK:
            cached = _WEAK_FLAGS.get(user_id)
        if not cached or not cached[1]:
            return False
        with self._connect() as connection:
            row = connection.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        return bool(row and row["password_hash"] == cached[0])

    def scan_weak_passwords(self) -> list[dict]:
        """启动核查：用最常见的默认口令逐个比对已存哈希，命中即 WARNING。

        只读、不改密、不锁号；结果进缓存，供 /api/session 的 password_weak 使用
        （服务重启后带旧 cookie 的会话不必重新登录也能拿到提示）。"""
        self._ensure_bootstrap()
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, username, password_hash FROM users WHERE active = 1 ORDER BY username"
            ).fetchall()
        weak_users: list[dict] = []
        for row in rows:
            with _WEAK_FLAGS_LOCK:
                cached = _WEAK_FLAGS.get(row["id"])
            if cached and cached[0] == row["password_hash"]:
                weak = cached[1]
                if weak:
                    _weak_warning(row["username"])
            else:
                username = row["username"]
                candidates = dict.fromkeys((*_SCAN_CANDIDATES, username, username.casefold(),
                                            f"{username}123", f"{username}888"))
                weak = False
                for candidate in candidates:
                    try:
                        if _PASSWORDS.verify(candidate, row["password_hash"]):
                            weak = True
                            break
                    except Exception:
                        break   # 哈希格式异常：不判定，交给登录时的规则判定
                _remember_weak(row["id"], username, row["password_hash"], weak)
            if weak:
                weak_users.append({"id": row["id"], "username": row["username"]})
        return weak_users

    def authenticate(self, username: str, password: str, transport: str) -> tuple[Principal, str, str | None] | None:
        """Authenticate and mint one independent session; failed logins are deliberately uniform."""
        user = self.authenticate_user(username, password)
        if user is None:
            return None
        issued = self.issue_session(user[0], transport)
        if issued is None:
            return None
        principal, token = issued
        return principal, token, csrf_token(token, principal.session_id) if transport == "web" else None

    @staticmethod
    def _insert_session(connection: sqlite3.Connection, user_id: str, transport: str,
                        token: str, session_id: str, expires_at: str) -> None:
        connection.execute(
            "INSERT INTO sessions(id, user_id, token_hash, transport, created_at, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, user_id, _digest(token), transport, _utcnow(), expires_at),
        )

    def issue_session(self, user_id: str, transport: str) -> tuple[Principal, str] | None:
        if transport not in {"web", "desktop", "openai"}:
            return None
        token = secrets.token_urlsafe(32)
        session_id = str(uuid.uuid4())
        expires_at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=_SESSION_DAYS)).isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT id, username, role FROM users WHERE id = ? AND active = 1", (user_id,)
            ).fetchone()
            if not row:
                connection.rollback()
                return None
            self._insert_session(connection, row["id"], transport, token, session_id, expires_at)
            self._audit(connection, "login", row["id"], transport)
            connection.commit()
        return Principal(row["id"], row["username"], row["role"], session_id, transport), token

    def issue_desktop_and_openai(self, user_id: str) -> tuple[tuple[Principal, str], tuple[Principal, str]] | None:
        """Create paired desktop and OpenAI sessions atomically after one credential check."""
        desktop_token, openai_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        desktop_id, openai_id = str(uuid.uuid4()), str(uuid.uuid4())
        expires_at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=_SESSION_DAYS)).isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    "SELECT id, username, role FROM users WHERE id = ? AND active = 1", (user_id,)
                ).fetchone()
                if not row:
                    connection.rollback()
                    return None
                self._insert_session(connection, row["id"], "desktop", desktop_token, desktop_id, expires_at)
                self._insert_session(connection, row["id"], "openai", openai_token, openai_id, expires_at)
                self._audit(connection, "desktop_login", row["id"])
                connection.commit()
            except Exception:
                connection.rollback()
                return None
        desktop = Principal(row["id"], row["username"], row["role"], desktop_id, "desktop"), desktop_token
        openai = Principal(row["id"], row["username"], row["role"], openai_id, "openai"), openai_token
        return desktop, openai

    def principal_for_token(self, token: str, transport: str) -> Principal | None:
        if not token:
            return None
        with self._connect() as connection:
            row = connection.execute(
                "SELECT u.id AS user_id, u.username, u.role, s.id AS session_id, s.transport "
                "FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash = ? AND s.transport = ? AND s.revoked_at IS NULL "
                "AND s.expires_at > ? AND u.active = 1",
                (_digest(token), transport, _utcnow()),
            ).fetchone()
        if not row:
            return None
        return Principal(row["user_id"], row["username"], row["role"], row["session_id"], row["transport"])

    def expiry_for(self, principal: Principal) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT expires_at FROM sessions WHERE id = ? AND revoked_at IS NULL", (principal.session_id,)
            ).fetchone()
        return row["expires_at"] if row else None

    def csrf_valid(self, principal: Principal, token: str, supplied_csrf: str) -> bool:
        if not supplied_csrf or principal.transport != "web":
            return False
        expected = csrf_token(token, principal.session_id)
        return bool(expected and hmac.compare_digest(expected, supplied_csrf))

    def revoke_session(self, session_id: str) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (_utcnow(), session_id))

    def list_users(self) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, username, role, active, created_at, updated_at FROM users ORDER BY username"
            ).fetchall()
        return [dict(row) for row in rows]

    def unique_active_owner(self) -> Principal | None:
        """Return the only active Owner for fixed-owner transports, else fail closed."""
        self._ensure_bootstrap()
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, username, role FROM users WHERE role='Owner' AND active=1"
            ).fetchall()
        if len(rows) != 1:
            return None
        row = rows[0]
        return Principal(row["id"], row["username"], row["role"], "fixed-owner", "fixed")

    def create_user(self, username: str, password: str, role: str) -> dict | None:
        username = _clean_username(username)
        if not username or not password or role not in _ROLES:
            return None
        now = _utcnow()
        user_id = str(uuid.uuid4())
        password_hash = _PASSWORDS.hash(password)
        try:
            with self._connect() as connection:
                connection.execute(
                    "INSERT INTO users(id, username, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (user_id, username, role, password_hash, now, now),
                )
                self._audit(connection, "user_created", user_id, role)
        except sqlite3.IntegrityError:
            return None
        _remember_weak(user_id, username, password_hash, password_is_weak(password, username))
        return {"id": user_id, "username": username, "role": role, "active": 1, "created_at": now, "updated_at": now}

    def update_user(self, user_id: str, *, username: str | None = None, role: str | None = None,
                    password: str | None = None, active: bool | None = None) -> dict | None:
        if role is not None and role not in _ROLES:
            return None
        updates: list[str] = []
        values: list[object] = []
        if username is not None:
            username = _clean_username(username)
            if not username:
                return None
            updates.append("username = ?")
            values.append(username)
        if role is not None:
            updates.append("role = ?")
            values.append(role)
        new_hash = None
        if password is not None:
            if not password:
                return None
            new_hash = _PASSWORDS.hash(password)
            updates.append("password_hash = ?")
            values.append(new_hash)
        if active is not None:
            updates.append("active = ?")
            values.append(int(active))
        if not updates:
            return None
        updates.append("updated_at = ?")
        values.append(_utcnow())
        values.append(user_id)
        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute("SELECT role, active FROM users WHERE id = ?", (user_id,)).fetchone()
                if not existing:
                    connection.rollback()
                    return None
                removes_last_owner = (
                    existing["role"] == "Owner" and existing["active"]
                    and (role == "Member" or active is False)
                    and connection.execute(
                        "SELECT COUNT(*) FROM users WHERE role = 'Owner' AND active = 1"
                    ).fetchone()[0] == 1
                )
                if removes_last_owner:
                    connection.rollback()
                    return None
                changed = connection.execute("UPDATE users SET " + ", ".join(updates) + " WHERE id = ?", values)
                if not changed.rowcount:
                    connection.rollback()
                    return None
                if password is not None or active is False:
                    connection.execute("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (_utcnow(), user_id))
                self._audit(connection, "user_updated", user_id)
                row = connection.execute(
                    "SELECT id, username, role, active, created_at, updated_at FROM users WHERE id = ?", (user_id,)
                ).fetchone()
        except sqlite3.IntegrityError:
            return None
        if row and new_hash is not None:
            _remember_weak(row["id"], row["username"], new_hash, password_is_weak(password, row["username"]))
        return dict(row) if row else None

    def change_password(self, principal: Principal, current_password: str, new_password: str) -> bool:
        if not new_password:
            return False
        with self._connect() as connection:
            row = connection.execute("SELECT password_hash FROM users WHERE id = ?", (principal.user_id,)).fetchone()
            try:
                valid = bool(row and _PASSWORDS.verify(current_password, row["password_hash"]))
            except Exception:
                valid = False
            if not valid:
                return False
            new_hash = _PASSWORDS.hash(new_password)
            connection.execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                (new_hash, _utcnow(), principal.user_id),
            )
            connection.execute(
                "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                (_utcnow(), principal.user_id),
            )
            self._audit(connection, "password_changed", principal.user_id)
        _remember_weak(principal.user_id, principal.username, new_hash,
                       password_is_weak(new_password, principal.username))
        return True
