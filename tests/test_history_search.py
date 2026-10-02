"""翻旧账（F10）：历史消息全文检索——索引同步、租户隔离、迁移回填、接口与 recall_history 工具。"""
import datetime as dt
import threading
from contextlib import contextmanager
from types import SimpleNamespace

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis import history_index
from jarvis.accounts import AccountStore
from jarvis.history_index import HistoryIndex, query_terms, snippet, thread_messages
from jarvis.tenancy import TenantStore, tenant_scope
from jarvis.tools.recall import recall_history
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage

OLD = "2026-09-21T12:00:00+00:00"   # 足够久远：同步结果视为已答完


@pytest.fixture()
def owner():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    owner_id = accounts.list_users()[0]["id"]
    with tenant_scope(owner_id):
        yield owner_id


@pytest.fixture()
def states(monkeypatch):
    """假 checkpoint：checkpoint_thread_id -> 消息列表；读取次数记在 reads。"""
    data: dict[str, list] = {}
    reads: list[str] = []

    @contextmanager
    def loader(_owner_id):
        def read(checkpoint):
            reads.append(checkpoint)
            return data.get(checkpoint, [])
        yield read

    monkeypatch.setattr(history_index, "_loader", loader)
    monkeypatch.setattr(history_index, "_skip_aliases", frozenset(server_mod.SERVICE_THREAD_ALIASES))
    return SimpleNamespace(data=data, reads=reads)


def _thread(alias, title, messages, states, *, owner_id=None, updated=OLD):
    thread = TenantStore().upsert_thread(alias, title, owner_id=owner_id, updated_at=updated)
    states.data[thread.checkpoint_thread_id] = messages
    return thread


def _sushi():
    return [
        HumanMessage("周末想吃日料，有什么推荐吗", id="h1"),
        AIMessage("", id="a0", tool_calls=[{"name": "web_search", "args": {}, "id": "c1"}]),
        ToolMessage("搜索结果……", tool_call_id="c1", id="t1"),
        AIMessage("推荐「鮨 心」，在静安寺附近，人均 400 左右。", id="a1"),
    ]


def _authed_client():
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


# ---------- 纯函数 ----------

def test_thread_messages_positions_match_history_api():
    rows = thread_messages(_sushi() + [HumanMessage("", id="h2"), HumanMessage("谢谢", id="h3")])
    # 工具消息、空正文 AI 不计位；空用户消息占位但不入索引（/api/history 也照样返回它）
    assert [(key, pos, role) for key, pos, role, _ in rows] == [
        ("h1", 0, "user"), ("a1", 1, "assistant"), ("h3", 3, "user")]


def test_query_terms_and_snippet_marks():
    assert query_terms("  日料  推荐 日料 ") == ["日料", "推荐"]
    text, marks = snippet("前面很长的铺垫" * 5 + "推荐「鮨 心」，**日料**很好", ["日料", "鮨 心"], before=4, width=20)
    assert text.startswith("…") and "**" not in text
    assert [text[a:b] for a, b in marks] == ["鮨 心", "日料"]


# ---------- 索引与检索 ----------

def test_search_long_and_short_terms_with_highlight(owner, states):
    _thread("t1", "周末去哪吃", _sushi(), states)
    _thread("t2", "周报怎么写", [HumanMessage("帮我写周报", id="x1"), AIMessage("好的，周报如下……", id="x2")], states)
    assert history_index.refresh(owner, budget=None) == 0
    index = HistoryIndex()

    hits = index.search("静安寺")            # ≥3 字：FTS trigram
    assert [(h["thread_id"], h["title"], h["role"], h["pos"]) for h in hits] == [("t1", "周末去哪吃", "assistant", 1)]
    assert [hits[0]["snippet"][a:b] for a, b in hits[0]["marks"]] == ["静安寺"]

    short = index.search("日料")              # 两字词：trigram 匹配不到，退回 LIKE
    assert [h["pos"] for h in short] == [0]
    assert index.search("周报 静安寺") == []  # 多个词默认要同时出现
    assert {h["thread_id"] for h in index.search("周报 静安寺", match_all=False)} == {"t1", "t2"}
    assert index.search("   ") == []


def test_search_caps_hits_per_thread_and_orders_newest_first(owner, states):
    many = [HumanMessage(f"第{i}次提到咖啡豆", id=f"m{i}") for i in range(5)]
    _thread("old", "旧会话", many, states, updated="2026-09-01T00:00:00+00:00")
    _thread("new", "新会话", [HumanMessage("咖啡豆又买了", id="n1")], states, updated="2026-09-30T00:00:00+00:00")
    history_index.refresh(owner, budget=None)
    hits = HistoryIndex().search("咖啡豆", per_thread=2)
    assert [h["thread_id"] for h in hits] == ["new", "old", "old"]
    assert [h["pos"] for h in hits[1:]] == [4, 3]       # 同一会话里也是后说的在前


