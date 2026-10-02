"""后端全功能实测回归（2026-10-02 QA 轮）：每条用例对应一次实测复现的 bug。"""
import asyncio
import gc
import json
import logging
import threading
import time
import warnings
from contextlib import contextmanager
from types import SimpleNamespace

import httpx
import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantStore, tenant_scope
from langchain_core.messages import AIMessage, AIMessageChunk


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


def _client(raise_server_exceptions: bool = True) -> TestClient:
    c = TestClient(server_mod.app, raise_server_exceptions=raise_server_exceptions)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _events(text: str) -> list[dict]:
    return [json.loads(line[6:]) for line in text.split("\n\n") if line.startswith("data: ")]


class _CountingAgent:
    """记录 stream 被调用的次数与最大并发度；不碰真实模型。"""

    def __init__(self, delay: float = 0.0):
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self.delay = delay
        self._lock = threading.Lock()

    def stream(self, _payload, config=None, stream_mode=None):
        with self._lock:
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(self.delay)
            yield AIMessageChunk(content="好的"), {}
        finally:
            with self._lock:
                self.active -= 1

    def invoke(self, _payload, config=None):
        self.calls += 1
        return {"messages": [AIMessage(content="好的")]}


def _use_agent(monkeypatch, agent):
    @contextmanager
    def fake_bundle(_user_id):
        yield SimpleNamespace(agent=agent)

    monkeypatch.setattr(server_mod, "_bundle_for", fake_bundle)


# ---------- /api/chat 参数边界 ----------

@pytest.mark.parametrize("message", ["", "   \n\t "])
def test_chat_rejects_blank_message_without_calling_model(monkeypatch, message):
    """实测：空消息照样送进模型（白烧一次请求），应在入口 422。"""
    agent = _CountingAgent()
    _use_agent(monkeypatch, agent)
    r = _client().post("/api/chat", json={"message": message, "thread_id": "t-blank"})
    assert r.status_code == 422
    assert "不能为空" in r.json()["error"]
    assert agent.calls == 0


def test_chat_rejects_overlong_message(monkeypatch):
    agent = _CountingAgent()
    _use_agent(monkeypatch, agent)
    huge = "长" * (server_mod.MAX_CHAT_CHARS + 1)
    r = _client().post("/api/chat", json={"message": huge, "thread_id": "t-long"})
    assert r.status_code == 422 and "太长" in r.json()["error"]
    assert agent.calls == 0


@pytest.mark.parametrize("thread_id", ["", "   ", "x" * 200])
def test_chat_rejects_invalid_thread_id_instead_of_500(monkeypatch, thread_id):
    """实测：thread_id 为空串时 upsert_thread 抛 ValueError → 500 Internal Server Error。"""
    agent = _CountingAgent()
    _use_agent(monkeypatch, agent)
    r = _client(raise_server_exceptions=False).post(
        "/api/chat", json={"message": "你好", "thread_id": thread_id})
    assert r.status_code == 422
    assert "error" in r.json()
    assert agent.calls == 0


# ---------- 同一线程并发 ----------

def test_same_thread_turns_are_serialized(monkeypatch):
    """实测：同一线程同时两条消息，两轮并行写同一 checkpoint，历史里丢了一条回答；
    且后到的一轮会把前一轮「在途」的 tool_calls 当悬空调用删掉。必须串行。"""
    agent = _CountingAgent(delay=0.3)
    _use_agent(monkeypatch, agent)
    c = _client()
    results = []

    def send(text):
        r = c.post("/api/chat", json={"message": text, "thread_id": "t-same"})
        results.append([e["type"] for e in _events(r.text)])

    workers = [threading.Thread(target=send, args=(t,)) for t in ("苹果", "香蕉")]
    for w in workers:
        w.start()
    for w in workers:
        w.join(10)
    assert agent.calls == 2
    assert agent.max_active == 1, "同一线程的两轮必须串行执行"
    assert results and all(kinds[-1] == "done" for kinds in results)


def test_different_threads_still_run_in_parallel(monkeypatch):
    agent = _CountingAgent(delay=0.3)
    _use_agent(monkeypatch, agent)
    c = _client()
    workers = [threading.Thread(target=c.post, args=("/api/chat",),
                                kwargs={"json": {"message": "hi", "thread_id": f"t-par-{i}"}})
               for i in range(2)]
    for w in workers:
        w.start()
    for w in workers:
        w.join(10)
    assert agent.max_active == 2


