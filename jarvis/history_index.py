"""翻旧账（F10）：跨会话全文检索历史消息。

对话本体在 LangGraph checkpoint（jarvis.db）里，按线程整份存消息列表，没法跨线程检索；
这里在 accounts.sqlite3 存一份检索用的文本副本 tenant_message_index（schema v4），
外加 FTS5 trigram 索引（中文不用分词，任意 ≥3 字子串可命中）。

- 写入：网页 /api/chat 每轮答完立即同步本线程；微信/飞书/语音/OpenAI 兼容等其它入口
  由检索前的「脏线程补同步」兜底（tenant_message_sync 记每个线程同步到的 updated_at）。
- 回填：存量历史惰性回填——启动后后台线程慢慢补，检索时也先花一小段预算补最近的线程，
  不阻塞启动。
- 同步是「镜像」：以 checkpoint 为准，新消息插入、已不存在的消息删掉（重答/摘除可传导）。
- 删除：删会话时在同一事务里删掉索引（tenancy.delete_thread）；删用户走外键级联。
- 检索：≥3 字的词走 FTS MATCH；短于 3 字（中文常见的两字词）trigram 匹配不到，
  退回 LIKE（只扫本人的行）；SQLite 不支持 trigram 时全部走 LIKE。结果再与
  tenant_threads 关联，只返回仍存在的会话。
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import re
import sqlite3
import threading
import time
from typing import Callable, Iterable

from jarvis.periodic import warn_throttled
from jarvis.tenancy import TenantStore, current_owner_id

log = logging.getLogger(__name__)

MAX_INDEX_CHARS = 8000        # 单条消息入索引的上限（上传文档、会议转写可能几万字）
SETTLE_SECONDS = 600          # 线程 updated_at 之后这么久内同步的结果视为「本轮可能还没答完」
MAX_QUERY_CHARS = 100
MAX_TERMS = 6
_FTS = "tenant_message_fts"

# 由 server 注入：loader(owner_id) 是上下文管理器，产出 read(checkpoint_thread_id) -> 消息列表
_loader: Callable | None = None
_skip_aliases: frozenset[str] = frozenset()


def configure(loader, skip_aliases: Iterable[str] = ()) -> None:
    """注册 checkpoint 读取方式与不入索引的服务线程别名（server 启动时调用一次）。"""
    global _loader, _skip_aliases
    _loader = loader
    _skip_aliases = frozenset(skip_aliases)


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _parse(value: str) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


# ---------- 结构：FTS5 trigram 派生索引（幂等，不占版本号） ----------

def trigram_supported() -> bool:
    """当前 SQLite 是否带 FTS5 + trigram 分词器（3.34+）。"""
    probe = sqlite3.connect(":memory:")
    try:
        probe.execute("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')")
        return True
    except sqlite3.Error:
        return False
    finally:
        probe.close()


def ensure_fts(connection: sqlite3.Connection) -> None:
    """建 FTS 表与同步触发器；新建时把已有副本一次性灌进去。由 TenantStore._migrate 调用。"""
    has_base = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tenant_message_index'").fetchone()
    if not has_base:
        return
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (_FTS,)).fetchone()
    if not exists and not trigram_supported():
        warn_throttled("history-fts-missing", "SQLite 不支持 FTS5 trigram，翻旧账检索退回 LIKE 扫描")
        return
    connection.execute("BEGIN IMMEDIATE")
    try:
        if not exists:
            connection.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS {_FTS} USING fts5(content, "
                "content='tenant_message_index', content_rowid='id', tokenize='trigram')")
        connection.execute(
            f"CREATE TRIGGER IF NOT EXISTS tenant_message_index_ai AFTER INSERT ON tenant_message_index BEGIN "
            f"INSERT INTO {_FTS}(rowid, content) VALUES (new.id, new.content); END")
        connection.execute(
            f"CREATE TRIGGER IF NOT EXISTS tenant_message_index_ad AFTER DELETE ON tenant_message_index BEGIN "
            f"INSERT INTO {_FTS}({_FTS}, rowid, content) VALUES ('delete', old.id, old.content); END")
        connection.execute(
            f"CREATE TRIGGER IF NOT EXISTS tenant_message_index_au AFTER UPDATE OF content ON tenant_message_index BEGIN "
            f"INSERT INTO {_FTS}({_FTS}, rowid, content) VALUES ('delete', old.id, old.content); "
            f"INSERT INTO {_FTS}(rowid, content) VALUES (new.id, new.content); END")
        if not exists:
            connection.execute(f"INSERT INTO {_FTS}({_FTS}) VALUES ('rebuild')")
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def _fts_ready(connection: sqlite3.Connection) -> bool:
    return bool(connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (_FTS,)).fetchone())


# ---------- checkpoint 消息 → 检索副本 ----------

def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def thread_messages(messages) -> list[tuple[str, int, str, str]]:
    """(msg_key, pos, role, content)。pos 与 /api/history 返回列表的下标一致（网页据此定位）：
    用户消息全部计入，AI 消息只计有正文的；工具消息不计。空正文不入索引但占位。"""
    out: list[tuple[str, int, str, str]] = []
    pos = 0
    for index, message in enumerate(messages or []):
        kind = getattr(message, "type", "")
        if kind not in ("human", "ai"):
            continue
        text = _text(getattr(message, "content", ""))
        if kind == "ai" and not text.strip():
            continue
        if text.strip():
            key = getattr(message, "id", None) or (
                f"pos{index}:" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:16])
            out.append((str(key), pos, "user" if kind == "human" else "assistant", text[:MAX_INDEX_CHARS]))
        pos += 1
    return out


# ---------- 查询词与片段 ----------

def query_terms(query: str) -> list[str]:
    """按空白切词，去重保序；整体限长，词数封顶。"""
    terms: list[str] = []
    for part in str(query or "")[:MAX_QUERY_CHARS].split():
        part = part.strip()
        if part and part.lower() not in (t.lower() for t in terms):
            terms.append(part)
    return terms[:MAX_TERMS]


def _fold(text: str) -> str:
    """逐字小写且保证长度不变（个别字符 lower() 会变长，偏移会错位）。"""
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in text)


_MD_NOISE = re.compile(r"(\*\*|__|`+|^#+\s*|^>\s*)", re.M)


def snippet(content: str, terms: list[str], *, before: int = 16, width: int = 64) -> tuple[str, list[list[int]]]:
    """取第一个命中词附近的一段（压掉换行与 Markdown 记号），返回 (片段, 高亮区间)。"""
    text = " ".join(_MD_NOISE.sub("", content).split())
    low = _fold(text)
    folded = [_fold(t) for t in terms if t]
    hits = [i for i in (low.find(t) for t in folded) if i >= 0]
    first = min(hits) if hits else 0
    start = max(0, first - before)
    end = min(len(text), start + width)
    if end - start < width:                    # 末尾不够长就往前补，片段尽量满
        start = max(0, end - width)
    head = "…" if start > 0 else ""
    tail = "…" if end < len(text) else ""
    body = text[start:end]
    body_low = low[start:end]
    spans: list[list[int]] = []
    for term in folded:
        at = body_low.find(term)
        while at >= 0:
            spans.append([at + len(head), at + len(head) + len(term)])
            at = body_low.find(term, at + len(term))
    spans.sort()
    merged: list[list[int]] = []
    for span in spans:
        if merged and span[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], span[1])
        else:
            merged.append(span)
    return head + body + tail, merged


def _like(term: str) -> str:
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _phrase(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


# ---------- 存储 ----------

class HistoryIndex:
    """检索副本的读写；与 TenantStore 共用 accounts.sqlite3 与迁移。"""

    def __init__(self, store: TenantStore | None = None) -> None:
        self.store = store or TenantStore()

    @staticmethod
    def _owner(owner_id: str | None) -> str:
        return owner_id if owner_id is not None else current_owner_id()

    def index_thread(self, alias: str, messages: list[tuple[str, int, str, str]], *,
                     thread_updated_at: str, owner_id: str | None = None, settled: bool | None = None) -> int:
        """把一个线程的检索副本镜像成 messages（新增插入、消失删除、位置变化更新），返回新增条数。

        新消息的时间取线程的 updated_at（即这一轮开始的时间）。settled=None 时按
        「updated_at 之后是否已过 SETTLE_SECONDS」推断这轮是否已答完；网页每轮答完同步时传 True。"""
        owner = self._owner(owner_id)
        now = _now()
        if settled is None:
            began = _parse(thread_updated_at)
            settled = began is None or (dt.datetime.now(dt.timezone.utc) - began).total_seconds() >= SETTLE_SECONDS
        added = 0
        with self.store._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                # 会话已被删：不再写副本（防止删除与同步交错时把索引写回来）
                if not c.execute("SELECT 1 FROM tenant_threads WHERE owner_id=? AND alias=?", (owner, alias)).fetchone():
                    c.rollback()
                    return 0
                existing = {r["msg_key"]: (r["id"], r["pos"]) for r in c.execute(
                    "SELECT id, msg_key, pos FROM tenant_message_index WHERE owner_id=? AND alias=?", (owner, alias))}
                wanted = {key for key, *_ in messages}
                for key, (row_id, _pos) in existing.items():
                    if key not in wanted:
                        c.execute("DELETE FROM tenant_message_index WHERE id=?", (row_id,))
                for key, pos, role, content in messages:
                    if key in existing:
                        if existing[key][1] != pos:
                            c.execute("UPDATE tenant_message_index SET pos=? WHERE id=?", (pos, existing[key][0]))
                        continue
                    c.execute(
                        "INSERT INTO tenant_message_index(owner_id,alias,msg_key,pos,role,content,created_at) "
                        "VALUES(?,?,?,?,?,?,?)", (owner, alias, key, pos, role, content, thread_updated_at))
                    added += 1
                c.execute(
                    "INSERT INTO tenant_message_sync(owner_id,alias,thread_updated_at,synced_at,settled) VALUES(?,?,?,?,?)"
                    " ON CONFLICT(owner_id,alias) DO UPDATE SET thread_updated_at=excluded.thread_updated_at,"
                    " synced_at=excluded.synced_at, settled=excluded.settled",
                    (owner, alias, thread_updated_at, now, int(bool(settled))))
                c.commit()
            except Exception:
                c.rollback()
                raise
        return added

    def pending_threads(self, *, owner_id: str | None = None, skip: Iterable[str] = ()) -> list[dict]:
        """需要（重新）同步的线程，最近活跃的在前：没同步过、之后又有新一轮、或同步时这轮可能没答完。"""
        owner = self._owner(owner_id)
        skipped = set(skip)
        with self.store._connect() as c:
            rows = c.execute(
                "SELECT t.alias, t.checkpoint_thread_id, t.updated_at, s.thread_updated_at, s.settled "
                "FROM tenant_threads t LEFT JOIN tenant_message_sync s ON s.owner_id=t.owner_id AND s.alias=t.alias "
                "WHERE t.owner_id=? ORDER BY t.updated_at DESC", (owner,)).fetchall()
        return [
            {"alias": r["alias"], "checkpoint": r["checkpoint_thread_id"], "updated": r["updated_at"]}
            for r in rows
            if r["alias"] not in skipped
            and (r["thread_updated_at"] is None or r["thread_updated_at"] != r["updated_at"] or not r["settled"])
        ]

    def search(self, query: str, *, owner_id: str | None = None, limit: int = 8, per_thread: int = 2,
               match_all: bool = True, exclude_alias: str | None = None) -> list[dict]:
        """全文检索本人的历史消息，按时间从新到旧；每个会话最多 per_thread 条。"""
        owner = self._owner(owner_id)
        terms = query_terms(query)
        if not terms:
            return []
        limit = max(1, min(int(limit), 50))
        with self.store._connect() as c:
            try:
                rows = self._query(c, owner, terms, limit, match_all, exclude_alias, use_fts=_fts_ready(c))
            except sqlite3.OperationalError:
                # FTS 表在、分词器却不可用（换了 SQLite）：退回 LIKE，检索照常可用
                rows = self._query(c, owner, terms, limit, match_all, exclude_alias, use_fts=False)
        out: list[dict] = []
        per: dict[str, int] = {}
        for r in rows:
            if per.get(r["alias"], 0) >= per_thread:
                continue
            per[r["alias"]] = per.get(r["alias"], 0) + 1
            text, marks = snippet(r["content"], terms)
            out.append({"thread_id": r["alias"], "title": r["title"], "role": r["role"], "pos": r["pos"],
                        "at": r["created_at"], "snippet": text, "marks": marks, "content": r["content"]})
            if len(out) >= limit:
                break
        return out

    @staticmethod
    def _query(c: sqlite3.Connection, owner: str, terms: list[str], limit: int, match_all: bool,
               exclude_alias: str | None, *, use_fts: bool) -> list[sqlite3.Row]:
        long_terms = [t for t in terms if len(t) >= 3] if use_fts else []
        short_terms = [t for t in terms if t not in long_terms]
        clauses: list[str] = []
        params: list[object] = [owner]
        if long_terms:
            joiner = " " if match_all else " OR "
            clauses.append(f"m.id IN (SELECT rowid FROM {_FTS} WHERE {_FTS} MATCH ?)")
            params.append(joiner.join(_phrase(t) for t in long_terms))
        for term in short_terms:
            clauses.append("m.content LIKE ? ESCAPE '\\'")
            params.append(_like(term))
        where = (" AND " if match_all else " OR ").join(clauses)
        extra = ""
        if exclude_alias:
            extra = " AND m.alias<>?"
            params.append(exclude_alias)
        params.append(min(limit * 6, 300))
        return c.execute(
            "SELECT m.alias, m.pos, m.role, m.content, m.created_at, t.title "
            "FROM tenant_message_index m JOIN tenant_threads t ON t.owner_id=m.owner_id AND t.alias=m.alias "
            f"WHERE m.owner_id=? AND ({where}){extra} ORDER BY m.created_at DESC, m.id DESC LIMIT ?",
            params).fetchall()

    def message_after(self, alias: str, pos: int, *, owner_id: str | None = None) -> dict | None:
        """同一会话里紧接着的那条贾维斯回复（翻旧账工具把「问」和「答」一起交给模型）。"""
        owner = self._owner(owner_id)
        with self.store._connect() as c:
            row = c.execute(
                "SELECT role, content FROM tenant_message_index WHERE owner_id=? AND alias=? AND pos>? "
                "ORDER BY pos LIMIT 1", (owner, alias, int(pos))).fetchone()
        return dict(row) if row and row["role"] == "assistant" else None


# ---------- 同步编排：检索前补脏线程 + 后台回填 ----------

def refresh(owner_id: str, *, budget: float | None = 0.5, stop: threading.Event | None = None,
            pause: float = 0.0, exclude: Iterable[str] = ()) -> int:
    """把该用户的脏线程同步进索引（最近活跃的先来），返回还剩多少没同步。

    budget 秒用完就停（检索请求里只花一小段预算，剩下的交给后台回填）；exclude 是这次
    不碰的线程别名。读不到 checkpoint 的线程跳过并留待下次，不影响其它线程。"""
    if _loader is None:
        return 0
    index = HistoryIndex()
    try:
        pending = index.pending_threads(owner_id=owner_id, skip=_skip_aliases | set(exclude))
    except sqlite3.Error:
        log.exception("翻旧账：读取待同步线程失败")
        return 0
    if not pending:
        return 0
    deadline = time.monotonic() + budget if budget is not None else None
    done = 0
    with _loader(owner_id) as read:
        for thread in pending:
            if (stop is not None and stop.is_set()) or (deadline is not None and time.monotonic() > deadline):
                break
            try:
                messages = read(thread["checkpoint"])
                index.index_thread(thread["alias"], thread_messages(messages), owner_id=owner_id,
                                   thread_updated_at=thread["updated"])
                done += 1
            except Exception as exc:   # 单个线程读不出/写不进：留到下次，别拖垮整批
                warn_throttled("history-sync-failed", "翻旧账：同步线程失败（%s），稍后重试", type(exc).__name__)
            if pause:
                time.sleep(pause)
    return len(pending) - done


def sync_thread(owner_id: str, alias: str, messages, *, thread_updated_at: str) -> None:
    """一轮对话答完后立即同步该线程（失败只记日志，绝不影响对话）。"""
    if alias in _skip_aliases:
        return
    try:
        HistoryIndex().index_thread(alias, thread_messages(messages), owner_id=owner_id,
                                    thread_updated_at=thread_updated_at, settled=True)
    except Exception as exc:
        warn_throttled("history-sync-failed", "翻旧账：同步线程失败（%s），稍后重试", type(exc).__name__)


_backfilling: set[str] = set()
_backfill_lock = threading.Lock()


def backfill_async(owner_id: str, *, delay: float = 0.0, stop: threading.Event | None = None) -> bool:
    """后台把该用户剩下的历史全部回填（每个用户同时只跑一个）；已在跑返回 False。"""
    with _backfill_lock:
        if owner_id in _backfilling:
            return False
        _backfilling.add(owner_id)

    def run() -> None:
        try:
            if delay and (stop.wait(delay) if stop is not None else time.sleep(delay)):
                return
            refresh(owner_id, budget=None, stop=stop, pause=0.02)
        except Exception as exc:
            warn_throttled("history-backfill-failed", "翻旧账：历史回填中断（%s）", type(exc).__name__)
        finally:
            with _backfill_lock:
                _backfilling.discard(owner_id)

    threading.Thread(target=run, name="jarvis-history-backfill", daemon=True).start()
    return True