def test_sync_mirrors_checkpoint_and_skips_service_threads(owner, states):
    thread = _thread("t1", "周末去哪吃", _sushi(), states)
    _thread("radio", "晨报电台", [HumanMessage("晨报：静安寺天气", id="r1")], states)
    history_index.refresh(owner, budget=None)
    assert [h["thread_id"] for h in HistoryIndex().search("静安寺")] == ["t1"]   # 服务线程不入索引

    # 重答：旧回答被摘掉、换成新回答 → 索引跟着换
    states.data[thread.checkpoint_thread_id] = _sushi()[:3] + [AIMessage("改推荐「鮨 野」，在徐汇", id="a2")]
    TenantStore().upsert_thread("t1", "", updated_at="2026-09-22T04:00:00+00:00")
    history_index.refresh(owner, budget=None)
    assert HistoryIndex().search("静安寺") == []
    assert [h["snippet"] for h in HistoryIndex().search("鮨 野")] == ["改推荐「鮨 野」，在徐汇"]


def test_refresh_only_rereads_dirty_threads(owner, states):
    _thread("t1", "周末去哪吃", _sushi(), states)
    history_index.refresh(owner, budget=None)
    states.reads.clear()
    history_index.refresh(owner, budget=None)
    assert states.reads == []                                # 已同步且已答完：不再读 checkpoint

    recent = dt.datetime.now(dt.timezone.utc).isoformat()
    _thread("t2", "刚开始的会话", [HumanMessage("问个问题", id="q1")], states, updated=recent)
    history_index.refresh(owner, budget=None)
    history_index.refresh(owner, budget=None)
    assert states.reads.count(TenantStore().get_thread("t2").checkpoint_thread_id) == 2   # 这轮可能没答完：下次再补


def test_refresh_respects_budget_and_survives_unreadable_threads(owner, states, monkeypatch):
    _thread("t1", "周末去哪吃", _sushi(), states)
    broken = _thread("t2", "坏掉的线程", [], states)

    @contextmanager
    def flaky(_owner_id):
        def read(checkpoint):
            if checkpoint == broken.checkpoint_thread_id:
                raise RuntimeError("checkpoint 读不出来")
            return states.data[checkpoint]
        yield read

    monkeypatch.setattr(history_index, "_loader", flaky)
    assert history_index.refresh(owner, budget=0) == 2        # 预算为 0：一条也不读，留给后台
    assert history_index.refresh(owner, budget=None) == 1     # 坏线程留待下次，不拖垮其它线程
    assert [h["thread_id"] for h in HistoryIndex().search("静安寺")] == ["t1"]


def test_search_still_works_when_runtime_unavailable(owner, states, monkeypatch):
    _thread("t1", "周末去哪吃", _sushi(), states)
    history_index.refresh(owner, budget=None)
    TenantStore().upsert_thread("t1", "", updated_at="2026-09-22T04:00:00+00:00")   # 又脏了

    @contextmanager
    def broken(_owner_id):
        raise RuntimeError("模型配置有误，runtime 起不来")
        yield  # pragma: no cover

    monkeypatch.setattr(history_index, "_loader", broken)
    assert history_index.refresh(owner, budget=None) == 1
    r = _authed_client().get("/api/history/search", params={"q": "静安寺"})
    assert r.status_code == 200 and [i["thread_id"] for i in r.json()["items"]] == ["t1"]


def test_backfill_async_runs_once_per_owner(owner, states):
    for i in range(3):
        _thread(f"t{i}", f"会话{i}", [HumanMessage(f"第{i}个会话聊到了露营装备", id=f"b{i}")], states)
    stop = threading.Event()
    assert history_index.backfill_async(owner, stop=stop) is True
    for t in threading.enumerate():
        if t.name == "jarvis-history-backfill":
            t.join(timeout=5)
    assert len(HistoryIndex().search("露营装备")) == 3


# ---------- 隔离与删除 ----------

def test_search_is_isolated_per_user(owner, states):
    accounts = AccountStore()
    other = accounts.create_user("bob", "a-strong-pass-123", "Member")["id"]
    _thread("t1", "我的会话", [HumanMessage("我的秘密配方是桂花酒酿", id="o1")], states)
    with tenant_scope(other):
        _thread("t1", "Bob 的会话", [HumanMessage("Bob 也喜欢桂花酒酿", id="b1")], states, owner_id=other)
        history_index.refresh(other, budget=None)
        assert [h["title"] for h in HistoryIndex().search("桂花酒酿")] == ["Bob 的会话"]
    history_index.refresh(owner, budget=None)
    assert [h["title"] for h in HistoryIndex().search("桂花酒酿")] == ["我的会话"]