def test_busy_thread_times_out_with_friendly_error(monkeypatch):
    from jarvis import graph
    agent = _CountingAgent()
    _use_agent(monkeypatch, agent)
    monkeypatch.setattr(server_mod, "TURN_WAIT_SECONDS", 0.05)
    owner = AccountStore().list_users()[0]["id"]
    thread = server_mod._upsert_thread(owner, "t-busy", "占位")
    with graph.thread_turn(thread.checkpoint_thread_id):
        r = _client().post("/api/chat", json={"message": "hi", "thread_id": "t-busy"})
    events = _events(r.text)
    assert events[-1]["type"] == "error"
    assert "上一条" in events[-1]["message"]
    assert agent.calls == 0


def test_thread_turn_lock_registry_is_bounded():
    from jarvis import graph
    for i in range(50):
        with graph.thread_turn(f"tmp-{i}"):
            pass
    assert graph._turn_lock_count() == 0


# ---------- 路径参数溢出 ----------

@pytest.mark.parametrize("method,path,body", [
    ("patch", "/api/todos/{id}", {"done": True}),
    ("delete", "/api/todos/{id}", None),
    ("delete", "/api/memos/{id}", None),
    ("delete", "/api/schedule/{id}", None),
    ("delete", "/api/profile/{id}", None),
    ("get", "/api/meetings/{id}", None),
    ("post", "/api/meetings/{id}/email", None),
    ("post", "/api/meetings/{id}/todos", None),
    ("patch", "/api/meetings/{id}/speaker", {"speaker": "对方1", "name": "张三"}),
])
def test_huge_item_id_is_client_error_not_500(method, path, body):
    """实测：/api/todos/99999999999999999999999 → OverflowError → 500 且连接被重置。"""
    c = _client(raise_server_exceptions=False)
    url = path.format(id="99999999999999999999999")
    kwargs = {"json": body} if body is not None else {}
    r = getattr(c, method)(url, **kwargs)
    assert 400 <= r.status_code < 500
    assert "error" in r.json()


# ---------- 未捕获异常 / 404 也要中文 JSON ----------

