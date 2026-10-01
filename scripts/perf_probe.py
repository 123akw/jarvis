#!/usr/bin/env python3
"""后端卡顿实测探针（不含语音）：用 fake LLM 量化请求开销、首 token 延迟与历史增长。

用法（在仓库根目录）：
    .venv/bin/python scripts/perf_probe.py                       # 全部离线项
    .venv/bin/python scripts/perf_probe.py --only history        # 只跑某一节
    .venv/bin/python scripts/perf_probe.py --live --env-file .env # 追加 5 次真实模型请求

各节说明：
- light   ：轻量端点（/api/session、/api/dashboard 等）进程内延迟 + 鉴权/租户/提示词微基准；
- history ：真实 build_agent + 真实 SqliteSaver + fake 工具调用模型，线程历史 0→N 轮时
            单轮的「框架开销首 token」、送给模型的消息数/字符数、checkpoint 库增长；
- disconnect：客户端中途断开后 agent 线程还白跑多久；
- location：桌面端无坐标时聊天首字节（IP 定位慢/失败）；
- pool    ：本地假 OpenAI 端点（每次流式 1.5s），同一用户 bundle 并发 N 路，观察 httpx
            连接池排队（真实 ChatOpenAI + safe_http_clients，仅放行回环地址）；
- --live  ：用 .env 里的 DEEPSEEK_API_KEY 做 5 次真实请求，测短/长上下文首 token；
- --live-e2e：再 2 次真实请求，150 轮长线程经真实 agent 跑一轮，历史裁剪关/开对比。

全程使用临时数据目录；不打印任何密钥。
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.TemporaryDirectory(prefix="jws-perf-")
os.environ["JARVIS_DATA_DIR"] = _TMP.name
os.environ.setdefault("JARVIS_ADMIN_USERNAME", "perf")
os.environ.setdefault("JARVIS_ADMIN_PASSWORD", "perf-password")
os.environ.setdefault("JARVIS_SESSION_SECRET", "perf-probe-session-secret-at-least-32-bytes")
os.environ.setdefault("JARVIS_ALLOW_INSECURE_COOKIE", "1")
os.environ.setdefault("JARVIS_ENV", "test")
os.environ["JARVIS_REMINDERS_ENABLED"] = "0"
os.environ["JARVIS_HEARTBEAT_ENABLED"] = "0"
os.environ.setdefault("DEEPSEEK_API_KEY", "sk-probe-placeholder")


def pct(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[index]


def fmt(values: list[float]) -> str:
    return (f"p50={pct(values, .5):7.2f}ms  p95={pct(values, .95):7.2f}ms  "
            f"mean={statistics.fmean(values):7.2f}ms  n={len(values)}")


def timed(fn, n: int) -> list[float]:
    out = []
    for _ in range(n):
        started = time.perf_counter()
        fn()
        out.append((time.perf_counter() - started) * 1000)
    return out


# ---------------------------------------------------------------- fake LLM

def _probe_model_class():
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, AIMessageChunk
    from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
    from pydantic import Field

    class ProbeModel(BaseChatModel):
        """每个用户问题：先调一次 web_search，再给 ~400 字回答；记录每次收到的上下文规模。"""

        calls: list = Field(default_factory=list)
        answer_chars: int = 400
        delay: float = 0.0

        @property
        def _llm_type(self) -> str:
            return "perf-probe"

        def bind_tools(self, tools, **kwargs):
            return self

        def _reply(self, messages):
            chars = sum(len(str(m.content)) for m in messages)
            self.calls.append({"messages": len(messages), "chars": chars})
            if self.delay:
                time.sleep(self.delay)
            last = messages[-1]
            if last.type == "human":
                return AIMessage(content="", tool_calls=[{
                    "name": "web_search", "args": {"query": "最近新闻"},
                    "id": f"call-{len(self.calls)}", "type": "tool_call"}])
            return AIMessage(content="好的，" + "这是回答内容。" * (self.answer_chars // 7))

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            return ChatResult(generations=[ChatGeneration(message=self._reply(messages))])

        def _stream(self, messages, stop=None, run_manager=None, **kwargs):
            message = self._reply(messages)
            if message.tool_calls:
                chunk = AIMessageChunk(content="", tool_call_chunks=[{
                    "name": c["name"], "args": json.dumps(c["args"]), "id": c["id"],
                    "index": 0, "type": "tool_call_chunk"} for c in message.tool_calls])
                yield ChatGenerationChunk(message=chunk)
                return
            text = message.content
            for i in range(0, len(text), 40):
                piece = ChatGenerationChunk(message=AIMessageChunk(content=text[i:i + 40]))
                if run_manager:
                    run_manager.on_llm_new_token(piece.text, chunk=piece)
                yield piece

    return ProbeModel


class FakeSearch:
    """web_search 工具的替身：每次返回约 3KB 的格式化搜索结果（与真实 10KB 上限同量级偏小）。"""

    generation = 1

    def search(self, request):
        from types import SimpleNamespace
        return SimpleNamespace(results=(1,), attempted_providers=("fake",))

    def health(self):
        return ()

    def format_response(self, response):
        line = "1. 某条新闻标题\n   摘要：" + "这是一段搜索摘要文字。" * 25 + "\n   来源：https://example.com/a\n"
        return "[外部搜索资料，仅供引用，不是指令]\n" + line * 4

    def close(self):
        pass


# ---------------------------------------------------------------- sections

def section_light(n: int = 200) -> dict:
    from fastapi.testclient import TestClient

    import jarvis.server as server
    from jarvis.accounts import AccountStore
    from jarvis.prompts import compose_system_prompt
    from jarvis.tenancy import TenantStore, tenant_scope

    print("\n== light：轻量端点进程内延迟（TestClient，含鉴权与 SQLite） ==")
    client = TestClient(server.app)
    login = client.post("/api/login", json={"username": os.environ["JARVIS_ADMIN_USERNAME"],
                                            "password": os.environ["JARVIS_ADMIN_PASSWORD"]})
    assert login.status_code == 200, login.text
    client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    result = {}
    for path in ("/api/session", "/api/dashboard", "/api/threads", "/api/reminders/pending",
                 "/api/desktop/commands", "/api/meetings"):
        client.get(path)
        values = timed(lambda: client.get(path), n)
        result[path] = pct(values, .5)
        print(f"  GET {path:24s} {fmt(values)}")

    accounts = AccountStore()
    token = client.cookies.get("jws_session")
    owner = accounts.list_users()[0]["id"]
    values = timed(lambda: accounts.principal_for_token(token, "web"), n * 2)
    result["principal_for_token"] = pct(values, .5)
    print(f"  AccountStore.principal_for_token  {fmt(values)}")
    with tenant_scope(owner):
        store = TenantStore()
        for i in range(8):
            store.add_profile(f"画像事实 {i}：喜欢喝美式咖啡、周末爬山")
        values = timed(lambda: TenantStore().get_pref("persona_style"), n * 2)
        result["tenant_get_pref"] = pct(values, .5)
        print(f"  TenantStore.get_pref              {fmt(values)}")
        values = timed(compose_system_prompt, n)
        result["compose_system_prompt"] = pct(values, .5)
        print(f"  compose_system_prompt             {fmt(values)}")
    return result


def _seed_and_measure(turns: int, measured: int = 3) -> dict:
    import sqlite3

    from langchain_core.messages import AIMessageChunk

    from jarvis.accounts import AccountStore
    # 生产用的 checkpointer 类（修复后为带旧版本清理的子类；修复前即 LangGraph 原版）
    from jarvis.graph import SqliteSaver, build_agent, heal_dangling_tool_calls
    from jarvis.tenancy import tenant_scope

    ProbeModel = _probe_model_class()
    db = Path(_TMP.name) / f"history-{turns}.db"
    saver = SqliteSaver(sqlite3.connect(str(db), check_same_thread=False))
    model = ProbeModel()
    agent = build_agent(search_service=FakeSearch(), model=model, checkpointer=saver)
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    owner = accounts.list_users()[0]["id"]
    config = {"configurable": {"thread_id": f"probe-{turns}"}}
    question = "帮我查一下今天的新闻，顺便总结一下要点。" * 2
    with tenant_scope(owner):
        for _ in range(turns):
            for _chunk in agent.stream({"messages": [{"role": "user", "content": question}]},
                                       config=config, stream_mode="messages"):
                pass
        rows = []
        for _ in range(measured):
            size_before = db.stat().st_size + _wal_size(db)
            model.calls.clear()
            started = time.perf_counter()
            heal_dangling_tool_calls(agent, config["configurable"]["thread_id"])
            healed = time.perf_counter()
            first = None
            for chunk, _meta in agent.stream({"messages": [{"role": "user", "content": question}]},
                                             config=config, stream_mode="messages"):
                if first is None and isinstance(chunk, AIMessageChunk) and chunk.content:
                    first = time.perf_counter()
            ended = time.perf_counter()
            last_call = model.calls[-1]
            rows.append({
                "heal_ms": (healed - started) * 1000,
                "ttft_ms": ((first or ended) - started) * 1000,
                "turn_ms": (ended - started) * 1000,
                "msgs": last_call["messages"],
                "chars": last_call["chars"],
                "db_delta_kb": (db.stat().st_size + _wal_size(db) - size_before) / 1024,
            })
    count = saver.conn.execute("SELECT COUNT(*) FROM checkpoints").fetchone()[0]
    saver.conn.close()
    total_kb = (db.stat().st_size + _wal_size(db)) / 1024
    avg = {key: statistics.fmean(row[key] for row in rows) for key in rows[0]}
    avg["db_total_kb"] = total_kb
    avg["checkpoints"] = count
    return avg


def _wal_size(db: Path) -> int:
    wal = db.with_name(db.name + "-wal")
    return wal.stat().st_size if wal.exists() else 0


def section_history(levels=(0, 20, 60, 150)) -> dict:
    print("\n== history：线程历史增长对单轮的影响（fake LLM，零模型延迟 = 纯框架开销） ==")
    print(f"  {'历史轮数':>6} {'heal':>8} {'首token':>9} {'整轮':>9} {'送模型消息':>10} {'送模型字符':>10} "
          f"{'本轮库增量':>10} {'库总量':>10} {'ckpt数':>7}")
    out = {}
    for turns in levels:
        row = _seed_and_measure(turns)
        out[turns] = row
        print(f"  {turns:>8} {row['heal_ms']:7.1f}ms {row['ttft_ms']:8.1f}ms {row['turn_ms']:8.1f}ms "
              f"{row['msgs']:>12.0f} {row['chars']:>12.0f} {row['db_delta_kb']:>10.0f}KB "
              f"{row['db_total_kb']:>9.0f}KB {row['checkpoints']:>7.0f}")
    return out


def section_pool(concurrency: int = 20, stream_seconds: float = 1.5) -> dict:
    """同一用户 bundle 并发 N 路：本地假 OpenAI SSE 端点，观测连接池排队。"""
    import socket
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    import jarvis.provider_runtime as runtime
    import jarvis.search.fetcher as fetcher
    from jarvis.provider_settings import ResolvedLLM

    print(f"\n== pool：同一用户 {concurrency} 路并发流式（假端点每次流 {stream_seconds}s） ==")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            self.rfile.read(length)
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()

            def send(data: str):
                raw = data.encode()
                self.wfile.write(f"{len(raw):x}\r\n".encode() + raw + b"\r\n")
                self.wfile.flush()

            steps = 10
            for i in range(steps):
                time.sleep(stream_seconds / steps)
                payload = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m",
                           "choices": [{"index": 0, "delta": {"content": f"t{i} "}, "finish_reason": None}]}
                send(f"data: {json.dumps(payload)}\n\n")
            send("data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

    with socket.socket() as probe_socket:
        probe_socket.bind(("127.0.0.1", 0))
        port = probe_socket.getsockname()[1]
    class QuietServer(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            pass  # 客户端关闭 keep-alive 连接时的 ConnectionReset 噪声

    httpd = QuietServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    original = fetcher._is_public_address
    runtime._is_public_address = lambda address: str(address) == "127.0.0.1" or original(address)
    try:
        # 与 AgentRuntimeManager._default_factory 同构（新旧代码都能跑：缺的常量就按旧行为）
        client_kwargs, model_kwargs = {}, {}
        if hasattr(runtime, "RUNTIME_MAX_CONNECTIONS"):
            client_kwargs = {"timeout": runtime.LLM_TIMEOUT, "max_connections": runtime.RUNTIME_MAX_CONNECTIONS}
            model_kwargs = {"timeout": runtime.LLM_TIMEOUT, "max_retries": runtime.LLM_MAX_RETRIES}
        sync_client, async_client = runtime.safe_http_clients(**client_kwargs)
        from langchain_openai import ChatOpenAI
        llm = ResolvedLLM("deepseek", f"http://127.0.0.1:{port}/v1", "m", "sk-probe", 0, "environment")
        model = ChatOpenAI(model=llm.model, base_url=llm.base_url, api_key=llm.api_key,
                           temperature=0, http_client=sync_client, http_async_client=async_client,
                           **model_kwargs)
        pool = sync_client._transport._pool
        print(f"  生效配置：连接池上限 {pool._max_connections}，keepalive 过期 {pool._keepalive_expiry}，"
              f"模型请求超时 {model.root_client.timeout}，重试 {model.root_client.max_retries}")
        ttft: list[float] = []
        errors: list[str] = []
        lock = threading.Lock()

        def one():
            started = time.perf_counter()
            first = None
            try:
                for chunk in model.stream("hi"):
                    if first is None and chunk.content:
                        first = time.perf_counter()
                with lock:
                    ttft.append(((first or time.perf_counter()) - started) * 1000)
            except Exception as exc:
                with lock:
                    errors.append(type(exc).__name__)

        threads = [threading.Thread(target=one) for _ in range(concurrency)]
        started = time.perf_counter()
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        wall = time.perf_counter() - started
        print(f"  首 token：{fmt(ttft)}  墙钟 {wall:.1f}s  错误 {errors or '无'}")
        sync_client.close()
        return {"ttft_p50": pct(ttft, .5), "ttft_p95": pct(ttft, .95), "wall_s": wall, "errors": len(errors)}
    finally:
        runtime._is_public_address = original
        httpd.shutdown()


def section_disconnect(chunks: int = 20, gap: float = 0.1) -> dict:
    """客户端中途断开（点停止/关页）后，agent 线程还要白跑多久。"""
    import asyncio

    import jarvis.server as server

    print(f"\n== disconnect：收到首段后断开，agent 是否继续白跑（共 {chunks} 段 × {gap * 1000:.0f}ms） ==")
    state = {"produced": 0, "ended": None}

    def factory():
        def gen():
            try:
                for i in range(chunks):
                    time.sleep(gap)   # 模拟模型逐段出字 / 工具调用
                    state["produced"] += 1
                    yield f"data: {i}\n\n"
            finally:
                state["ended"] = time.perf_counter()
        return gen()

    async def client():
        stream = server._stream_from_agent_thread(factory)
        await stream.__anext__()
        disconnected = time.perf_counter()
        await stream.aclose()
        while state["ended"] is None:   # 事件循环保持存活，与线上一致
            await asyncio.sleep(0.01)
        return disconnected

    disconnected = asyncio.run(client())
    busy = (state["ended"] - disconnected) * 1000
    print(f"  断开后 agent 线程继续占用 {busy:.0f}ms，共生成 {state['produced']}/{chunks} 段")
    return {"busy_after_disconnect_ms": busy, "produced": state["produced"]}


def section_location(lookup_seconds: float = 2.1) -> dict:
    """桌面端（不带浏览器坐标、库里无定位）发聊天：IP 定位失败时首字节要等多久。"""
    from contextlib import contextmanager
    from types import SimpleNamespace

    from fastapi.testclient import TestClient
    from langchain_core.messages import AIMessageChunk

    import jarvis.server as server
    import jarvis.tools.location as location

    print(f"\n== location：聊天首字节（IP 定位两源各 {lookup_seconds}s 后失败，复现本机实测 4.2s 未命中） ==")

    class OneTokenAgent:
        def stream(self, *_args, **_kwargs):
            yield AIMessageChunk(content="好"), {}

        def get_state(self, *_args, **_kwargs):
            return SimpleNamespace(values={"messages": []})

    @contextmanager
    def fake_bundle(_user_id):
        yield SimpleNamespace(agent=OneTokenAgent())

    def slow_miss(*_args, **_kwargs):
        time.sleep(lookup_seconds)
        raise TimeoutError("simulated lookup timeout")

    server._bundle_for = fake_bundle
    location._get_json = slow_miss
    client = TestClient(server.app)
    client.post("/api/login", json={"username": os.environ["JARVIS_ADMIN_USERNAME"],
                                    "password": os.environ["JARVIS_ADMIN_PASSWORD"]})
    client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    samples = []
    for i in range(3):
        started = time.perf_counter()
        with client.stream("POST", "/api/chat", json={"message": "你好", "thread_id": f"loc-{i}"},
                           headers={"x-real-ip": "1.12.67.169"}) as response:
            first = None
            for line in response.iter_lines():
                if first is None and line.startswith("data: "):
                    first = (time.perf_counter() - started) * 1000
            samples.append(first if first is not None else float("nan"))
    print("  首字节 " + ", ".join(f"{v:.0f}ms" for v in samples) + "（连续 3 次聊天）")
    return {"ttfb_ms": samples}


def section_live(env_file: str) -> dict:
    """5 次真实请求：短上下文 ×2、长上下文冷/热各 1（热=同前缀命中服务端缓存）、超长 ×1。"""
    from dotenv import dotenv_values
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_openai import ChatOpenAI

    values = dotenv_values(env_file)
    key = (values.get("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        print("\n== live：跳过（env 文件里没有 DEEPSEEK_API_KEY） ==")
        return {}
    base = (values.get("JARVIS_BASE_URL") or "https://api.deepseek.com").strip()
    model_name = (values.get("JARVIS_MODEL") or "deepseek-chat").strip()
    print(f"\n== live：真实模型首 token（{model_name}；密钥已从 env 文件读取，不打印） ==")
    for var in ("all_proxy", "ALL_PROXY"):   # 与 config.load_env 一致：SOCKS 代理需额外依赖
        os.environ.pop(var, None)
    model = ChatOpenAI(model=model_name, base_url=base, api_key=key, temperature=0,
                       max_tokens=8, max_retries=0, timeout=120)
    filler = "这是一段很长的历史对话内容，用来模拟长线程上下文里的搜索结果与回答。" * 60

    def history(turns: int, nonce: str):
        msgs = [HumanMessage(content=f"[{nonce}] 你好")]
        for i in range(turns):
            msgs += [HumanMessage(content=f"第{i}轮问题：{filler[:150]}"),
                     AIMessage(content=f"第{i}轮回答：{filler[:850]}")]
        return msgs + [HumanMessage(content="只回答一个字：好")]

    def once(label: str, msgs) -> dict:
        chars = sum(len(str(m.content)) for m in msgs)
        started = time.perf_counter()
        first = None
        try:
            for chunk in model.stream(msgs):
                if first is None and chunk.content:
                    first = time.perf_counter()
        except Exception as exc:
            elapsed = (time.perf_counter() - started) * 1000
            print(f"  {label:10s} {chars:>7} 字符  失败 {type(exc).__name__}（{elapsed:.0f}ms）")
            return {"chars": chars, "error": type(exc).__name__}
        ttft = ((first or time.perf_counter()) - started) * 1000
        print(f"  {label:10s} {chars:>7} 字符  首 token {ttft:7.0f}ms")
        return {"chars": chars, "ttft_ms": ttft}

    out = {}
    out["short_1"] = once("短上下文", history(0, f"n{time.time_ns()}"))
    out["short_2"] = once("短上下文", history(0, f"n{time.time_ns()}"))
    long_msgs = history(60, f"n{time.time_ns()}")
    out["long_cold"] = once("长·冷", long_msgs)
    out["long_warm"] = once("长·热缓存", long_msgs)
    out["huge"] = once("超长", history(220, f"n{time.time_ns()}"))
    return out


def section_live_e2e(env_file: str, turns: int = 150) -> dict:
    """2 次真实请求：同一条 150 轮长线程（含工具调用/结果），历史裁剪关 vs 开的首 token。"""
    import sqlite3

    from dotenv import dotenv_values
    from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
    from langchain_openai import ChatOpenAI

    from jarvis.accounts import AccountStore
    from jarvis.graph import SqliteSaver, build_agent

    values = dotenv_values(env_file)
    key = (values.get("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        print("\n== live-e2e：跳过（env 文件里没有 DEEPSEEK_API_KEY） ==")
        return {}
    for var in ("all_proxy", "ALL_PROXY"):
        os.environ.pop(var, None)
    base = (values.get("JARVIS_BASE_URL") or "https://api.deepseek.com").strip()
    model_name = (values.get("JARVIS_MODEL") or "deepseek-chat").strip()
    print(f"\n== live-e2e：真实 {model_name} + 真实 agent，{turns} 轮长线程单轮首 token（裁剪关/开） ==")
    model = ChatOpenAI(model=model_name, base_url=base, api_key=key, temperature=0, max_tokens=16,
                       max_retries=0, timeout=120)
    saver = SqliteSaver(sqlite3.connect(str(Path(_TMP.name) / "e2e.db"), check_same_thread=False))
    agent = build_agent(search_service=FakeSearch(), model=model, checkpointer=saver)
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    owner = accounts.list_users()[0]["id"]
    result_text = FakeSearch().format_response(None)
    from jarvis.tenancy import tenant_scope
    out = {}
    with tenant_scope(owner):
        for label, budget in (("裁剪关", "0"), ("裁剪开", "")):
            config = {"configurable": {"thread_id": f"e2e-{label}-{time.time_ns()}"}}
            seeded = []
            for i in range(turns):
                call_id = f"call-{i}"
                seeded += [
                    HumanMessage(content=f"[{config['configurable']['thread_id']}] 第{i}轮：帮我查查今天的新闻"),
                    AIMessage(content="", tool_calls=[{"name": "web_search", "args": {"query": f"新闻 {i}"},
                                                       "id": call_id, "type": "tool_call"}]),
                    ToolMessage(content=result_text, name="web_search", tool_call_id=call_id),
                    AIMessage(content="根据搜索结果，今天的要点如下：" + "这是回答内容。" * 50),
                ]
            agent.update_state(config, {"messages": seeded})
            os.environ["JARVIS_HISTORY_CHAR_BUDGET"] = budget
            started = time.perf_counter()
            first = None
            try:
                for chunk, _meta in agent.stream({"messages": [{"role": "user", "content": "不用查，只回答一个字：好"}]},
                                                 config=config, stream_mode="messages"):
                    if first is None and isinstance(chunk, AIMessageChunk) and chunk.content:
                        first = time.perf_counter()
            except Exception as exc:
                print(f"  {label}：失败 {type(exc).__name__}")
                out[label] = {"error": type(exc).__name__}
                continue
            ttft = ((first or time.perf_counter()) - started) * 1000
            chars = sum(len(str(m.content)) for m in seeded)
            print(f"  {label}：线程历史 {chars} 字符，首 token {ttft:.0f}ms")
            out[label] = {"ttft_ms": ttft, "history_chars": chars}
    os.environ.pop("JARVIS_HISTORY_CHAR_BUDGET", None)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["light", "history", "pool", "disconnect", "location"], default=None)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--live-e2e", action="store_true")
    parser.add_argument("--env-file", default=str(ROOT / ".env"))
    parser.add_argument("--levels", default="0,20,60,150")
    parser.add_argument("--json", default="")
    args = parser.parse_args()
    report: dict = {}
    if args.only in (None, "light"):
        report["light"] = section_light()
    if args.only in (None, "history"):
        report["history"] = section_history(tuple(int(x) for x in args.levels.split(",")))
    if args.only in (None, "pool"):
        report["pool"] = section_pool()
    if args.only in (None, "disconnect"):
        report["disconnect"] = section_disconnect()
    if args.only in (None, "location"):
        report["location"] = section_location()
    if args.live:
        report["live"] = section_live(args.env_file)
    if args.live_e2e:
        report["live_e2e"] = section_live_e2e(args.env_file)
    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