def test_delete_thread_removes_index_rows(owner, states):
    _thread("t1", "周末去哪吃", _sushi(), states)
    _thread("t2", "别的会话", [HumanMessage("静安寺附近停车难", id="p1")], states)
    history_index.refresh(owner, budget=None)
    c = _authed_client()
    assert c.delete("/api/thread", params={"thread_id": "t1"}).status_code == 200
    assert [h["thread_id"] for h in HistoryIndex().search("静安寺")] == ["t2"]
    with TenantStore()._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tenant_message_index WHERE alias='t1'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM tenant_message_sync WHERE alias='t1'").fetchone()[0] == 0
        # FTS 影子表也同步删干净（触发器生效），不会留下可被 MATCH 到的孤儿
        assert conn.execute("SELECT COUNT(*) FROM tenant_message_fts WHERE tenant_message_fts MATCH '\"鮨 心\"'").fetchone()[0] == 0


def test_index_thread_ignores_deleted_thread(owner, states):
    thread = _thread("t1", "周末去哪吃", _sushi(), states)
    TenantStore().delete_thread("t1")
    rows = thread_messages(states.data[thread.checkpoint_thread_id])
    assert HistoryIndex().index_thread("t1", rows, thread_updated_at=OLD) == 0   # 删除与同步交错也不会写回


def test_user_delete_cascades_to_index(owner, states):
    accounts = AccountStore()
    other = accounts.create_user("carol", "a-strong-pass-456", "Member")["id"]
    with tenant_scope(other):
        _thread("t1", "会话", [HumanMessage("卡罗尔的猫叫团子", id="c1")], states, owner_id=other)
        history_index.refresh(other, budget=None)
    fts_hits = "SELECT COUNT(*) FROM tenant_message_fts WHERE tenant_message_fts MATCH '\"猫叫团子\"'"
    with TenantStore()._connect() as conn:
        assert conn.execute(fts_hits).fetchone()[0] == 1
        conn.execute("DELETE FROM users WHERE id=?", (other,))
        assert conn.execute("SELECT COUNT(*) FROM tenant_message_index").fetchone()[0] == 0
        assert conn.execute(fts_hits).fetchone()[0] == 0     # 外键级联删除同样触发 FTS 同步


# ---------- 迁移与回填 ----------

def test_v4_migration_upgrades_v3_database_and_backfills(owner, states):
    """存量库升级：只到 v3 的库重连后补建 v4 表与 FTS，已有会话可回填、可检索。"""
    _thread("t1", "周末去哪吃", _sushi(), states)
    store = TenantStore()
    with store._connect() as c:   # 造一个 v3 旧库：删掉 v4 的表、FTS 与触发器，抹掉版本记录
        c.execute("DROP TABLE tenant_message_fts")
        for name in ("ai", "ad", "au"):
            c.execute(f"DROP TRIGGER IF EXISTS tenant_message_index_{name}")
        c.execute("DROP TABLE tenant_message_index")
        c.execute("DROP TABLE tenant_message_sync")
        c.execute("DELETE FROM tenant_schema_migrations WHERE version=4")
        c.commit()
    TenantStore.reset_migration_cache()   # 模拟新进程首连旧库
    with store._connect() as c:
        assert c.execute("SELECT 1 FROM tenant_schema_migrations WHERE version=4").fetchone()
        assert c.execute("SELECT 1 FROM sqlite_master WHERE name='tenant_message_fts'").fetchone()
    assert [t["alias"] for t in HistoryIndex().pending_threads()] == ["t1"]   # 老会话等待回填
    assert history_index.refresh(owner, budget=None) == 0
    assert [h["thread_id"] for h in HistoryIndex().search("静安寺")] == ["t1"]


def test_fts_added_later_rebuilds_from_existing_rows(owner, states, monkeypatch):
    """旧 SQLite 不支持 trigram 时只有 LIKE；换了支持的 SQLite 后补建 FTS 并灌入已有副本。"""
    store = TenantStore()
    with store._connect() as c:
        c.execute("DROP TABLE tenant_message_fts")
        for name in ("ai", "ad", "au"):
            c.execute(f"DROP TRIGGER IF EXISTS tenant_message_index_{name}")
        c.commit()
    _thread("t1", "周末去哪吃", _sushi(), states)
    history_index.refresh(owner, budget=None)
    assert [h["thread_id"] for h in HistoryIndex().search("静安寺")] == ["t1"]   # 没有 FTS：LIKE 也能搜
    TenantStore.reset_migration_cache()
    with store._connect() as c:
        assert c.execute("SELECT COUNT(*) FROM tenant_message_fts WHERE tenant_message_fts MATCH '\"静安寺\"'").fetchone()[0] == 1