def test_unhandled_exception_returns_chinese_json(monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("internal detail that must not leak")

    monkeypatch.setattr(TenantStore, "list_threads", boom)
    r = _client(raise_server_exceptions=False).get("/api/threads")
    assert r.status_code == 500
    body = r.json()
    assert "internal detail" not in r.text
    assert body["error"] and "稍后" in body["error"]


def test_unknown_api_route_returns_chinese_json():
    r = _client().get("/api/definitely-not-here")
    assert r.status_code == 404 and r.json() == {"error": "接口不存在"}
    r = _client().get("/api/todos")   # 只有 POST
    assert r.status_code == 405 and "error" in r.json()


# ---------- OpenAI 兼容接口：非流式失败不该 500 裸文本 ----------

def test_openai_non_stream_failure_is_json(monkeypatch):
    class Broken:
        def invoke(self, *_a, **_k):
            raise httpx.ConnectError("upstream down http://secret-host")

    _use_agent(monkeypatch, Broken())
    issued = AccountStore().issue_session(AccountStore().list_users()[0]["id"], "openai")
    _principal, token = issued
    c = TestClient(server_mod.app, raise_server_exceptions=False)
    r = c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
               json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 502
    assert "secret-host" not in r.text
    assert r.json()["error"]["message"]


# ---------- 日程时间规范化 ----------

def test_schedule_time_is_stored_zero_padded():
    """实测：'2026-1-2 3:04' 能过 strptime 但按原样入库；提醒扫描用字典序比较 when_at，
    非补零格式会永远（或提前）命中错窗口。入库前统一成 YYYY-MM-DD HH:MM。"""
    c = _client()
    r = c.post("/api/schedule", json={"title": "体检", "when": "2026-1-2 3:04"})
    assert r.status_code == 200
    assert TenantStore().list_schedule()[0]["when"] == "2026-01-02 03:04"


def test_schedule_tool_normalizes_time():
    from jarvis.tools.schedule import schedule_add
    out = schedule_add.invoke({"title": "看牙", "when": "2026-3-5 9:00"})
    assert "2026-03-05 09:00" in out
    assert TenantStore().list_schedule()[0]["when"] == "2026-03-05 09:00"


# ---------- provider_runtime：停机 aclose 协程泄漏 ----------

def test_runtime_bundle_close_inside_event_loop_awaits_aclose():
    """生产 journal 每次重启：provider_runtime.py:211 RuntimeWarning: coroutine
    'AsyncClient.aclose' was never awaited——lifespan 停机在事件循环里调 close()，
    asyncio.run 抛 RuntimeError，已创建的协程被丢弃。"""
    from jarvis.provider_runtime import RuntimeBundle

    client = httpx.AsyncClient(trust_env=False)
    bundle = RuntimeBundle("u", 1, agent=None, search_service=None, async_client=client)

    async def shutdown():
        bundle.close()

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        asyncio.run(shutdown())
        gc.collect()
    assert not [w for w in caught if "was never awaited" in str(w.message)]
    assert client.is_closed


def test_runtime_bundle_close_outside_loop_still_closes():
    from jarvis.provider_runtime import RuntimeBundle

    client = httpx.AsyncClient(trust_env=False)
    RuntimeBundle("u", 1, agent=None, search_service=None, async_client=client).close()
    assert client.is_closed


# ---------- 弱口令告警 ----------

@pytest.mark.parametrize("password,weak", [
    ("admin", True), ("123456", True), ("password", True), ("Admin", True),
    ("abcdefg", True), ("aaaaaaaaaaaa", True), ("12345678", True), ("88888888", True),
    ("Admin@2026", False), ("correct horse battery", False), ("Qa-Backend-2026!x", False),
])
def test_password_is_weak_rules(password, weak):
    from jarvis.accounts import password_is_weak
    assert password_is_weak(password, "admin") is weak


def test_password_same_as_username_is_weak():
    from jarvis.accounts import password_is_weak
    assert password_is_weak("zhangsan2026", "zhangsan2026") is True


def test_session_reports_password_weak_without_blocking_login():
    c = _client()   # conftest 的 admin/admin 正是生产现状
    session = c.get("/api/session").json()
    assert session["authed"] is True and session["password_weak"] is True
    # 改成强口令后重新登录，标记消失；不自动改密、不锁号
    r = c.post("/api/account/password", json={"current_password": "admin", "new_password": "Str0ng-Pass-2026"})
    assert r.status_code == 200
    c2 = TestClient(server_mod.app)
    assert c2.post("/api/login", json={"username": "admin", "password": "Str0ng-Pass-2026"}).status_code == 200
    assert c2.get("/api/session").json()["password_weak"] is False


def test_anonymous_session_has_no_password_flag():
    assert "password_weak" not in TestClient(server_mod.app).get("/api/session").json()


def test_startup_scan_warns_about_default_password(caplog):
    accounts = AccountStore()
    with caplog.at_level(logging.WARNING, logger="jarvis.accounts"):
        weak = accounts.scan_weak_passwords()
    assert [u["username"] for u in weak] == ["admin"]
    assert any("admin" in rec.getMessage() and rec.levelno == logging.WARNING for rec in caplog.records)
    # 扫描结果进缓存：重启后带旧 cookie 的会话不登录也能拿到标记
    user_id = accounts.list_users()[0]["id"]
    assert accounts.password_weak(user_id) is True


def test_startup_scan_is_silent_for_strong_password(caplog):
    accounts = AccountStore()
    accounts.update_user(accounts.list_users()[0]["id"], password="Str0ng-Pass-2026")
    with caplog.at_level(logging.WARNING, logger="jarvis.accounts"):
        assert accounts.scan_weak_passwords() == []
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


# ---------- 飞书未绑定提示：面向普通用户 ----------

def test_feishu_unbound_reply_is_for_end_users():
    from jarvis.channels.feishu import bridge
    for text in (bridge.UNBOUND_REPLY, bridge.STALE_BINDING_REPLY, bridge.BIND_INVALID_REPLY):
        assert "/api/" not in text and "python -m" not in text and "POST" not in text
    assert "头像菜单" in bridge.UNBOUND_REPLY and "飞书" in bridge.UNBOUND_REPLY
    assert "绑定 123456" in bridge.UNBOUND_REPLY
