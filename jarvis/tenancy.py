"""Per-user persistent state, deliberately separate from request supplied data."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import datetime as dt
import json
import os
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

from jarvis import config


class TenantScopeError(RuntimeError):
    """Raised when a personal-data operation lacks an authenticated owner."""


class TenantMigrationError(RuntimeError):
    """Raised when legacy state cannot be safely imported."""


_OWNER: ContextVar[str | None] = ContextVar("jarvis_tenant_owner", default=None)
_MIGRATION_LOCK = threading.Lock()
_LEGACY = ("threads.json", "memos.json", "todos.json", "schedule.json", "location.json", "local_status.json")


def current_owner_id() -> str:
    owner_id = _OWNER.get()
    if not owner_id:
        raise TenantScopeError("tenant scope is required")
    return owner_id


@contextmanager
def tenant_scope(owner_id: str):
    """Bind exactly one authenticated owner for this synchronous/async context."""
    if not isinstance(owner_id, str) or not owner_id:
        raise TenantScopeError("invalid tenant owner")
    token = _OWNER.set(owner_id)
    try:
        yield
    finally:
        _OWNER.reset(token)


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


@dataclass(frozen=True)
class TenantThread:
    alias: str
    title: str
    checkpoint_thread_id: str
    updated: str


class TenantStore:
    """Versioned SQLite state bound to the ``users`` table by foreign keys."""

    def __init__(self, path: Path | None = None, *, legacy_dir: Path | None = None) -> None:
        self.path = path or (config.data_dir() / "accounts.sqlite3")
        self.legacy_dir = legacy_dir or config.data_dir()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with _MIGRATION_LOCK:
                self._migrate(connection)
        except Exception:
            connection.close()
            raise
        try:
            self.path.chmod(0o600)
        except OSError:
            pass
        return connection

    @staticmethod
    def _schema_statements() -> tuple[str, ...]:
        return (
            "CREATE TABLE IF NOT EXISTS tenant_legacy_migrations (name TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), applied_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS tenant_threads (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, alias TEXT NOT NULL, checkpoint_thread_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, alias), UNIQUE(owner_id, checkpoint_thread_id))",
            "CREATE TABLE IF NOT EXISTS tenant_memos (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner_id, id))",
            "CREATE TABLE IF NOT EXISTS tenant_todos (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id INTEGER NOT NULL, content TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)), created_at TEXT NOT NULL, PRIMARY KEY(owner_id, id))",
            "CREATE TABLE IF NOT EXISTS tenant_schedule (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id INTEGER NOT NULL, title TEXT NOT NULL, when_at TEXT NOT NULL, PRIMARY KEY(owner_id, id))",
            "CREATE TABLE IF NOT EXISTS tenant_location (owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, lat REAL NOT NULL, lon REAL NOT NULL, place TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS tenant_local_status (owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, payload TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )

    @staticmethod
    def _migrate(connection: sqlite3.Connection) -> None:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone():
            raise TenantMigrationError("accounts database is required before tenant state")
        connection.execute("CREATE TABLE IF NOT EXISTS tenant_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        if connection.execute("SELECT 1 FROM tenant_schema_migrations WHERE version=1").fetchone():
            return
        connection.execute("BEGIN IMMEDIATE")
        try:
            for statement in TenantStore._schema_statements():
                connection.execute(statement)
            connection.execute("INSERT INTO tenant_schema_migrations(version, applied_at) VALUES(1, ?)", (_now(),))
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    @staticmethod
    def _owner(owner_id: str | None) -> str:
        return owner_id if owner_id is not None else current_owner_id()

    def _next_id(self, connection: sqlite3.Connection, table: str, owner_id: str) -> int:
        return int(connection.execute(f"SELECT COALESCE(MAX(id), 0) + 1 FROM {table} WHERE owner_id=?", (owner_id,)).fetchone()[0])

    def upsert_thread(self, alias: str, first_message: str, *, owner_id: str | None = None,
                      checkpoint_thread_id: str | None = None, title: str | None = None,
                      updated_at: str | None = None) -> TenantThread:
        owner = self._owner(owner_id)
        if not alias:
            raise ValueError("thread alias is required")
        now = updated_at or _now()
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                row = c.execute("SELECT alias, title, checkpoint_thread_id, updated_at FROM tenant_threads WHERE owner_id=? AND alias=?", (owner, alias)).fetchone()
                if row:
                    c.execute("UPDATE tenant_threads SET updated_at=? WHERE owner_id=? AND alias=?", (now, owner, alias))
                    c.commit()
                    return TenantThread(alias, row["title"], row["checkpoint_thread_id"], now)
                checkpoint = checkpoint_thread_id or f"tenant:{owner}:{uuid.uuid4().hex}"
                thread_title = title or first_message.strip().replace("\n", " ")[:24] or "新对话"
                c.execute("INSERT INTO tenant_threads(owner_id,alias,checkpoint_thread_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)", (owner, alias, checkpoint, thread_title, now, now))
                c.commit()
                return TenantThread(alias, thread_title, checkpoint, now)
            except Exception:
                c.rollback()
                raise

    def get_thread(self, alias: str, *, owner_id: str | None = None) -> TenantThread | None:
        owner = self._owner(owner_id)
        with self._connect() as c:
            row = c.execute("SELECT alias,title,checkpoint_thread_id,updated_at FROM tenant_threads WHERE owner_id=? AND alias=?", (owner, alias)).fetchone()
        return TenantThread(row["alias"], row["title"], row["checkpoint_thread_id"], row["updated_at"]) if row else None

    def list_threads(self, *, owner_id: str | None = None) -> list[dict]:
        owner = self._owner(owner_id)
        with self._connect() as c:
            rows = c.execute("SELECT alias,title,updated_at FROM tenant_threads WHERE owner_id=? ORDER BY updated_at DESC", (owner,)).fetchall()
        return [{"id": r["alias"], "title": r["title"], "updated": r["updated_at"]} for r in rows]

    def delete_thread(self, alias: str, *, owner_id: str | None = None) -> TenantThread | None:
        owner = self._owner(owner_id)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT alias,title,checkpoint_thread_id,updated_at FROM tenant_threads WHERE owner_id=? AND alias=?", (owner, alias)).fetchone()
            if not row:
                c.rollback()
                return None
            c.execute("DELETE FROM tenant_threads WHERE owner_id=? AND alias=?", (owner, alias))
            c.commit()
        return TenantThread(row["alias"], row["title"], row["checkpoint_thread_id"], row["updated_at"])

    def add_memo(self, content: str, *, owner_id: str | None = None, legacy_id: int | None = None, created_at: str | None = None) -> dict:
        owner = self._owner(owner_id)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                item_id = legacy_id if legacy_id is not None else self._next_id(c, "tenant_memos", owner)
                c.execute("INSERT INTO tenant_memos(owner_id,id,content,created_at) VALUES(?,?,?,?)", (owner, item_id, content, created_at or _now()))
                c.commit()
            except Exception:
                c.rollback(); raise
        return {"id": item_id, "content": content}

    def list_memos(self, *, owner_id: str | None = None) -> list[dict]:
        owner = self._owner(owner_id)
        with self._connect() as c: rows = c.execute("SELECT id,content FROM tenant_memos WHERE owner_id=? ORDER BY id", (owner,)).fetchall()
        return [dict(r) for r in rows]

    def delete_memo(self, item_id: int, *, owner_id: str | None = None) -> bool:
        owner = self._owner(owner_id)
        with self._connect() as c: return bool(c.execute("DELETE FROM tenant_memos WHERE owner_id=? AND id=?", (owner, item_id)).rowcount)

    def add_todo(self, content: str, *, owner_id: str | None = None, legacy_id: int | None = None, done: bool = False, created_at: str | None = None) -> dict:
        owner = self._owner(owner_id)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                item_id = legacy_id if legacy_id is not None else self._next_id(c, "tenant_todos", owner)
                c.execute("INSERT INTO tenant_todos(owner_id,id,content,done,created_at) VALUES(?,?,?,?,?)", (owner, item_id, content, int(done), created_at or _now()))
                c.commit()
            except Exception:
                c.rollback(); raise
        return {"id": item_id, "content": content, "done": bool(done)}

    def list_todos(self, *, owner_id: str | None = None) -> list[dict]:
        owner = self._owner(owner_id)
        with self._connect() as c: rows = c.execute("SELECT id,content,done FROM tenant_todos WHERE owner_id=? ORDER BY id", (owner,)).fetchall()
        return [{"id": r["id"], "content": r["content"], "done": bool(r["done"])} for r in rows]

    def mark_todo_done(self, item_id: int, *, owner_id: str | None = None) -> tuple[bool, bool, str | None]:
        owner = self._owner(owner_id)
        with self._connect() as c:
            row = c.execute("SELECT content,done FROM tenant_todos WHERE owner_id=? AND id=?", (owner, item_id)).fetchone()
            if not row: return False, False, None
            if row["done"]: return True, True, row["content"]
            c.execute("UPDATE tenant_todos SET done=1 WHERE owner_id=? AND id=?", (owner, item_id))
            return True, False, row["content"]

    def add_schedule(self, title: str, when: str, *, owner_id: str | None = None, legacy_id: int | None = None) -> dict:
        owner = self._owner(owner_id)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                item_id = legacy_id if legacy_id is not None else self._next_id(c, "tenant_schedule", owner)
                c.execute("INSERT INTO tenant_schedule(owner_id,id,title,when_at) VALUES(?,?,?,?)", (owner, item_id, title, when))
                c.commit()
            except Exception:
                c.rollback(); raise
        return {"id": item_id, "title": title, "when": when}

    def list_schedule(self, *, owner_id: str | None = None) -> list[dict]:
        owner = self._owner(owner_id)
        with self._connect() as c: rows = c.execute("SELECT id,title,when_at FROM tenant_schedule WHERE owner_id=? ORDER BY when_at,id", (owner,)).fetchall()
        return [{"id": r["id"], "title": r["title"], "when": r["when_at"]} for r in rows]

    def delete_schedule(self, item_id: int, *, owner_id: str | None = None) -> bool:
        owner = self._owner(owner_id)
        with self._connect() as c: return bool(c.execute("DELETE FROM tenant_schedule WHERE owner_id=? AND id=?", (owner, item_id)).rowcount)

    def get_location(self, *, owner_id: str | None = None) -> dict | None:
        owner = self._owner(owner_id)
        with self._connect() as c: row = c.execute("SELECT lat,lon,place,source,updated_at FROM tenant_location WHERE owner_id=?", (owner,)).fetchone()
        return ({"lat": row["lat"], "lon": row["lon"], "place": row["place"], "source": row["source"], "updated": row["updated_at"]} if row else None)

    def set_location(self, lat: float, lon: float, source: str, place: str, *, owner_id: str | None = None, updated_at: str | None = None) -> None:
        owner = self._owner(owner_id)
        with self._connect() as c: c.execute("INSERT INTO tenant_location(owner_id,lat,lon,place,source,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET lat=excluded.lat,lon=excluded.lon,place=excluded.place,source=excluded.source,updated_at=excluded.updated_at", (owner, lat, lon, place, source, updated_at or _now()))

    def get_local_status(self, *, owner_id: str | None = None) -> dict | None:
        owner = self._owner(owner_id)
        with self._connect() as c: row = c.execute("SELECT payload,updated_at FROM tenant_local_status WHERE owner_id=?", (owner,)).fetchone()
        return ({**json.loads(row["payload"]), "updated": row["updated_at"]} if row else None)

    def set_local_status(self, coding: list[dict], *, owner_id: str | None = None) -> None:
        owner = self._owner(owner_id); now = _now()
        with self._connect() as c: c.execute("INSERT INTO tenant_local_status(owner_id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at", (owner, json.dumps({"coding": coding[:10]}, ensure_ascii=False), now))

    def _unique_owner(self, connection: sqlite3.Connection) -> str | None:
        rows = connection.execute("SELECT id FROM users WHERE role='Owner' AND active=1").fetchall()
        return rows[0]["id"] if len(rows) == 1 else None

    def _backup(self, path: Path, content: bytes) -> None:
        backup = path.with_name(path.name + ".tenant-v1.bak")
        if backup.exists():
            if backup.read_bytes() != content: raise TenantMigrationError("legacy backup differs")
            if backup.stat().st_mode & 0o777 != 0o600: backup.chmod(0o600)
            return
        temporary = backup.with_name(backup.name + ".tmp")
        temporary.write_bytes(content); temporary.chmod(0o600); os.replace(temporary, backup); backup.chmod(0o600)

    def migrate_legacy(self) -> bool:
        """Backup then atomically import old JSON only when exactly one Owner exists."""
        # Completion is authoritative: do not even read old files after a completed import.
        with self._connect() as c:
            if c.execute("SELECT 1 FROM tenant_legacy_migrations WHERE name='legacy-json-v1'").fetchone():
                return False
        files: dict[str, object] = {}
        raw: dict[str, bytes] = {}
        for name in _LEGACY:
            path = self.legacy_dir / name
            if path.exists():
                try:
                    raw[name] = path.read_bytes(); files[name] = json.loads(raw[name].decode("utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise TenantMigrationError("invalid legacy JSON") from exc
        # An empty data directory is not a migration.  Do not write a marker: files might
        # be restored later, and ordinary tenant requests must remain read-only here.
        if not raw:
            return False
        with self._connect() as c:
            owner = self._unique_owner(c)
        if owner is None: raise TenantMigrationError("legacy migration requires exactly one active Owner")
        for name, content in raw.items(): self._backup(self.legacy_dir / name, content)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                if c.execute("SELECT 1 FROM tenant_legacy_migrations WHERE name='legacy-json-v1'").fetchone():
                    c.commit(); return False
                # The pre-backup lookup is only an optimization.  Ownership can change
                # while backups are written, so the import transaction is authoritative.
                transaction_owner = self._unique_owner(c)
                if transaction_owner is None or transaction_owner != owner:
                    raise TenantMigrationError("legacy migration requires exactly one unchanged active Owner")
                self._import_legacy(c, owner, files)
                c.execute("INSERT INTO tenant_legacy_migrations(name,owner_id,applied_at) VALUES('legacy-json-v1',?,?)", (owner, _now()))
                c.commit(); return True
            except Exception:
                c.rollback(); raise

    def _import_legacy(self, c: sqlite3.Connection, owner: str, files: dict[str, object]) -> None:
        def rows(name: str) -> list[dict]:
            value = files.get(name, [])
            if not isinstance(value, list) or not all(isinstance(x, dict) for x in value): raise TenantMigrationError("invalid legacy list")
            return value
        for item in rows("threads.json"):
            alias = item.get("id")
            if not isinstance(alias, str) or not alias: raise TenantMigrationError("invalid legacy thread")
            title = item.get("title", "新对话"); updated = item.get("updated") or _now()
            if not isinstance(title, str) or not isinstance(updated, str): raise TenantMigrationError("invalid legacy thread")
            c.execute("INSERT INTO tenant_threads(owner_id,alias,checkpoint_thread_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)", (owner, alias, alias, title, updated, updated))
        for item in rows("memos.json"):
            if not isinstance(item.get("id"), int) or not isinstance(item.get("content"), str): raise TenantMigrationError("invalid legacy memo")
            c.execute("INSERT INTO tenant_memos(owner_id,id,content,created_at) VALUES(?,?,?,?)", (owner,item["id"],item["content"],item.get("created") if isinstance(item.get("created"),str) else _now()))
        for item in rows("todos.json"):
            if not isinstance(item.get("id"), int) or not isinstance(item.get("content"), str): raise TenantMigrationError("invalid legacy todo")
            c.execute("INSERT INTO tenant_todos(owner_id,id,content,done,created_at) VALUES(?,?,?,?,?)", (owner,item["id"],item["content"],int(bool(item.get("done"))),item.get("created") if isinstance(item.get("created"),str) else _now()))
        for item in rows("schedule.json"):
            if not isinstance(item.get("id"), int) or not isinstance(item.get("title"), str) or not isinstance(item.get("when"), str): raise TenantMigrationError("invalid legacy schedule")
            c.execute("INSERT INTO tenant_schedule(owner_id,id,title,when_at) VALUES(?,?,?,?)", (owner,item["id"],item["title"],item["when"]))
        location = files.get("location.json")
        if location is not None:
            if not isinstance(location, dict) or not isinstance(location.get("lat"), (int,float)) or not isinstance(location.get("lon"), (int,float)): raise TenantMigrationError("invalid legacy location")
            c.execute("INSERT INTO tenant_location(owner_id,lat,lon,place,source,updated_at) VALUES(?,?,?,?,?,?)", (owner,location["lat"],location["lon"],str(location.get("place", "")),str(location.get("source", "")),str(location.get("updated", _now()))))
        status = files.get("local_status.json")
        if status is not None:
            if not isinstance(status, dict) or not isinstance(status.get("coding", []), list): raise TenantMigrationError("invalid legacy local status")
            c.execute("INSERT INTO tenant_local_status(owner_id,payload,updated_at) VALUES(?,?,?)", (owner,json.dumps({"coding": status.get("coding", [])[:10]}, ensure_ascii=False),str(status.get("updated", _now()))))