def test_without_trigram_support_search_falls_back_to_like(owner, states, monkeypatch):
    store = TenantStore()
    with store._connect() as c:
        c.execute("DROP TABLE tenant_message_fts")
        for name in ("ai", "ad", "au"):
            c.execute(f"DROP TRIGGER IF EXISTS tenant_message_index_{name}")
        c.commit()
    monkeypatch.setattr(history_index, "trigram_supported", lambda: False)
    TenantStore.reset_migration_cache()
    _thread("t1", "周末去哪吃", _sushi(), states)
    history_index.refresh(owner, budget=None)
    with store._connect() as c:
        assert not c.execute("SELECT 1 FROM sqlite_master WHERE name='tenant_message_fts'").fetchone()
    hits = HistoryIndex().search("静安寺 人均")
    assert [h["thread_id"] for h in hits] == ["t1"]
    assert [hits[0]["snippet"][a:b] for a, b in hits[0]["marks"]] == ["静安寺", "人均"]


# ---------- 接口 ----------

def test_search_endpoint_requires_login():
    assert TestClient(server_mod.app).get("/api/history/search", params={"q": "日料"}).status_code == 401


def test_search_endpoint_returns_snippets_without_full_content(owner, states):
    _thread("t1", "周末去哪吃", _sushi(), states)
    c = _authed_client()
    r = c.get("/api/history/search", params={"q": "静安寺", "limit": 5})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    [item] = r.json()["items"]
    assert item["thread_id"] == "t1" and item["title"] == "周末去哪吃" and item["role"] == "assistant"
    assert item["pos"] == 1 and item["at"] == OLD and "content" not in item
    assert [item["snippet"][a:b] for a, b in item["marks"]] == ["静安寺"]
    assert c.get("/api/history/search", params={"q": " "}).json() == {"items": []}
    assert c.get("/api/history/search", params={"q": "长" * 101}).status_code == 422


def test_chat_turn_is_indexed_immediately(owner, monkeypatch):
    """网页对话每轮答完立即入索引，不依赖之后的补同步。"""
    store: dict[str, list] = {}

    class FakeAgent:
        def stream(self, payload, config=None, stream_mode=None):
            tid = config["configurable"]["thread_id"]
            store[tid] = [HumanMessage(payload["messages"][0]["content"], id="u1"),
                          AIMessage("番茄炒蛋要先炒蛋再炒番茄。", id="r1")]
            yield AIMessageChunk(content="番茄炒蛋要先炒蛋再炒番茄。"), {}

        def get_state(self, config):
            return SimpleNamespace(values={"messages": store[config["configurable"]["thread_id"]]})

    @contextmanager
    def fake_bundle(_user_id):
        yield SimpleNamespace(agent=FakeAgent())

    monkeypatch.setattr(server_mod, "_bundle_for", fake_bundle)
    monkeypatch.setattr(history_index, "_loader", None)   # 证明不是靠检索前补同步
    c = _authed_client()
    assert c.post("/api/chat", json={"message": "番茄炒蛋怎么做", "thread_id": "t-cook"}).status_code == 200
    hits = HistoryIndex().search("番茄炒蛋")
    assert [(h["thread_id"], h["role"]) for h in hits] == [("t-cook", "assistant"), ("t-cook", "user")]
    assert HistoryIndex().pending_threads() == []          # 答完即视为已同步


# ---------- 工具 ----------

def test_recall_history_cites_title_and_date_with_reply(owner, states):
    _thread("t1", "周末去哪吃", _sushi(), states)
    out = recall_history.invoke({"query": "日料"})
    assert "出处：9/21《周末去哪吃》（9月21日）" in out
    assert "领导说：周末想吃日料" in out and "贾维斯答：推荐「鮨 心」" in out   # 问与答一起给模型
    assert "注明出处" in out


def test_recall_history_falls_back_to_any_term_and_reports_miss(owner, states):
    _thread("t1", "周末去哪吃", _sushi(), states)
    assert "鮨 心" in recall_history.invoke({"query": "静安寺 火锅"})   # 同时出现的没有：放宽成任一
    assert "没有翻到" in recall_history.invoke({"query": "量子计算"})


def test_recall_history_skips_the_current_turn_thread(owner, states):
    recent = dt.datetime.now(dt.timezone.utc).isoformat()
    current = _thread("cur", "当前会话", [HumanMessage("上次你推荐的那家日料叫什么", id="q")], states, updated=recent)
    out = recall_history.invoke({
        "name": "recall_history", "args": {"query": "日料"}, "id": "call-1", "type": "tool_call"},
        config={"configurable": {"thread_id": current.checkpoint_thread_id}})
    assert "没有翻到" in out.content                          # 这一问本身不会被自己搜到
    assert current.checkpoint_thread_id not in states.reads


def test_recall_history_never_raises_without_tenant():
    out = recall_history.invoke({"query": "日料"})
    assert "暂时不可用" in out
