"""流程与运行记录的存取（表结构在 tenancy.py v6 / v7 / v8）。

- 第十八轮起流程存节点图（``graph`` 列）；``graph`` 为空串的旧行按 ``graph_from_steps(steps)`` 换算后返回，
  不做离线改写；保存一律写 ``graph``、``steps`` 写 ``[]``；
- 运行记录的 ``steps`` 列存 ``{"nodes": [...], "output": {...}, "ms": n}``（旧记录是积木结果数组，读时换算）；
- 触发器（``tenant_flow_triggers``，定时运行由 extras / schedule 读写）：列表只读，删流程时一并删掉；

- 流程按账号隔离：除公开结果页外，所有读写都带 owner_id；
- 每个流程只留最近 KEEP_RUNS 次运行（新运行落库时顺手修剪）；
- 结果页挂在运行记录上，token 全局唯一、PAGE_DAYS 天后失效：过期的在读取时惰性清掉，
  每次开新运行时再顺带扫一遍全库过期页（只清页面字段，运行记录照留）。
- 第二十轮（v8）：运行记录多 ``source``（manual / schedule / chat / message / webhook / rerun / resume），状态多
  waiting（停在「发送前确认」）/ rejected / expired；``input`` 里存 ``values``（文件字段存 ``{file_id, name}``，
  重跑用）；每个节点结果另存 ``ctx``（text ≤ 2 万字、items、links、title…，单节点试跑用），接口视图里去掉；
  停着等确认的运行不参与「只留最近 KEEP_RUNS 次」的修剪；确认记录在 ``tenant_flow_approvals``。
"""
from __future__ import annotations

import datetime as dt
import json
import secrets
import uuid

from jarvis.flows.graph import graph_from_steps
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


RUN_TEXT_CHARS = 20000
_WEEKDAY_NAMES = ("一", "二", "三", "四", "五", "六", "日")
_REPEAT = {"daily": "每天", "weekdays": "每个工作日"}


def trigger_label(config: dict) -> str:
    """定时触发器的人话说明：「每个工作日 08:00」；配置里自带 label 就用它。"""
    if isinstance(config.get("label"), str) and config["label"].strip():
        return config["label"].strip()[:30]
    schedule = config.get("schedule") if isinstance(config.get("schedule"), dict) else {}
    when = str(schedule.get("time") or "").strip()
    repeat = schedule.get("repeat")
    if repeat == "weekly":
        try:
            day = _WEEKDAY_NAMES[int(schedule.get("weekday")) - 1]
        except (TypeError, ValueError, IndexError):
            day = ""
        head = f"每周{day}" if day else "每周"
    else:
        head = _REPEAT.get(repeat, "定时")
    return f"{head} {when}".strip()


def input_summary(info: dict) -> str:
    """运行记录里的「输入了什么」：新记录存了 summary；v6 记录按 kind 换算。"""
    if not isinstance(info, dict):
        return ""
    if isinstance(info.get("summary"), str):
        return info["summary"]
    if info.get("kind") == "file":
        return f"文件「{info.get('name') or '资料'}」"
    if info.get("kind") == "text":
        return f"文字 {int(info.get('chars') or 0)} 字"
    return ""


