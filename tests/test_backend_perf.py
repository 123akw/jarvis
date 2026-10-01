"""后端卡顿修复的回归锁：有界历史 / checkpoint 清理 / 模型超时与连接池 / 断开即停 / 定位不挡首字节。"""
import asyncio
import json
import socket
import sqlite3
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

import jarvis.graph as graph_mod
import jarvis.provider_runtime as runtime_mod
import jarvis.server as server_mod
import jarvis.tools.location as location_mod
from jarvis.accounts import AccountStore
from jarvis.provider_settings import ResolvedLLM
from jarvis.tenancy import tenant_scope


@pytest.fixture
def owner():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    owner_id = accounts.list_users()[0]["id"]
    with tenant_scope(owner_id):
        yield owner_id


def _turn(i: int, tool_chars: int = 3000, answer_chars: int = 400) -> list:
    call_id = f"call-{i}"
    return [
        HumanMessage(content=f"第{i}轮问题", id=f"h{i}"),
        AIMessage(content="", id=f"a{i}", tool_calls=[{"name": "web_search", "args": {"query": str(i)},
                                                        "id": call_id, "type": "tool_call"}]),
        ToolMessage(content="搜" * tool_chars, name="web_search", tool_call_id=call_id, id=f"t{i}"),
        AIMessage(content="答" * answer_chars, id=f"r{i}"),
    ]


def _thread(turns: int) -> list:
    return [m for i in range(turns) for m in _turn(i)] + [HumanMessage(content="新问题", id="now")]


def _chars(messages) -> int:
    return sum(len(str(m.content)) for m in messages)


# ---------- 有界历史 ----------

def test_bounded_history_trims_at_turn_boundary_and_keeps_tool_pairs():
    history = _thread(150)
    bounded = graph_mod.bounded_history(history, budget=30_000)
    assert _chars(bounded) <= 30_000 < _chars(history)
    assert bounded[0].type == "human"                       # 只在轮次边界切
    assert bounded[-1].id == "now"                          # 本轮完整保留
    declared = {c["id"] for m in bounded if m.type == "ai" for c in (m.tool_calls or [])}
    assert all(m.tool_call_id in declared for m in bounded if m.type == "tool")


def test_bounded_history_compacts_only_older_tool_results():
    history = _thread(6)
    bounded = graph_mod.bounded_history(history, budget=1_000_000)
    assert len(bounded) == len(history)                     # 预算内不丢任何消息
    tools = [m for m in bounded if m.type == "tool"]
    assert all(len(m.content) < 1000 for m in tools[:-1])   # 更早轮次的工具结果被截短
    assert len(tools[-1].content) == 3000                   # 上一轮的工具结果原样（便于追问）
    assert len(history[2].content) == 3000                  # 不改动 checkpoint 里的原消息


def test_bounded_history_window_start_is_stable_across_turns():
    """窗口起点按档跳动：连续多轮前缀不变，服务端前缀缓存才能命中。"""
    starts = set()
    for turns in range(60, 80):
        bounded = graph_mod.bounded_history(_thread(turns), budget=30_000)
        starts.add(bounded[0].id)
    assert len(starts) <= 20 // graph_mod.HISTORY_TURN_STEP + 2


def test_bounded_history_step_rounding_never_drops_the_previous_turn():
    """单轮很大（如整篇网页正文）时，档位取整不能把放得下的上一轮也丢掉。"""
    history = [m for i in range(20) for m in _turn(i, tool_chars=9000, answer_chars=9000)] + [
        HumanMessage(content="那第二条展开说说", id="now")]
    bounded = graph_mod.bounded_history(history, budget=30_000)
    # 放得下的是第 18、19 轮；按 8 轮一档取整会跳到只剩本轮，必须放弃取整
    assert [m.id for m in bounded if m.type == "human"] == ["h18", "h19", "now"]
    assert _chars(bounded) <= 30_000


def test_bounded_history_keeps_voice_style_message_and_can_be_disabled(monkeypatch):
    history = [m for i in range(120) for m in _turn(i)] + [
        SystemMessage(content="语音风格：口语化", id="style"), HumanMessage(content="语音提问", id="now")]
    bounded = graph_mod.bounded_history(history, budget=20_000)
    assert [m.id for m in bounded[-2:]] == ["style", "now"]
    monkeypatch.setenv("JARVIS_HISTORY_CHAR_BUDGET", "0")
    assert len(graph_mod.bounded_history(history)) == len(history)


class RecordingModel(BaseChatModel):
    seen: list = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "recording"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="好"))])


