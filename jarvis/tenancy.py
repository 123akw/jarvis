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
from jarvis.db import ClosingConnection


class TenantScopeError(RuntimeError):
    """Raised when a personal-data operation lacks an authenticated owner."""


class TenantMigrationError(RuntimeError):
    """Raised when legacy state cannot be safely imported."""


_OWNER: ContextVar[str | None] = ContextVar("jarvis_tenant_owner", default=None)
_MIGRATION_LOCK = threading.Lock()
# 迁移成功过的库路径：同进程内不再逐连接重跑版本检查（每次 DB 操作都开新连接，
# 这笔固定开销在 dashboard 等多查询端点上会乘好几倍）。只缓存成功；失败照常抛。
_MIGRATED_PATHS: set[str] = set()
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


WHEN_FORMAT = "%Y-%m-%d %H:%M"
MAX_ITEM_ID = 2**63 - 1   # SQLite INTEGER 上限；超界 id 会 OverflowError


def canonical_when(value: str) -> str:
    """把日程时间规范成补零的「YYYY-MM-DD HH:MM」；不合法抛 ValueError。

    strptime 接受「2026-1-2 3:04」这类不补零写法，但提醒扫描（due_reminders）按
    字典序比较 when_at，原样入库会让提醒落进错误窗口（永不提醒或提前提醒）。
    用 isoformat 而非 strftime：%Y 在部分平台不给四位年份补零。"""
    parsed = dt.datetime.strptime(str(value).strip(), WHEN_FORMAT)
    return parsed.isoformat(sep=" ", timespec="minutes")


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
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        path_key = str(self.path)
        if path_key not in _MIGRATED_PATHS:
            try:
                with _MIGRATION_LOCK:
                    self._migrate(connection)
                    _MIGRATED_PATHS.add(path_key)
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
    def _schema_v2_statements() -> tuple[str, ...]:
        """v2（2026-08-14 体验升级）：提醒记账、长期画像、通用偏好。

        新表必须走独立版本号：v1 的建表列表被版本门挡住，只在全新库上执行，
        往 v1 列表里加表对存量库（生产）完全无效——线上已实际踩过这一坑。
        """
        return (
            "CREATE TABLE IF NOT EXISTS tenant_reminders_sent (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, schedule_id INTEGER NOT NULL, when_at TEXT NOT NULL, channel TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY(owner_id, schedule_id, when_at, channel))",
            "CREATE TABLE IF NOT EXISTS tenant_profile (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner_id, id))",
            "CREATE TABLE IF NOT EXISTS tenant_prefs (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, key))",
        )

    @staticmethod
    def _schema_v3_statements() -> tuple[str, ...]:
        """v3（2026-08-24 会议纪要）：转写与纪要按用户落库，可回看可重发邮件。"""
        return (
            "CREATE TABLE IF NOT EXISTS tenant_meetings (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id INTEGER NOT NULL, title TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, transcript TEXT NOT NULL, minutes TEXT NOT NULL, mailed_to TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY(owner_id, id))",
        )

    @staticmethod
    def _schema_v4_statements() -> tuple[str, ...]:
        """v4（2026-10 翻旧账）：历史消息检索副本 + 每个会话的同步水位。

        消息本体仍在 LangGraph checkpoint 里；这里只存检索用的文本副本（按用户隔离、
        随删会话一起删）。FTS5 trigram 索引是派生物，由 history_index.ensure_fts 幂等补建，
        不占版本号：SQLite 不支持 trigram 时退回 LIKE，库结构照样完整。"""
        return (
            "CREATE TABLE IF NOT EXISTS tenant_message_index (id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, alias TEXT NOT NULL, msg_key TEXT NOT NULL, pos INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(owner_id, alias, msg_key))",
            "CREATE INDEX IF NOT EXISTS tenant_message_index_recent ON tenant_message_index(owner_id, created_at)",
            "CREATE TABLE IF NOT EXISTS tenant_message_sync (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, alias TEXT NOT NULL, thread_updated_at TEXT NOT NULL, synced_at TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)), PRIMARY KEY(owner_id, alias))",
        )

    @staticmethod
    def _schema_v5_statements() -> tuple[str, ...]:
        """v5（2026-10 智能平台工坊）：一个账号一个平台，slug 全站唯一（公开入口 /p/<slug>）。

        plugins 是插件 id 的 JSON 数组；created_via 记开通方式（guest 游客市场注册 /
        owner 由 Owner 代开 / account 已登录账号自己装），created_by 是代开的 Owner。"""
        return (
            "CREATE TABLE IF NOT EXISTS tenant_platforms (owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL, accent TEXT NOT NULL, profession TEXT NOT NULL DEFAULT '', plugins TEXT NOT NULL DEFAULT '[]', created_via TEXT NOT NULL DEFAULT 'account', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )

    @staticmethod
    def _schema_v6_statements() -> tuple[str, ...]:
        """v6（2026-10 平台工坊·流程）：积木流程 + 每次运行的记录与公开结果页。

        结果页挂在运行记录上（page_token 全局唯一，公开链接按它反查，不带租户）；
        每个流程只留最近 20 次运行，结果页另有 30 天时效（jarvis/flows/store.py）。"""
        return (
            "CREATE TABLE IF NOT EXISTS tenant_flows (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, id))",
            "CREATE TABLE IF NOT EXISTS tenant_flow_runs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, flow_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','ok','error')), input TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, finished_at TEXT, page_token TEXT UNIQUE, page_title TEXT, page_text TEXT, page_links TEXT, page_expires_at TEXT)",
            "CREATE INDEX IF NOT EXISTS tenant_flow_runs_recent ON tenant_flow_runs(owner_id, flow_id, started_at)",
        )

    @staticmethod
    def _schema_v7_statements() -> tuple[str, ...]:
        """v7（2026-10 第十八轮·流程画布）：流程改为节点图 + 定时触发。

        - ``tenant_flows.graph``：节点图 JSON（``{"nodes": [...], "edges": [...]}``，见 jarvis/flows/graph.py）；
          空串表示还是 v6 的线性 ``steps``，读取时由 ``graph_from_steps`` 换算，不做离线批量改写；
        - ``tenant_flow_triggers``：每个流程至多一个触发器（定时运行），由 jarvis/flows/schedule.py 读写。"""
        return (
            "ALTER TABLE tenant_flows ADD COLUMN graph TEXT NOT NULL DEFAULT ''",
            "CREATE TABLE IF NOT EXISTS tenant_flow_triggers (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, flow_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'schedule', config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_status TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, flow_id))",
            "CREATE INDEX IF NOT EXISTS tenant_flow_triggers_due ON tenant_flow_triggers(enabled, next_run_at)",
        )

    @staticmethod
    def _schema_v8_statements() -> tuple[str, ...]:
        """v8（2026-10 第二十轮）：流程接进对话与消息、发送前确认、用量与配额。

        - ``tenant_flow_runs`` 重建：状态多出 waiting（停在「发送前确认」）/ rejected / expired，加 ``source``
          （manual / schedule / chat / webhook / message / rerun / test）；旧行原样搬过去；
        - ``tenant_flow_hooks``：流程的消息触发与链接触发（定时仍在 tenant_flow_triggers）；链接令牌只存 sha256；
        - ``tenant_flow_approvals``：停在确认节点的运行，``state`` 存恢复运行需要的上下文；
        - ``usage_daily`` / ``tenant_quotas`` / ``admin_alerts``：管理后台的用量、配额与告警。"""
        runs_cols = ("id, owner_id, flow_id, status, input, steps, error, started_at, finished_at, "
                     "page_token, page_title, page_text, page_links, page_expires_at")
        return (
            "CREATE TABLE tenant_flow_runs_v8 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, flow_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','ok','error','waiting','rejected','expired')), input TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, finished_at TEXT, page_token TEXT UNIQUE, page_title TEXT, page_text TEXT, page_links TEXT, page_expires_at TEXT, source TEXT NOT NULL DEFAULT 'manual')",
            f"INSERT INTO tenant_flow_runs_v8 ({runs_cols}) SELECT {runs_cols} FROM tenant_flow_runs",
            "DROP TABLE tenant_flow_runs",
            "ALTER TABLE tenant_flow_runs_v8 RENAME TO tenant_flow_runs",
            "CREATE INDEX IF NOT EXISTS tenant_flow_runs_recent ON tenant_flow_runs(owner_id, flow_id, started_at)",
            "CREATE TABLE IF NOT EXISTS tenant_flow_hooks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, flow_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('webhook','message')), config TEXT NOT NULL DEFAULT '{}', token_hash TEXT UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, last_hit_at TEXT, last_status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, flow_id, kind))",
            "CREATE TABLE IF NOT EXISTS tenant_flow_approvals (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, flow_id TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')), title TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT)",
            "CREATE INDEX IF NOT EXISTS tenant_flow_approvals_pending ON tenant_flow_approvals(owner_id, status, created_at)",
            "CREATE TABLE IF NOT EXISTS usage_daily (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, kind TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id, day, kind))",
            "CREATE TABLE IF NOT EXISTS tenant_quotas (owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, daily_model_calls INTEGER, daily_flow_runs INTEGER, updated_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS admin_alerts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, read_at TEXT)",
            "CREATE INDEX IF NOT EXISTS admin_alerts_recent ON admin_alerts(created_at)",
        )

    @staticmethod
    def _schema_v9_statements() -> tuple[str, ...]:
        """v9（2026-10 第二十一轮·个人助理）：流程下线，换成「交给贾维斯」的后台任务 + 关键动作同意 + 活动记录
        + 自动化 + 目标 + 想法（参考 Meta Muse / Manus Cue）。旧的 tenant_flow* 表原样保留，不删数据。"""
        return (
            "CREATE TABLE IF NOT EXISTS tenant_tasks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','done','failed','cancelled')), source TEXT NOT NULL DEFAULT 'chat', thread_id TEXT NOT NULL, plan TEXT NOT NULL DEFAULT '[]', result TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', automation_id TEXT, goal_id TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS tenant_tasks_recent ON tenant_tasks(owner_id, created_at)",
            "CREATE TABLE IF NOT EXISTS tenant_activity (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, at TEXT NOT NULL, kind TEXT NOT NULL, risk TEXT NOT NULL DEFAULT 'read', status TEXT NOT NULL DEFAULT 'ok', task_id TEXT, thread_id TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}')",
            "CREATE INDEX IF NOT EXISTS tenant_activity_recent ON tenant_activity(owner_id, at)",
            "CREATE INDEX IF NOT EXISTS tenant_activity_task ON tenant_activity(owner_id, task_id, at)",
            "CREATE TABLE IF NOT EXISTS tenant_consents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, thread_id TEXT NOT NULL, task_id TEXT, channel TEXT NOT NULL DEFAULT 'web', tool TEXT NOT NULL, risk TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', args TEXT NOT NULL DEFAULT '{}', editable TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')), note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT)",
            "CREATE INDEX IF NOT EXISTS tenant_consents_pending ON tenant_consents(owner_id, status, created_at)",
            "CREATE TABLE IF NOT EXISTS tenant_automations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, instruction TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_status TEXT NOT NULL DEFAULT '', last_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS tenant_automations_due ON tenant_automations(enabled, next_run_at)",
            "CREATE TABLE IF NOT EXISTS tenant_goals (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', strategy TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT '', progress INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','done','dropped')), deadline TEXT, check_in TEXT NOT NULL DEFAULT '{}', notes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS tenant_ideas (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '', score INTEGER NOT NULL DEFAULT 0, pushed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, dismissed_at TEXT, acted_at TEXT)",
            "CREATE INDEX IF NOT EXISTS tenant_ideas_recent ON tenant_ideas(owner_id, created_at)",
        )

    @staticmethod
    def _apply_version(connection: sqlite3.Connection, version: int, statements: tuple[str, ...]) -> None:
        if connection.execute("SELECT 1 FROM tenant_schema_migrations WHERE version=?", (version,)).fetchone():
            return
        connection.execute("BEGIN IMMEDIATE")
        try:
            for statement in statements:
                connection.execute(statement)
            connection.execute("INSERT INTO tenant_schema_migrations(version, applied_at) VALUES(?, ?)", (version, _now()))
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    @staticmethod
    def reset_migration_cache() -> None:
        """仅测试用：模拟「旧库升级」路径时清掉进程内迁移缓存。"""
        _MIGRATED_PATHS.clear()

    @staticmethod
    def _migrate(connection: sqlite3.Connection) -> None:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone():
            raise TenantMigrationError("accounts database is required before tenant state")
        connection.execute("CREATE TABLE IF NOT EXISTS tenant_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        TenantStore._apply_version(connection, 1, TenantStore._schema_statements())
        TenantStore._apply_version(connection, 2, TenantStore._schema_v2_statements())
        TenantStore._apply_version(connection, 3, TenantStore._schema_v3_statements())
        TenantStore._apply_version(connection, 4, TenantStore._schema_v4_statements())
        TenantStore._apply_version(connection, 5, TenantStore._schema_v5_statements())
        TenantStore._apply_version(connection, 6, TenantStore._schema_v6_statements())
        TenantStore._apply_version(connection, 7, TenantStore._schema_v7_statements())
        TenantStore._apply_version(connection, 8, TenantStore._schema_v8_statements())
        TenantStore._apply_version(connection, 9, TenantStore._schema_v9_statements())
        from jarvis.history_index import ensure_fts   # 延迟导入：history_index 依赖本模块
        ensure_fts(connection)

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

    def rename_thread(self, alias: str, title: str, *, owner_id: str | None = None) -> TenantThread | None:
        """改标题不改 updated_at：重命名不应打乱「最近对话」排序。"""
        owner = self._owner(owner_id)
        cleaned = " ".join(str(title).split())[:48]
        if not cleaned:
            raise ValueError("thread title is required")
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                row = c.execute("SELECT checkpoint_thread_id,updated_at FROM tenant_threads WHERE owner_id=? AND alias=?", (owner, alias)).fetchone()
                if not row:
                    c.rollback()
                    return None
                c.execute("UPDATE tenant_threads SET title=? WHERE owner_id=? AND alias=?", (cleaned, owner, alias))
                c.commit()
                return TenantThread(alias, cleaned, row["checkpoint_thread_id"], row["updated_at"])
            except Exception:
                c.rollback()
                raise

    def delete_thread(self, alias: str, *, owner_id: str | None = None) -> TenantThread | None:
        owner = self._owner(owner_id)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT alias,title,checkpoint_thread_id,updated_at FROM tenant_threads WHERE owner_id=? AND alias=?", (owner, alias)).fetchone()
            if not row:
                c.rollback()
                return None
            c.execute("DELETE FROM tenant_threads WHERE owner_id=? AND alias=?", (owner, alias))
            try:   # 翻旧账索引随会话一起删；索引坏了（如 SQLite 缺 trigram）也不能挡住删会话
                c.execute("DELETE FROM tenant_message_index WHERE owner_id=? AND alias=?", (owner, alias))
                c.execute("DELETE FROM tenant_message_sync WHERE owner_id=? AND alias=?", (owner, alias))
            except sqlite3.OperationalError:
                pass  # 检索结果另按 tenant_threads 关联过滤，残留行不会被搜出来
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

    def get_pref(self, key: str, default: str | None = None, *, owner_id: str | None = None) -> str | None:
        owner = self._owner(owner_id)
        with self._connect() as c:
            row = c.execute("SELECT value FROM tenant_prefs WHERE owner_id=? AND key=?", (owner, key)).fetchone()
        return row["value"] if row else default

    def set_pref(self, key: str, value: str | None, *, owner_id: str | None = None) -> None:
        """value 为 None 时删除该项（回到默认）。"""
        owner = self._owner(owner_id)
        with self._connect() as c:
            if value is None:
                c.execute("DELETE FROM tenant_prefs WHERE owner_id=? AND key=?", (owner, key))
            else:
                c.execute("INSERT INTO tenant_prefs(owner_id,key,value,updated_at) VALUES(?,?,?,?)"
                          " ON CONFLICT(owner_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                          (owner, key, str(value), _now()))

    def prefs_with_prefix(self, prefix: str, *, owner_id: str | None = None) -> dict[str, str]:
        """某个前缀下的全部偏好（插件设置命名空间 plugin:<id>: 用）；不用 LIKE，免得 _ 被当通配符。"""
        owner = self._owner(owner_id)
        with self._connect() as c:
            rows = c.execute("SELECT key, value FROM tenant_prefs WHERE owner_id=? AND substr(key, 1, ?)=? ORDER BY key",
                             (owner, len(prefix), prefix)).fetchall()
        return {row["key"]: row["value"] for row in rows}

    def add_profile(self, content: str, *, owner_id: str | None = None) -> dict:
        """记一条用户长期画像；内容完全相同的条目不重复入库（幂等）。"""
        owner = self._owner(owner_id)
        cleaned = " ".join(str(content).split())[:200]
        if not cleaned:
            raise ValueError("profile content is required")
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                row = c.execute("SELECT id FROM tenant_profile WHERE owner_id=? AND content=?", (owner, cleaned)).fetchone()
                if row:
                    c.commit()
                    return {"id": row["id"], "content": cleaned, "existed": True}
                item_id = self._next_id(c, "tenant_profile", owner)
                c.execute("INSERT INTO tenant_profile(owner_id,id,content,created_at) VALUES(?,?,?,?)", (owner, item_id, cleaned, _now()))
                c.commit()
                return {"id": item_id, "content": cleaned, "existed": False}
            except Exception:
                c.rollback(); raise

    def list_profile(self, *, owner_id: str | None = None) -> list[dict]:
        owner = self._owner(owner_id)
        with self._connect() as c:
            rows = c.execute("SELECT id,content,created_at FROM tenant_profile WHERE owner_id=? ORDER BY id", (owner,)).fetchall()
        return [{"id": r["id"], "content": r["content"], "created": r["created_at"]} for r in rows]

    def delete_profile(self, item_id: int, *, owner_id: str | None = None) -> bool:
        owner = self._owner(owner_id)
        with self._connect() as c:
            return bool(c.execute("DELETE FROM tenant_profile WHERE owner_id=? AND id=?", (owner, item_id)).rowcount)

    def add_meeting(self, *, title: str, started_at: str, ended_at: str, transcript: str,
                    minutes: str, mailed_to: str = "", owner_id: str | None = None) -> dict:
        owner = self._owner(owner_id)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                item_id = self._next_id(c, "tenant_meetings", owner)
                c.execute("INSERT INTO tenant_meetings(owner_id,id,title,started_at,ended_at,transcript,minutes,mailed_to,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                          (owner, item_id, title, started_at, ended_at, transcript, minutes, mailed_to, _now()))
                c.commit()
            except Exception:
                c.rollback(); raise
        return {"id": item_id, "title": title}

    def list_meetings(self, *, owner_id: str | None = None, limit: int = 20) -> list[dict]:
        """最近的会议（默认 20 场）：网页任务台 30 秒轮询一次，不能无界全量拉。"""
        owner = self._owner(owner_id)
        with self._connect() as c:
            rows = c.execute("SELECT id,title,started_at,ended_at,mailed_to,length(minutes) AS mlen FROM tenant_meetings WHERE owner_id=? ORDER BY id DESC LIMIT ?", (owner, int(limit))).fetchall()
        return [{"id": r["id"], "title": r["title"], "started_at": r["started_at"],
                 "ended_at": r["ended_at"], "mailed_to": r["mailed_to"],
                 "has_minutes": bool(r["mlen"])} for r in rows]

    def get_meeting(self, item_id: int, *, owner_id: str | None = None) -> dict | None:
        owner = self._owner(owner_id)
        with self._connect() as c:
            row = c.execute("SELECT id,title,started_at,ended_at,transcript,minutes,mailed_to FROM tenant_meetings WHERE owner_id=? AND id=?", (owner, item_id)).fetchone()
        return dict(row) if row else None

    def update_meeting_texts(self, item_id: int, *, transcript: str, minutes: str,
                             owner_id: str | None = None) -> bool:
        """说话人改名等会后编辑：整体回写转写与纪要文本。"""
        owner = self._owner(owner_id)
        with self._connect() as c:
            return bool(c.execute(
                "UPDATE tenant_meetings SET transcript=?, minutes=? WHERE owner_id=? AND id=?",
                (transcript, minutes, owner, item_id)).rowcount)

    def mark_meeting_mailed(self, item_id: int, mailed_to: str, *, owner_id: str | None = None) -> bool:
        owner = self._owner(owner_id)
        with self._connect() as c:
            return bool(c.execute("UPDATE tenant_meetings SET mailed_to=? WHERE owner_id=? AND id=?", (mailed_to, owner, item_id)).rowcount)

    def set_todo_done(self, item_id: int, done: bool, *, owner_id: str | None = None) -> bool:
        owner = self._owner(owner_id)
        with self._connect() as c:
            return bool(c.execute("UPDATE tenant_todos SET done=? WHERE owner_id=? AND id=?", (int(bool(done)), owner, item_id)).rowcount)

    def delete_todo(self, item_id: int, *, owner_id: str | None = None) -> bool:
        owner = self._owner(owner_id)
        with self._connect() as c:
            return bool(c.execute("DELETE FROM tenant_todos WHERE owner_id=? AND id=?", (owner, item_id)).rowcount)

    def add_schedule(self, title: str, when: str, *, owner_id: str | None = None, legacy_id: int | None = None) -> dict:
        owner = self._owner(owner_id)
        try:
            when = canonical_when(when)
        except ValueError:
            pass  # 入口已校验；这里只做规范化兜底，不改变既有调用方的容错行为
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

    # tenant_reminders_sent 是提醒的「账本」，一次提醒 = (日程 id, 响铃时刻 at)，不加表：
    # - channel 为 web/desktop/wechat/feishu：该通道已送达过这次提醒；
    # - channel 为 snooze：「稍后」排的一次再响，when_at 即新的响铃时刻（日程本身的时间不动）；
    # - channel 为 ack:done / ack:snooze：这次提醒已在某个通道被「完成」/「稍后」，其他通道不再催。
    def due_reminders(self, *, floor: str, ceiling: str, channel: str, owner_id: str | None = None) -> list[dict]:
        """到点、该通道尚未送达、也没在任何通道处理过的提醒：floor < at <= ceiling（格式固定，字典序即时间序）。

        返回 {id, title, when, at}：when 是日程时间，at 是这次响铃时刻（「稍后」再响时晚于 when）。"""
        owner = self._owner(owner_id)
        with self._connect() as c:
            rows = c.execute(
                "SELECT id, title, when_at, at FROM ("
                "  SELECT s.id, s.title, s.when_at, s.when_at AS at FROM tenant_schedule s"
                "   WHERE s.owner_id=? AND s.when_at>? AND s.when_at<=?"
                "  UNION"
                "  SELECT s.id, s.title, s.when_at, z.when_at AS at FROM tenant_reminders_sent z"
                "   JOIN tenant_schedule s ON s.owner_id=z.owner_id AND s.id=z.schedule_id"
                "   WHERE z.owner_id=? AND z.channel='snooze' AND z.when_at>? AND z.when_at<=?"
                ") d WHERE NOT EXISTS (SELECT 1 FROM tenant_reminders_sent r"
                "   WHERE r.owner_id=? AND r.schedule_id=d.id AND r.when_at=d.at AND (r.channel=? OR r.channel LIKE 'ack:%'))"
                " ORDER BY at, id",
                (owner, floor, ceiling, owner, floor, ceiling, owner, channel)).fetchall()
        return [{"id": r["id"], "title": r["title"], "when": r["when_at"], "at": r["at"]} for r in rows]

    def mark_reminded(self, schedule_id: int, when_at: str, channel: str, *, owner_id: str | None = None) -> None:
        """when_at 传这次提醒的响铃时刻（due_reminders 返回的 at）。"""
        owner = self._owner(owner_id)
        with self._connect() as c:
            c.execute("INSERT OR IGNORE INTO tenant_reminders_sent(owner_id,schedule_id,when_at,channel,sent_at) VALUES(?,?,?,?,?)",
                      (owner, schedule_id, when_at, channel, _now()))
            c.commit()

    def ack_reminder(self, schedule_id: int, at: str, action: str, *, until: str | None = None,
                     owner_id: str | None = None) -> dict:
        """处理一次提醒（action=done|snooze），幂等、先到先得，「完成」压过「稍后」。

        返回 {status: done|snoozed|missing|stale, title, until?, already}：
        - missing：日程已删；stale：at 不是这条日程的任何一次响铃（日程改过期）；
        - 同一次提醒重复「稍后」返回第一次排好的 until，不会越推越晚；
        - 「完成」顺带撤掉还没响的「稍后」，「完成」之后再点「稍后」不生效。"""
        if action not in ("done", "snooze") or (action == "snooze" and not until):
            raise ValueError(action)
        owner = self._owner(owner_id)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                result = self._ack_locked(c, owner, schedule_id, at, action, until)
                c.commit()
            except Exception:
                c.rollback(); raise
        return result

    @staticmethod
    def _ack_locked(c: sqlite3.Connection, owner: str, schedule_id: int, at: str, action: str, until: str | None) -> dict:
        row = c.execute("SELECT title, when_at FROM tenant_schedule WHERE owner_id=? AND id=?", (owner, schedule_id)).fetchone()
        if not row:
            return {"status": "missing", "title": "", "already": False}
        title = row["title"]
        ledger = "SELECT 1 FROM tenant_reminders_sent WHERE owner_id=? AND schedule_id=? AND when_at=? AND channel=?"
        acked = {r["channel"] for r in c.execute(
            "SELECT channel FROM tenant_reminders_sent WHERE owner_id=? AND schedule_id=? AND when_at=? AND channel LIKE 'ack:%'",
            (owner, schedule_id, at))}
        if not acked and at != row["when_at"] and not c.execute(ledger, (owner, schedule_id, at, "snooze")).fetchone():
            return {"status": "stale", "title": title, "already": False}
        insert = "INSERT OR IGNORE INTO tenant_reminders_sent(owner_id,schedule_id,when_at,channel,sent_at) VALUES(?,?,?,?,?)"
        if action == "done" or "ack:done" in acked:
            if "ack:done" not in acked:
                c.execute(insert, (owner, schedule_id, at, "ack:done", _now()))
                c.execute("DELETE FROM tenant_reminders_sent WHERE owner_id=? AND schedule_id=? AND channel='snooze' AND when_at>?",
                          (owner, schedule_id, at))
            return {"status": "done", "title": title, "already": "ack:done" in acked}
        if "ack:snooze" in acked:
            nxt = c.execute("SELECT MIN(when_at) AS w FROM tenant_reminders_sent WHERE owner_id=? AND schedule_id=?"
                            " AND channel='snooze' AND when_at>?", (owner, schedule_id, at)).fetchone()
            return {"status": "snoozed", "title": title, "until": nxt["w"] or "", "already": True}
        c.execute(insert, (owner, schedule_id, at, "ack:snooze", _now()))
        c.execute(insert, (owner, schedule_id, until, "snooze", _now()))
        return {"status": "snoozed", "title": title, "until": until, "already": False}

    def last_reminded(self, channel: str, *, since: str, owner_id: str | None = None) -> dict | None:
        """该通道 since（UTC ISO）之后送达的最近一次提醒 {id, title, when, at}；日程已删则 None。"""
        owner = self._owner(owner_id)
        with self._connect() as c:
            row = c.execute(
                "SELECT r.schedule_id, r.when_at AS at, s.title, s.when_at FROM tenant_reminders_sent r"
                " JOIN tenant_schedule s ON s.owner_id=r.owner_id AND s.id=r.schedule_id"
                " WHERE r.owner_id=? AND r.channel=? AND r.sent_at>=? ORDER BY r.sent_at DESC LIMIT 1",
                (owner, channel, since)).fetchone()
        return {"id": row["schedule_id"], "title": row["title"], "when": row["when_at"], "at": row["at"]} if row else None

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
        temporary = backup.with_name(
            f"{backup.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with temporary.open("xb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            temporary.chmod(0o600)
            try:
                # A hard link publishes a complete file without overwriting a winner
                # from another thread or process.
                os.link(temporary, backup)
            except FileExistsError:
                if backup.read_bytes() != content:
                    raise TenantMigrationError("legacy backup differs")
            backup.chmod(0o600)
        finally:
            temporary.unlink(missing_ok=True)

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