def _legacy_node(step: dict) -> dict:
    from jarvis.flows.steps import STEPS
    spec = STEPS.get(step.get("plugin"))
    return {"node_id": step.get("step_id") or "", "title": spec.name if spec else (step.get("plugin") or "积木"),
            "node_type": "step", "status": step.get("status") or "ok", "summary": step.get("summary") or "",
            "preview": step.get("preview") or "", "ms": step.get("ms") or 0,
            **({"message": step["message"]} if step.get("message") else {})}


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
        steps = _loads(row["steps"], [])
        graph = _loads(row["graph"], {}) if "graph" in row.keys() else {}
        legacy = not graph
        if legacy:
            graph = graph_from_steps(steps)
        return {"id": row["id"], "name": row["name"], "summary": row["summary"], "graph": graph,
                "steps": steps, "legacy": legacy, "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def list_flows(self, owner_id: str) -> list[dict]:
        with self._connect() as c:
            rows = c.execute("SELECT * FROM tenant_flows WHERE owner_id=? ORDER BY updated_at DESC, id", (owner_id,)).fetchall()
        return [self._flow_row(r) for r in rows]

    def get_flow(self, owner_id: str, flow_id: str) -> dict | None:
        with self._connect() as c:
            row = c.execute("SELECT * FROM tenant_flows WHERE owner_id=? AND id=?", (owner_id, flow_id)).fetchone()
        return self._flow_row(row) if row else None

    @staticmethod
    def _columns(graph: dict | None, steps: list[dict] | None) -> tuple[str, str]:
        """(graph 列, steps 列)：给了节点图就存图、steps 写 []；只给 steps 是旧写法（测试造旧数据用）。"""
        if graph is not None:
            return json.dumps(graph, ensure_ascii=False), "[]"
        return "", json.dumps(steps or [], ensure_ascii=False)

    def create_flow(self, owner_id: str, *, name: str, summary: str, graph: dict | None = None,
                    steps: list[dict] | None = None) -> dict:
        now = _iso(_now())
        flow_id = uuid.uuid4().hex[:12]
        graph_col, steps_col = self._columns(graph, steps)
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                count = c.execute("SELECT COUNT(*) FROM tenant_flows WHERE owner_id=?", (owner_id,)).fetchone()[0]
                if count >= MAX_FLOWS:
                    raise FlowLimitError(MAX_FLOWS)
                c.execute("INSERT INTO tenant_flows(owner_id,id,name,summary,steps,graph,created_at,updated_at)"
                          " VALUES(?,?,?,?,?,?,?,?)",
                          (owner_id, flow_id, name, summary, steps_col, graph_col, now, now))
                c.commit()
            except Exception:
                c.rollback(); raise
        return self.get_flow(owner_id, flow_id)

    def update_flow(self, owner_id: str, flow_id: str, *, name: str, summary: str, graph: dict | None = None,
                    steps: list[dict] | None = None) -> dict | None:
        now = _iso(_now())
        graph_col, steps_col = self._columns(graph, steps)
        with self._connect() as c:
            changed = c.execute("UPDATE tenant_flows SET name=?, summary=?, steps=?, graph=?, updated_at=?"
                                " WHERE owner_id=? AND id=?",
                                (name, summary, steps_col, graph_col, now, owner_id, flow_id)).rowcount
        return self.get_flow(owner_id, flow_id) if changed else None

    def delete_flow(self, owner_id: str, flow_id: str) -> bool:
        """删流程连同它的运行记录与结果页一起删：「删掉」就是真的删掉。"""
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                found = c.execute("DELETE FROM tenant_flows WHERE owner_id=? AND id=?", (owner_id, flow_id)).rowcount
                c.execute("DELETE FROM tenant_flow_runs WHERE owner_id=? AND flow_id=?", (owner_id, flow_id))
                c.execute("DELETE FROM tenant_flow_triggers WHERE owner_id=? AND flow_id=?", (owner_id, flow_id))
                c.execute("DELETE FROM tenant_flow_approvals WHERE owner_id=? AND flow_id=?", (owner_id, flow_id))
                c.commit()
            except Exception:
                c.rollback(); raise
        return bool(found)

    # ---- 触发器（只读；写在 extras / schedule） ----

    @staticmethod
    def _trigger_view(row) -> dict | None:
        """定时触发器的卡片视图。用户自己关掉的定时存成 manual，不显示；连续失败被自动暂停的仍是
        schedule、enabled=0，照样返回（带 paused_reason），卡片据此显示「定时已暂停」。"""
        if row is None or row["kind"] != "schedule":
            return None
        config = _loads(row["config"], {})
        if not row["enabled"] and not config.get("paused_reason"):   # 关着但不是被自动暂停的：等同手动
            return None
        return {"kind": row["kind"], "enabled": bool(row["enabled"]), "label": trigger_label(config),
                "next_run_at": row["next_run_at"] if row["enabled"] else None,
                "last_run_at": row["last_run_at"], "last_status": row["last_status"] or "",
                "paused_reason": "" if row["enabled"] else str(config.get("paused_reason") or "")}

    def triggers(self, owner_id: str) -> dict[str, dict]:
        """{flow_id: {kind, enabled, label, next_run_at, last_run_at, last_status, paused_reason}}：启用中与被自动暂停的定时触发器。"""
        with self._connect() as c:
            rows = c.execute("SELECT * FROM tenant_flow_triggers WHERE owner_id=?", (owner_id,)).fetchall()
        out = {}
        for row in rows:
            view = self._trigger_view(row)
            if view is not None:
                out[row["flow_id"]] = view
        return out

    def trigger(self, owner_id: str, flow_id: str) -> dict | None:
        with self._connect() as c:
            row = c.execute("SELECT * FROM tenant_flow_triggers WHERE owner_id=? AND flow_id=?",
                            (owner_id, flow_id)).fetchone()
        return self._trigger_view(row)

    # ---- 运行记录 ----

    def start_run(self, owner_id: str, flow_id: str, input_info: dict, *, source: str = "manual") -> str:
        run_id = uuid.uuid4().hex[:16]
        now = _now()
        with self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                c.execute("INSERT INTO tenant_flow_runs(id,owner_id,flow_id,status,input,started_at,source)"
                          " VALUES(?,?,?,?,?,?,?)",
                          (run_id, owner_id, flow_id, "running", json.dumps(input_info, ensure_ascii=False), _iso(now),
                           source or "manual"))
                # 只留最近 KEEP_RUNS 次（含刚开的这次）；停着等确认的不删（确认后还要接着跑）
                c.execute("DELETE FROM tenant_flow_runs WHERE owner_id=? AND flow_id=? AND status!='waiting' AND id NOT IN ("
                          " SELECT id FROM tenant_flow_runs WHERE owner_id=? AND flow_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?)",
                          (owner_id, flow_id, owner_id, flow_id, KEEP_RUNS))
                self._purge_pages(c, now)
                c.commit()
            except Exception:
                c.rollback(); raise
        return run_id

    def finish_run(self, owner_id: str, run_id: str, *, status: str, steps: list[dict] | None = None,
                   error: str = "", nodes: list[dict] | None = None, output: dict | None = None,
                   ms: int | None = None, input_info: dict | None = None, source: str | None = None,
                   extra: dict | None = None) -> None:
        """回写一次运行：状态、逐节点结果（``nodes``）、输出、耗时。waiting / running（确认后接着跑）不写结束时间；
        给了 ``input_info`` / ``source`` 就一并改（开始节点存好原文件后补上 file_id；接着跑记 resume）。"""
        detail = {"nodes": nodes, "output": output, "ms": ms, **(extra or {})} if nodes is not None else (steps or [])
        finished = None if status in ("waiting", "running") else _iso(_now())
        sets = ["status=?", "steps=?", "error=?", "finished_at=?"]
        args: list = [status, json.dumps(detail, ensure_ascii=False, default=str), error[:200], finished]
        if input_info is not None:
            sets.append("input=?")
            args.append(json.dumps(input_info, ensure_ascii=False))
        if source:
            sets.append("source=?")
            args.append(source)
        with self._connect() as c:
            c.execute(f"UPDATE tenant_flow_runs SET {', '.join(sets)} WHERE owner_id=? AND id=?",
                      (*args, owner_id, run_id))

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

    @staticmethod
    def _detail(row) -> dict | list | None:
        return _loads(row["steps"], {}) if (row["steps"] or "").lstrip().startswith("{") else None

    @classmethod
    def _run_view(cls, row, approval: dict | None = None) -> dict:
        status = row["status"]
        error = row["error"] or None
        detail = cls._detail(row)
        if status == "running":
            try:   # 确认后接着跑的那段从 resumed_at 算
                began = detail.get("resumed_at") if isinstance(detail, dict) else None
                started = dt.datetime.fromisoformat(began or row["started_at"])
                if (_now() - started).total_seconds() > STALE_RUN_SECONDS:
                    status, error = "error", "运行中断了"
            except (TypeError, ValueError):
                pass
        url = cls._page_url(row)
        if isinstance(detail, dict):
            nodes = [{k: v for k, v in n.items() if k != "ctx"} for n in detail.get("nodes") or []
                     if isinstance(n, dict)]
            output = detail.get("output") if isinstance(detail.get("output"), dict) else {}
            ms = detail.get("ms")
        else:   # v6 的积木结果数组
            nodes = [_legacy_node(s) for s in _loads(row["steps"], []) if isinstance(s, dict)]
            output, ms = {}, None
        if ms is None and row["finished_at"]:
            try:
                ms = int((dt.datetime.fromisoformat(row["finished_at"])
                          - dt.datetime.fromisoformat(row["started_at"])).total_seconds() * 1000)
            except ValueError:
                ms = None
        info = _loads(row["input"], {})
        view = {"id": row["id"], "flow_id": row["flow_id"], "status": status,
                "started_at": row["started_at"], "finished_at": row["finished_at"], "ms": ms,
                "input_summary": input_summary(info), "nodes": nodes,
                "output_text": str(output.get("text") or "")[:RUN_TEXT_CHARS],
                "links": [x for x in output.get("links") or [] if isinstance(x, dict)],
                "page_url": url, "error": error,
                "source": (row["source"] if "source" in row.keys() else "") or "manual",
                "rerunnable": isinstance(info.get("values"), dict)}
        if status == "waiting":
            view["approval"] = approval
        return view

    @staticmethod
    def _approvals_for(c, owner_id: str, rows) -> dict[str, dict]:
        """停着等确认的运行 → 它的待确认 {id, url, expires_at}（url 是站内路径）。"""
        waiting = [r["id"] for r in rows if r["status"] == "waiting"]
        if not waiting:
            return {}
        marks = ",".join("?" * len(waiting))
        found = c.execute("SELECT id, run_id, expires_at FROM tenant_flow_approvals WHERE owner_id=? AND status='pending'"
                          f" AND run_id IN ({marks})", (owner_id, *waiting)).fetchall()
        return {r["run_id"]: {"id": r["id"], "url": f"/approve/{r['id']}", "expires_at": r["expires_at"]} for r in found}

    def list_runs(self, owner_id: str, flow_id: str, limit: int = 10) -> list[dict]:
        with self._connect() as c:
            rows = c.execute("SELECT * FROM tenant_flow_runs WHERE owner_id=? AND flow_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?",
                             (owner_id, flow_id, max(1, min(int(limit), KEEP_RUNS)))).fetchall()
            approvals = self._approvals_for(c, owner_id, rows)
        return [self._run_view(r, approvals.get(r["id"])) for r in rows]

    def get_run(self, owner_id: str, flow_id: str, run_id: str) -> dict | None:
        """单次运行详情（与列表项同结构）。"""
        with self._connect() as c:
            row = c.execute("SELECT * FROM tenant_flow_runs WHERE owner_id=? AND flow_id=? AND id=?",
                            (owner_id, flow_id, run_id)).fetchone()
            if row is None:
                return None
            approvals = self._approvals_for(c, owner_id, [row])
        return self._run_view(row, approvals.get(row["id"]))

    def run_record(self, owner_id: str, run_id: str) -> dict | None:
        """运行记录原样（重跑、确认后接着跑用）：input / detail 已解析，节点结果带 ctx。"""
        with self._connect() as c:
            row = c.execute("SELECT * FROM tenant_flow_runs WHERE owner_id=? AND id=?", (owner_id, run_id)).fetchone()
        if row is None:
            return None
        detail = self._detail(row)
        return {"id": row["id"], "flow_id": row["flow_id"], "status": row["status"], "source": row["source"],
                "input": _loads(row["input"], {}), "detail": detail if isinstance(detail, dict) else {},
                "started_at": row["started_at"], "finished_at": row["finished_at"], "error": row["error"] or ""}

    def node_outputs(self, owner_id: str, flow_id: str) -> dict[str, dict]:
        """单节点试跑用：每个节点最近一次跑成功时存下的产出 ``{node_id: {ctx, config_hash, run_id}}``（新的优先）。"""
        with self._connect() as c:
            rows = c.execute("SELECT id, steps FROM tenant_flow_runs WHERE owner_id=? AND flow_id=?"
                             " ORDER BY started_at DESC, rowid DESC LIMIT ?", (owner_id, flow_id, KEEP_RUNS)).fetchall()
        out: dict[str, dict] = {}
        for row in rows:
            detail = self._detail(row)
            if not isinstance(detail, dict):
                continue
            for node in detail.get("nodes") or []:
                if not isinstance(node, dict) or node.get("status") != "ok" or not isinstance(node.get("ctx"), dict):
                    continue
                out.setdefault(str(node.get("node_id") or ""), {"ctx": node["ctx"], "run_id": row["id"],
                                                                 "config_hash": node.get("config_hash")})
        return out

    def last_runs(self, owner_id: str) -> dict[str, dict]:
        """每个流程最近一次运行（列表的 last_run）：{flow_id: {id, status, started_at, finished_at, page_url}}；
        停着等确认的另带 ``approval: {id, url, expires_at}``。"""
        with self._connect() as c:
            rows = c.execute("SELECT r.* FROM tenant_flow_runs r WHERE r.owner_id=? AND r.rowid=("
                             " SELECT x.rowid FROM tenant_flow_runs x WHERE x.owner_id=r.owner_id AND x.flow_id=r.flow_id"
                             " ORDER BY x.started_at DESC, x.rowid DESC LIMIT 1)", (owner_id,)).fetchall()
            approvals = self._approvals_for(c, owner_id, rows)
        out = {}
        for row in rows:
            view = self._run_view(row, approvals.get(row["id"]))
            out[row["flow_id"]] = {"id": view["id"], "status": view["status"], "started_at": view["started_at"],
                                   "finished_at": view["finished_at"], "page_url": view["page_url"]}
            if view["status"] == "waiting":
                out[row["flow_id"]]["approval"] = view.get("approval")
        return out

    # ---- 发送前确认（第二十轮，tenant_flow_approvals） ----

    _APPROVAL_SELECT = ("SELECT a.*, f.name AS flow_name FROM tenant_flow_approvals a LEFT JOIN tenant_flows f"
                        " ON f.owner_id=a.owner_id AND f.id=a.flow_id")

    @staticmethod
    def _approval_row(row, *, with_state: bool = False) -> dict:
        out = {"id": row["id"], "owner_id": row["owner_id"], "flow_id": row["flow_id"], "run_id": row["run_id"],
               "node_id": row["node_id"], "status": row["status"], "title": row["title"],
               "payload": _loads(row["payload"], {}), "note": row["note"] or "", "created_at": row["created_at"],
               "expires_at": row["expires_at"], "decided_at": row["decided_at"],
               "flow_name": row["flow_name"] if "flow_name" in row.keys() else None}
        if with_state:
            out["state"] = _loads(row["state"], {})
        return out

    def create_approval(self, owner_id: str, *, flow_id: str, run_id: str, node_id: str, title: str, payload: dict,
                        state: dict, expires_at: str) -> dict:
        approval_id = uuid.uuid4().hex
        with self._connect() as c:
            c.execute("INSERT INTO tenant_flow_approvals(id, owner_id, flow_id, run_id, node_id, status, title, payload,"
                      " state, created_at, expires_at) VALUES(?,?,?,?,?,'pending',?,?,?,?,?)",
                      (approval_id, owner_id, flow_id, run_id, node_id, title[:60],
                       json.dumps(payload, ensure_ascii=False), json.dumps(state, ensure_ascii=False, default=str),
                       _iso(_now()), expires_at))
        return self.get_approval(owner_id, approval_id)

    def get_approval(self, owner_id: str, approval_id: str, *, with_state: bool = False) -> dict | None:
        with self._connect() as c:
            row = c.execute(self._APPROVAL_SELECT + " WHERE a.owner_id=? AND a.id=?", (owner_id, approval_id)).fetchone()
        return self._approval_row(row, with_state=with_state) if row else None

    def list_approvals(self, owner_id: str, *, status: str | None = "pending", limit: int = 20) -> list[dict]:
        sql, args = self._APPROVAL_SELECT + " WHERE a.owner_id=?", [owner_id]
        if status:
            sql += " AND a.status=?"
            args.append(status)
        sql += " ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?"
        args.append(max(1, min(int(limit), 100)))
        with self._connect() as c:
            rows = c.execute(sql, args).fetchall()
        return [self._approval_row(r) for r in rows]

    def pending_approvals(self, owner_id: str) -> int:
        with self._connect() as c:
            return int(c.execute("SELECT COUNT(*) FROM tenant_flow_approvals WHERE owner_id=? AND status='pending'",
                                 (owner_id,)).fetchone()[0])

    def decide_approval(self, owner_id: str, approval_id: str, *, status: str, note: str = "",
                        payload: dict | None = None) -> bool:
        """pending → approved / rejected / expired：只有还在 pending 的才改得动（并发点两次只有一次生效）。"""
        sets = ["status=?", "note=?", "decided_at=?"]
        args: list = [status, note[:200], _iso(_now())]
        if payload is not None:
            sets.append("payload=?")
            args.append(json.dumps(payload, ensure_ascii=False))
        with self._connect() as c:
            changed = c.execute(f"UPDATE tenant_flow_approvals SET {', '.join(sets)}"
                                " WHERE owner_id=? AND id=? AND status='pending'", (*args, owner_id, approval_id)).rowcount
        return bool(changed)

    def due_approvals(self, now_iso: str, owner_id: str | None = None) -> list[dict]:
        """到期还没人处理的确认（跨账号，或只看一个账号）。"""
        sql = self._APPROVAL_SELECT + " WHERE a.status='pending' AND a.expires_at<=?"
        args: list = [now_iso]
        if owner_id is not None:
            sql += " AND a.owner_id=?"
            args.append(owner_id)
        with self._connect() as c:
            rows = c.execute(sql + " ORDER BY a.expires_at LIMIT 200", args).fetchall()
        return [self._approval_row(r) for r in rows]

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
