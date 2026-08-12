"""SQLite-backed account and session primitives for every JARVIS client."""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

from pwdlib import PasswordHash

from jarvis import config


_PASSWORDS = PasswordHash.recommended()
_SESSION_DAYS = 30
_DUMMY_HASH = _PASSWORDS.hash("not-a-real-password")
_ROLES = frozenset(("Owner", "Member"))
_AUDIT_LIMIT = 10_000
_MIGRATION_LOCK = threading.Lock()


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


def _session_secret() -> bytes | None:
    """Read the explicitly configured CSRF secret; never create a fallback secret."""
    value = os.getenv("JARVIS_SESSION_SECRET", "")
    encoded = value.encode("utf-8")
    return encoded if len(encoded) >= 32 else None


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


class AccountStore:
    """Small, per-operation SQLite store; raw passwords and tokens never reach disk."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        path = self.path or (config.data_dir() / "accounts.sqlite3")
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        with _MIGRATION_LOCK:
            self._migrate(connection)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return connection

    @staticmethod
    def _migrate(connection: sqlite3.Connection) -> None:
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
        sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"
        ).fetchone()[0]
        if "'openai'" not in sql:
            connection.execute("DROP INDEX IF EXISTS sessions_active_token")
            connection.execute("ALTER TABLE sessions RENAME TO sessions_v1")
            connection.executescript(
                """
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token_hash TEXT NOT NULL UNIQUE,
                    transport TEXT NOT NULL CHECK (transport IN ('web', 'desktop', 'openai')),
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    revoked_at TEXT
                );
                CREATE INDEX sessions_active_token
                    ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;
                """
            )
            connection.execute(
                "INSERT INTO sessions(id, user_id, token_hash, transport, created_at, expires_at, revoked_at) "
                "SELECT id, user_id, token_hash, transport, created_at, expires_at, revoked_at FROM sessions_v1"
            )
            connection.execute("DROP TABLE sessions_v1")
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)", (_utcnow(),)
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
        if not username or not password:
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

    def authenticate(self, username: str, password: str, transport: str) -> tuple[Principal, str, str | None] | None:
        """Authenticate and mint one independent session; failed logins are deliberately uniform."""
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
        issued = self.issue_session(row["id"], transport)
        if issued is None:
            return None
        principal, token = issued
        return principal, token, csrf_token(token, principal.session_id) if transport == "web" else None

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
            connection.execute(
                "INSERT INTO sessions(id, user_id, token_hash, transport, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, row["id"], _digest(token), transport, _utcnow(), expires_at),
            )
            self._audit(connection, "login", row["id"], transport)
            connection.commit()
        return Principal(row["id"], row["username"], row["role"], session_id, transport), token

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

    def create_user(self, username: str, password: str, role: str) -> dict | None:
        username = _clean_username(username)
        if not username or not password or role not in _ROLES:
            return None
        now = _utcnow()
        user_id = str(uuid.uuid4())
        try:
            with self._connect() as connection:
                connection.execute(
                    "INSERT INTO users(id, username, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (user_id, username, role, _PASSWORDS.hash(password), now, now),
                )
                self._audit(connection, "user_created", user_id, role)
        except sqlite3.IntegrityError:
            return None
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
        if password is not None:
            if not password:
                return None
            updates.append("password_hash = ?")
            values.append(_PASSWORDS.hash(password))
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
            connection.execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                (_PASSWORDS.hash(new_password), _utcnow(), principal.user_id),
            )
            connection.execute(
                "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                (_utcnow(), principal.user_id),
            )
            self._audit(connection, "password_changed", principal.user_id)
        return True