def test_agent_sends_bounded_history_but_checkpoint_keeps_everything(owner, tmp_path):
    model = RecordingModel()
    saver = graph_mod.SqliteSaver(sqlite3.connect(str(tmp_path / "c.db"), check_same_thread=False))
    agent = graph_mod.build_agent(search_service=SimpleNamespace(generation=1), model=model, checkpointer=saver)
    config = {"configurable": {"thread_id": "long"}}
    agent.update_state(config, {"messages": _thread(150)[:-1]})
    agent.invoke({"messages": [{"role": "user", "content": "新问题"}]}, config=config)
    sent = model.seen[-1]
    assert sent[0].type == "system"
    assert _chars(sent[1:]) <= graph_mod.HISTORY_CHAR_BUDGET
    assert len(agent.get_state(config).values["messages"]) == 150 * 4 + 2   # 全量历史仍在


# ---------- checkpoint 旧版本清理 ----------

def test_pruning_saver_keeps_two_checkpoints_per_thread_without_losing_state(owner, tmp_path):
    model = RecordingModel()
    saver = graph_mod.SqliteSaver(sqlite3.connect(str(tmp_path / "c.db"), check_same_thread=False))
    agent = graph_mod.build_agent(search_service=SimpleNamespace(generation=1), model=model, checkpointer=saver)
    for thread in ("a", "b"):
        config = {"configurable": {"thread_id": thread}}
        for i in range(6):
            agent.invoke({"messages": [{"role": "user", "content": f"{thread}{i}"}]}, config=config)
    rows = dict(saver.conn.execute("SELECT thread_id, COUNT(*) FROM checkpoints GROUP BY thread_id").fetchall())
    assert rows == {"a": 2, "b": 2}
    state = agent.get_state({"configurable": {"thread_id": "a"}})
    assert [m.content for m in state.values["messages"] if m.type == "human"] == [f"a{i}" for i in range(6)]
    graph_mod.heal_dangling_tool_calls(agent, "a")          # update_state 路径照常工作
    agent.invoke({"messages": [{"role": "user", "content": "a6"}]}, config={"configurable": {"thread_id": "a"}})
    assert len(agent.get_state({"configurable": {"thread_id": "a"}}).values["messages"]) == 14
    saver.delete_thread("b")
    assert saver.conn.execute("SELECT COUNT(*) FROM checkpoints WHERE thread_id='b'").fetchone()[0] == 0


# ---------- 模型请求超时与连接池 ----------

