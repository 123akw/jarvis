"""流程与运行记录的存取（表结构在 tenancy.py v6）。

- 流程按账号隔离：除公开结果页外，所有读写都带 owner_id；
- 每个流程只留最近 KEEP_RUNS 次运行（新运行落库时顺手修剪）；
- 结果页挂在运行记录上，token 全局唯一、PAGE_DAYS 天后失效：过期的在读取时惰性清掉，
  每次开新运行时再顺带扫一遍全库过期页（只清页面字段，运行记录照留）。
"""
from __future__ import annotations

import datetime as dt
import json
import secrets
import uuid

from jarvis.tenancy import TenantStore

KEEP_RUNS = 20
PAGE_DAYS = 30
MAX_FLOWS = 50
STALE_RUN_SECONDS = 10 * 60   # 进程重启会留下 running 的运行记录：超过这么久仍未结束按中断展示


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(value: dt.datetime) -> str:
    return value.isoformat(timespec="seconds")


def _loads(raw, default):
    try:
        value = json.loads(raw) if raw else default
    except ValueError:
        return default
    return value if isinstance(value, type(default)) else default


class FlowLimitError(RuntimeError):
    """单个账号的流程数到上限。"""


class FlowStore:
    """薄封装：连接与迁移复用 TenantStore（同一个 accounts.sqlite3）。"""

    def __init__(self, tenant_store: TenantStore | None = None) -> None:
        self.tenant = tenant_store or TenantStore()

    def _connect(self):
        return self.tenant._connect()

    # ---- 流程 ----

    @staticmethod
    def _flow_row(row) -> dict:
        return {"id": row["id"], "name": row["name"], "summary": row["summary"],
                "steps": _loads(row["steps"], []), "created_at": row["created_at"],
                "updated_at": row["updated_at"]}

    def list_flows(self, owner_id: str) -> list[dict]:
        with self._connect() as c:
            rows = c.execute("SELECT * FROM tenant_flows WHERE owner_id=? ORDER BY updated_at DESC, id", (owner_id,)).fetchall()
        return [self._flow_row(r) for r in rows]

    def get_flow(self, owner_id: str, flow_id: str) -> dict | None:
        with self._connect() as c:
            row = c.execute("SELECT * FROM tenant_flows WHERE owner_id=? AND id=?", (owner_id, flow_id)).fetchone()
        return self._flow_row(row) if row else None

    def create_flow(self, owner_id: str, *, name: str, summary: str, steps: list[dict]) -> dict:
        now = _iso(_now())
        flow_id = uuid.uuid4().hex[:12]
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                count = c.execute("SELECT COUNT(*) FROM tenant_flows WHERE owner_id=?", (owner_id,)).fetchone()[0]
                if count >= MAX_FLOWS:
                    raise FlowLimitError(MAX_FLOWS)
                c.execute("INSERT INTO tenant_flows(owner_id,id,name,summary,steps,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                          (owner_id, flow_id, name, summary, json.dumps(steps, ensure_ascii=False), now, now))
                c.commit()
            except Exception:
                c.rollback(); raise
        return {"id": flow_id, "name": name, "summary": summary, "steps": steps, "created_at": now, "updated_at": now}

    def update_flow(self, owner_id: str, flow_id: str, *, name: str, summary: str, steps: list[dict]) -> dict | None:
        now = _iso(_now())
        with self._connect() as c:
            changed = c.execute("UPDATE tenant_flows SET name=?, summary=?, steps=?, updated_at=? WHERE owner_id=? AND id=?",
                                (name, summary, json.dumps(steps, ensure_ascii=False), now, owner_id, flow_id)).rowcount
        return self.get_flow(owner_id, flow_id) if changed else None

    def delete_flow(self, owner_id: str, flow_id: str) -> bool:
        """删流程连同它的运行记录与结果页一起删：「删掉」就是真的删掉。"""
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                found = c.execute("DELETE FROM tenant_flows WHERE owner_id=? AND id=?", (owner_id, flow_id)).rowcount
                c.execute("DELETE FROM tenant_flow_runs WHERE owner_id=? AND flow_id=?", (owner_id, flow_id))
                c.commit()
            except Exception:
                c.rollback(); raise
        return bool(found)

    # ---- 运行记录 ----

    def start_run(self, owner_id: str, flow_id: str, input_info: dict) -> str:
        run_id = uuid.uuid4().hex[:16]
        now = _now()
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                c.execute("INSERT INTO tenant_flow_runs(id,owner_id,flow_id,status,input,started_at) VALUES(?,?,?,?,?,?)",
                          (run_id, owner_id, flow_id, "running", json.dumps(input_info, ensure_ascii=False), _iso(now)))
                # 只留最近 KEEP_RUNS 次（含刚开的这次）
                c.execute("DELETE FROM tenant_flow_runs WHERE owner_id=? AND flow_id=? AND id NOT IN ("
                          " SELECT id FROM tenant_flow_runs WHERE owner_id=? AND flow_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?)",
                          (owner_id, flow_id, owner_id, flow_id, KEEP_RUNS))
                self._purge_pages(c, now)
                c.commit()
            except Exception:
                c.rollback(); raise
        return run_id

    def finish_run(self, owner_id: str, run_id: str, *, status: str, steps: list[dict], error: str = "") -> None:
        with self._connect() as c:
            c.execute("UPDATE tenant_flow_runs SET status=?, steps=?, error=?, finished_at=? WHERE owner_id=? AND id=?",
                      (status, json.dumps(steps, ensure_ascii=False), error[:200], _iso(_now()), owner_id, run_id))

    def attach_page(self, owner_id: str, run_id: str, *, title: str, text: str, links: list[dict]) -> str:
        """给这次运行生成公开结果页，返回 token（secrets.token_urlsafe，约 128 位熵）。"""
        token = secrets.token_urlsafe(16)
        expires = _iso(_now() + dt.timedelta(days=PAGE_DAYS))
        with self._connect() as c:
            changed = c.execute("UPDATE tenant_flow_runs SET page_token=?, page_title=?, page_text=?, page_links=?, page_expires_at=?"
                                " WHERE owner_id=? AND id=?",
                                (token, title, text, json.dumps(links, ensure_ascii=False), expires, owner_id, run_id)).rowcount
        if not changed:
            raise LookupError("run not found")
        return token

    @staticmethod
    def _purge_pages(c, now: dt.datetime) -> None:
        c.execute("UPDATE tenant_flow_runs SET page_token=NULL, page_title=NULL, page_text=NULL, page_links=NULL, page_expires_at=NULL"
                  " WHERE page_expires_at IS NOT NULL AND page_expires_at<=?", (_iso(now),))

    @staticmethod
    def _page_url(row) -> str | None:
        if not row["page_token"] or not row["page_expires_at"] or row["page_expires_at"] <= _iso(_now()):
            return None
        return f"/r/{row['page_token']}"

    @classmethod
    def _run_view(cls, row) -> dict:
        status = row["status"]
        error = row["error"] or None
        if status == "running":
            try:
                started = dt.datetime.fromisoformat(row["started_at"])
                if (_now() - started).total_seconds() > STALE_RUN_SECONDS:
                    status, error = "error", "运行中断了"
            except ValueError:
                pass
        url = cls._page_url(row)
        return {"id": row["id"], "flow_id": row["flow_id"], "status": status,
                "started_at": row["started_at"], "finished_at": row["finished_at"],
                "input": _loads(row["input"], {}), "steps": _loads(row["steps"], []), "error": error,
                "output": {"url": url, "title": row["page_title"] or ""} if url else None}

    def list_runs(self, owner_id: str, flow_id: str, limit: int = 10) -> list[dict]:
        with self._connect() as c:
            rows = c.execute("SELECT * FROM tenant_flow_runs WHERE owner_id=? AND flow_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?",
                             (owner_id, flow_id, max(1, min(int(limit), KEEP_RUNS)))).fetchall()
        return [self._run_view(r) for r in rows]

    def last_runs(self, owner_id: str) -> dict[str, dict]:
        """每个流程最近一次运行（Flow.last_run 用）：{flow_id: {id,status,finished_at,url}}。"""
        with self._connect() as c:
            rows = c.execute("SELECT r.* FROM tenant_flow_runs r WHERE r.owner_id=? AND r.rowid=("
                             " SELECT x.rowid FROM tenant_flow_runs x WHERE x.owner_id=r.owner_id AND x.flow_id=r.flow_id"
                             " ORDER BY x.started_at DESC, x.rowid DESC LIMIT 1)", (owner_id,)).fetchall()
        out = {}
        for row in rows:
            view = self._run_view(row)
            out[row["flow_id"]] = {"id": view["id"], "status": view["status"], "finished_at": view["finished_at"],
                                   "url": view["output"]["url"] if view["output"] else None}
        return out

    # ---- 公开结果页（不带租户：按 token 反查） ----

    def get_page(self, token: str) -> dict | None:
        if not isinstance(token, str) or not 8 <= len(token) <= 64:
            return None
        now = _now()
        with self._connect() as c:
            row = c.execute("SELECT owner_id, page_token, page_title, page_text, page_links, page_expires_at, finished_at, started_at"
                            " FROM tenant_flow_runs WHERE page_token=?", (token,)).fetchone()
            if not row:
                return None
            if not row["page_expires_at"] or row["page_expires_at"] <= _iso(now):
                self._purge_pages(c, now)   # 惰性清理：过期页第一次被访问时顺手清掉
                return None
        return {"owner_id": row["owner_id"], "token": row["page_token"], "title": row["page_title"] or "",
                "text": row["page_text"] or "", "links": _loads(row["page_links"], []),
                "created_at": row["finished_at"] or row["started_at"], "expires_at": row["page_expires_at"]}