@contextmanager
def _hanging_llm_endpoint(hang_seconds: float):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length", 0)))
            time.sleep(hang_seconds)
            body = json.dumps({"id": "x", "object": "chat.completion", "created": 0, "model": "m",
                               "choices": [{"index": 0, "finish_reason": "stop",
                                            "message": {"role": "assistant", "content": "ok"}}]}).encode()
            try:
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass

    class Quiet(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address):
            pass

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    httpd = Quiet(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        httpd.shutdown()


def _factory_bundle(base_url: str):
    manager = runtime_mod.AgentRuntimeManager(store=SimpleNamespace(), checkpointer=False)
    integrations = {name: {"enabled": False, "base_url": "", "api_key": ""}
                    for name in ("searxng", "tavily", "pandascore")}
    llm = ResolvedLLM("deepseek", base_url, "m", "sk-test", 0, "environment")
    return manager._default_factory("u", llm, integrations)


def test_runtime_llm_requests_time_out_instead_of_hanging_forever(monkeypatch):
    """此前 ChatOpenAI 拿到的超时是 None：上游挂起时聊天线程无限卡死。"""
    original = runtime_mod._is_public_address
    monkeypatch.setattr(runtime_mod, "_is_public_address",
                        lambda address: str(address) == "127.0.0.1" or original(address))
    monkeypatch.setattr(runtime_mod, "LLM_TIMEOUT", httpx.Timeout(0.4, connect=1.0))
    with _hanging_llm_endpoint(hang_seconds=5) as base_url:
        bundle = _factory_bundle(base_url)
        try:
            assert bundle.model.root_client.timeout is not None
            started = time.monotonic()
            with pytest.raises(Exception) as caught:
                bundle.model.invoke("hi")
            assert "Timeout" in type(caught.value).__name__
            assert time.monotonic() - started < 4      # 0.4s × (1 + 1 次重试) + 退避，远小于挂起时长
        finally:
            bundle.close()


def test_runtime_pool_limits_are_applied_on_the_httpcore_pool():
    """httpx.Client(limits=...) 在自带 transport 时被忽略；上限与 keep-alive 过期必须配在池上。"""
    bundle = _factory_bundle("https://api.deepseek.com/v1")
    try:
        pool = bundle.sync_client._transport._pool
        assert pool._max_connections == runtime_mod.RUNTIME_MAX_CONNECTIONS > 10
        assert pool._keepalive_expiry == runtime_mod.KEEPALIVE_EXPIRY_SECONDS
        assert bundle.model.root_client.timeout.read == graph_mod.LLM_TIMEOUT.read
        assert bundle.model.root_client.max_retries == graph_mod.LLM_MAX_RETRIES
    finally:
        bundle.close()


# ---------- 客户端断开即停 agent ----------

def test_client_disconnect_stops_agent_generator_promptly():
    state = {"produced": 0, "closed_at": None}

    def factory():
        def gen():
            try:
                for i in range(30):
                    time.sleep(0.05)
                    state["produced"] += 1
                    yield f"data: {i}\n\n"
            finally:
                state["closed_at"] = time.monotonic()
        return gen()

    async def client():
        stream = server_mod._stream_from_agent_thread(factory)
        await stream.__anext__()
        disconnected = time.monotonic()
        await stream.aclose()
        deadline = time.monotonic() + 3
        while state["closed_at"] is None and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        return disconnected

    disconnected = asyncio.run(client())
    assert state["closed_at"] is not None
    assert state["closed_at"] - disconnected < 0.5           # 此前要白跑完整段（30 × 50ms）
    assert state["produced"] <= 3


# ---------- 定位刷新不挡首字节 ----------

@pytest.fixture
def fresh_location_state():
    location_mod._ip_misses.clear()
    location_mod._refresh_inflight.clear()
    yield
    location_mod._ip_misses.clear()
    location_mod._refresh_inflight.clear()


def test_ip_lookup_runs_in_background_and_failures_are_not_retried_every_chat(owner, fresh_location_state, monkeypatch):
    calls = []

    def slow_miss(url, params, timeout=10):
        calls.append(url)
        time.sleep(0.3)
        raise TimeoutError("simulated")

    monkeypatch.setattr(location_mod, "_get_json", slow_miss)
    started = time.monotonic()
    worker = location_mod.refresh_location(ip="1.12.67.169")
    assert time.monotonic() - started < 0.1                  # 调用方立即返回
    worker.join(5)
    assert len(calls) == 2                                   # ip-api + 美团各一次
    assert location_mod.refresh_location(ip="1.12.67.169") is None   # 10 分钟内不再重查
    assert location_mod.refresh_location(ip="127.0.0.1") is None     # 内网 IP 不查


def test_browser_coordinates_reverse_geocode_in_background(owner, fresh_location_state, monkeypatch):
    monkeypatch.setattr(location_mod, "_reverse_geocode", lambda lat, lon: (time.sleep(0.2), "深圳市")[1])
    started = time.monotonic()
    worker = location_mod.refresh_location(22.53, 113.93)
    assert time.monotonic() - started < 0.1
    worker.join(5)
    assert location_mod.get_location()["place"] == "深圳市"
    monkeypatch.setattr(location_mod, "_reverse_geocode",
                        lambda lat, lon: (_ for _ in ()).throw(AssertionError("没挪窝不该反查")))
    assert location_mod.refresh_location(22.531, 113.931) is None    # 同步就地更新，不联网
    assert location_mod.get_location()["place"] == "深圳市"


def test_chat_first_byte_does_not_wait_for_ip_location(owner, fresh_location_state, monkeypatch):
    class OneToken:
        def stream(self, *_args, **_kwargs):
            yield AIMessageChunk(content="好"), {}

        def get_state(self, *_args, **_kwargs):
            return SimpleNamespace(values={"messages": []})

    @contextmanager
    def fake_bundle(_user_id):
        yield SimpleNamespace(agent=OneToken())

    monkeypatch.setattr(server_mod, "_bundle_for", fake_bundle)
    monkeypatch.setattr(location_mod, "_get_json",
                        lambda *a, **k: (time.sleep(1.0), (_ for _ in ()).throw(TimeoutError()))[1])
    client = TestClient(server_mod.app)
    client.post("/api/login", json={"username": "admin", "password": "admin"})
    client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    started = time.monotonic()
    response = client.post("/api/chat", json={"message": "你好", "thread_id": "loc"},
                           headers={"x-real-ip": "1.12.67.169"})
    assert response.status_code == 200 and '"token"' in response.text
    assert time.monotonic() - started < 0.8                  # 此前要先等 IP 定位（两源超时）
