"""第二十轮·用量记账与配额（jarvis/usage.py 的核心）：kind_scope、模型回调记 token（含经 LangGraph 流式）、
按天按类别累加与费用估算、内存攒批落库（失败放回、账号删了丢掉）、配额（Owner 不限 / 默认 / 自定义 / 不限）、
用尽告警每天一次、告警合并与推送、渠道断线巡检、运行时挂回调。"""
import datetime as dt
import sqlite3
from typing import Iterator

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult, LLMResult

from jarvis import usage
from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantStore


@pytest.fixture(autouse=True)
def clean_usage(monkeypatch):
    """每条测试独立的用量状态：清内存账本与「今天告过警」记录，不起后台落库线程，推送同步执行。"""
    usage._ledger.clear()
    usage._quota_alerted.clear()
    monkeypatch.setattr(usage._ledger, "_ensure_thread", lambda: None)
    monkeypatch.setattr(usage, "_notify", None)
    monkeypatch.setattr(usage, "_spawn", lambda work: work())
    for name in ("JARVIS_PRICE_INPUT_PER_M", "JARVIS_PRICE_OUTPUT_PER_M", "JARVIS_PRICE_CACHED_INPUT_PER_M",
                 "JARVIS_DEFAULT_DAILY_MODEL_CALLS", "JARVIS_DEFAULT_DAILY_FLOW_RUNS", "JARVIS_STREAM_USAGE"):
        monkeypatch.delenv(name, raising=False)
    yield
    usage._ledger.clear()


@pytest.fixture()
def accounts():
    store = AccountStore()
    store._ensure_bootstrap()
    return store


@pytest.fixture()
def owner_id(accounts):
    return accounts.unique_active_owner().user_id


@pytest.fixture()
def member_id(accounts):
    return accounts.create_user("bob", "Bob-pass-12345", "Member")["id"]


def _rows(owner=None):
    with TenantStore()._connect() as c:
        sql = "SELECT owner_id, day, kind, calls, input_tokens, output_tokens, failures, cost_micros FROM usage_daily"
        rows = c.execute(sql + (" WHERE owner_id=?" if owner else "") + " ORDER BY day, kind",
                         (owner,) if owner else ()).fetchall()
    return [dict(row) for row in rows]


def _alerts():
    with TenantStore()._connect() as c:
        return [dict(row) for row in c.execute("SELECT * FROM admin_alerts ORDER BY created_at, id")]


class FakeModel(BaseChatModel):
    """替身模型：invoke 回 usage_metadata；流式最后一块带用量（同 stream_usage 的服务商）。"""

    reply_usage: dict = {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150}

    @property
    def _llm_type(self) -> str:
        return "fake-usage"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        message = AIMessage(content="好的", usage_metadata=self.reply_usage)
        return ChatResult(generations=[ChatGeneration(message=message)])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs) -> Iterator[ChatGenerationChunk]:
        for text in ("你", "好"):
            yield ChatGenerationChunk(message=AIMessageChunk(content=text))
        yield ChatGenerationChunk(message=AIMessageChunk(content="", usage_metadata={
            "input_tokens": 1000, "output_tokens": 50, "total_tokens": 1050,
            "input_token_details": {"cache_read": 800}}))


# ---------- 类别 ----------

def test_kind_scope_defaults_nests_and_resets():
    assert usage.current_kind() == "chat"
    with usage.kind_scope("flow"):
        assert usage.current_kind() == "flow"
        with usage.kind_scope("compose"):
            assert usage.current_kind() == "compose"
        assert usage.current_kind() == "flow"
    assert usage.current_kind() == "chat"
    with usage.kind_scope("flow_run"):          # 保留给流程运行次数，模型调用不能记进去
        assert usage.current_kind() == "other"
    with usage.kind_scope("../x"):
        assert usage.current_kind() == "other"
    with pytest.raises(RuntimeError):
        with usage.kind_scope("voice"):
            raise RuntimeError("boom")
    assert usage.current_kind() == "chat"       # 出异常也复原


# ---------- 回调记账 ----------

def test_callback_records_invoke_and_stream_with_kind(owner_id):
    model = FakeModel(callbacks=[usage.UsageCallback(owner_id)])
    model.invoke([HumanMessage(content="hi")])
    with usage.kind_scope("flow"):
        list(model.stream([HumanMessage(content="hi")]))
    usage.flush()
    today = dt.date.today().isoformat()
    rows = {row["kind"]: row for row in _rows(owner_id)}
    assert rows["chat"]["day"] == today and rows["chat"]["calls"] == 1
    assert (rows["chat"]["input_tokens"], rows["chat"]["output_tokens"]) == (120, 30)
    assert rows["chat"]["cost_micros"] == 120 * 2 + 30 * 3                 # 默认 2 / 3 元每百万 token
    assert (rows["flow"]["input_tokens"], rows["flow"]["output_tokens"]) == (1000, 50)
    assert rows["flow"]["cost_micros"] == 200 * 2 + 800 * 0.2 + 50 * 3      # 命中缓存的 800 按 0.2 元


def test_callback_counts_agent_stream_through_langgraph(owner_id):
    """真实路径：create_react_agent + stream_mode=messages（网页 / 飞书 / 语音都这样调），类别跟着走。"""
    from langgraph.prebuilt import create_react_agent

    agent = create_react_agent(FakeModel(callbacks=[usage.UsageCallback(owner_id)]), [])
    with usage.kind_scope("voice"):
        chunks = list(agent.stream({"messages": [{"role": "user", "content": "在吗"}]}, stream_mode="messages"))
    assert chunks
    usage.flush()
    [row] = _rows(owner_id)
    assert row["kind"] == "voice" and row["calls"] == 1 and row["input_tokens"] == 1000 and row["output_tokens"] == 50


def test_callback_falls_back_to_llm_output_and_records_errors(owner_id):
    callback = usage.UsageCallback(owner_id)
    result = LLMResult(generations=[[ChatGeneration(message=AIMessage(content="x"))]],
                       llm_output={"token_usage": {"prompt_tokens": 40, "completion_tokens": 10,
                                                   "prompt_tokens_details": {"cached_tokens": 30}}})
    assert usage.tokens_from_result(result) == (40, 10, 30)
    callback.on_llm_end(result)
    callback.on_llm_error(RuntimeError("upstream"))
    callback.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(content="no usage"))]]))
    callback.on_llm_end(object())                         # 怪东西：只记日志，不抛
    usage.flush()
    [row] = _rows(owner_id)
    assert row["calls"] == 3 and row["failures"] == 1     # 失败只记 failures，不占配额
    assert (row["input_tokens"], row["output_tokens"]) == (40, 10)
    assert row["cost_micros"] == 10 * 2 + 30 * 0.2 + 10 * 3


def test_cost_estimate_uses_env_prices(monkeypatch):
    monkeypatch.setenv("JARVIS_PRICE_INPUT_PER_M", "4")
    monkeypatch.setenv("JARVIS_PRICE_OUTPUT_PER_M", "16")
    prices = usage.pricing()
    assert prices["input_per_m"] == 4 and prices["output_per_m"] == 16 and prices["cached_input_per_m"] == 0.4
    assert "估算" in prices["note"]
    assert usage.cost_micros(1_000_000, 1_000_000) == 20_000_000           # 4 + 16 元
    assert usage.cost_micros(100, 0, cached_tokens=500) == 40               # 缓存数大于输入：按输入封顶
    monkeypatch.setenv("JARVIS_PRICE_INPUT_PER_M", "abc")
    assert usage.pricing()["input_per_m"] == usage.DEFAULT_PRICE_INPUT


# ---------- 攒批落库 ----------

def test_records_buffer_then_flush_accumulates_per_day(owner_id, monkeypatch):
    monkeypatch.setattr(usage, "_clock", lambda: dt.datetime(2026, 10, 3, 23, 59))
    usage.record_model_call(owner_id, 10, 5)
    usage.record_model_call(owner_id, 10, 5)
    usage.record_flow_run(owner_id, True)
    usage.record_flow_run(owner_id, False)
    assert _rows(owner_id) == []                                 # 还在内存里
    assert usage.usage_status(owner_id)["today"] == {"calls": 2, "flow_runs": 2}   # 配额照算内存里的
    assert usage.flush() == 2 and usage.flush() == 0
    monkeypatch.setattr(usage, "_clock", lambda: dt.datetime(2026, 10, 4, 0, 1))   # 过了零点：记到新的一天
    usage.record_model_call(owner_id, 1, 1)
    usage.flush()
    usage.record_model_call(owner_id, 1, 1)
    usage.flush()                                                 # 同一格再写：累加不覆盖
    rows = [(r["day"], r["kind"], r["calls"], r["input_tokens"], r["failures"]) for r in _rows(owner_id)]
    assert rows == [("2026-10-03", "chat", 2, 20, 0), ("2026-10-03", "flow_run", 2, 0, 1),
                    ("2026-10-04", "chat", 2, 2, 0)]


def test_flush_retries_on_locked_db_and_drops_deleted_accounts(owner_id, monkeypatch):
    usage.record_model_call(owner_id, 7, 7)
    calls = {"n": 0}
    original = usage._Ledger._write

    def flaky(path, items):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return original(path, items)

    monkeypatch.setattr(usage._Ledger, "_write", staticmethod(flaky))
    assert usage.flush() == 0 and _rows(owner_id) == []          # 锁住了：放回去
    usage.record_model_call("ghost-user", 1, 1)                   # 账号不存在（外键失败）：丢掉这一格
    usage.flush()
    assert [r["input_tokens"] for r in _rows(owner_id)] == [7]
    assert _rows("ghost-user") == [] and usage.flush() == 0


def test_shutdown_flushes_pending(owner_id):
    usage.record_model_call(owner_id, 3, 4)
    usage.shutdown()
    assert _rows(owner_id)[0]["calls"] == 1


# ---------- 配额 ----------

def test_owner_is_unlimited(owner_id, monkeypatch):
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "0")
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_FLOW_RUNS", "0")
    assert usage.check_model(owner_id) is None and usage.check_flow_run(owner_id) is None
    status = usage.usage_status(owner_id)
    assert status["quota"]["source"] == "unlimited" and status["remaining"] == {"calls": None, "flow_runs": None}


def test_member_default_custom_and_unlimited_quota(member_id, monkeypatch):
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "2")
    for _ in range(2):
        assert usage.check_model(member_id) is None
        usage.record_model_call(member_id, 1, 1)
    assert usage.check_model(member_id) == usage.MODEL_QUOTA_MESSAGE == "今天的用量到上限了，明天再来，或请管理员调高"
    status = usage.usage_status(member_id)
    assert status["quota"]["daily_model_calls"] == 2 and status["quota"]["source"] == "default"
    assert status["remaining"]["calls"] == 0 and status["remaining"]["flow_runs"] == 100   # 流程用默认 100
    usage.set_quota(member_id, {"daily_model_calls": 5})
    assert usage.check_model(member_id) is None                       # 调高了就能用
    view = usage.usage_status(member_id)["quota"]
    assert view["source"] == "custom" and view["sources"] == {"daily_model_calls": "custom", "daily_flow_runs": "default"}
    usage.set_quota(member_id, {"daily_model_calls": -1, "daily_flow_runs": 0})
    assert usage.check_model(member_id) is None
    assert usage.check_flow_run(member_id) == usage.FLOW_QUOTA_MESSAGE   # 0 = 一次都不让跑
    view = usage.usage_status(member_id)["quota"]
    assert view["daily_model_calls"] is None and view["source"] == "custom"           # 自定义比不限更具体
    usage.set_quota(member_id, {"daily_flow_runs": None})
    assert usage.usage_status(member_id)["quota"]["source"] == "unlimited"             # 不限 + 默认 → 不限
    usage.set_quota(member_id, {"daily_model_calls": None, "daily_flow_runs": None})   # 都回默认：删掉这行
    with TenantStore()._connect() as c:
        assert c.execute("SELECT COUNT(*) FROM tenant_quotas").fetchone()[0] == 0


def test_flow_quota_counts_runs_not_model_calls(member_id, monkeypatch):
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_FLOW_RUNS", "1")
    usage.record_model_call(member_id, 5, 5)
    assert usage.check_flow_run(member_id) is None
    usage.record_flow_run(member_id, False)
    assert usage.check_flow_run(member_id) == usage.FLOW_QUOTA_MESSAGE
    assert usage.check_model(member_id) is None


def test_quota_check_fails_open_and_ignores_unknown_accounts(member_id, monkeypatch):
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "0")
    assert usage.check_model("") is None and usage.check_model("no-such-user") is None
    monkeypatch.setattr(usage, "usage_status", lambda _uid: (_ for _ in ()).throw(sqlite3.OperationalError("locked")))
    assert usage.check_model(member_id) is None                       # 配额本身坏了不拦人


def test_quota_exhausted_alerts_owner_once_per_day(member_id, owner_id, monkeypatch):
    pushed = []
    monkeypatch.setattr(usage, "_notify", lambda uid, text: pushed.append((uid, text)))
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_MODEL_CALLS", "0")
    for _ in range(3):
        assert usage.check_model(member_id)
    [row] = _alerts()
    assert row["kind"] == "quota_exhausted" and row["owner_id"] == member_id
    assert row["title"] == "「bob」今天的模型调用次数用完了" and "上限 0 次" in row["detail"]
    assert pushed == [(owner_id, "管理提醒：「bob」今天的模型调用次数用完了（今天已用 0 次，上限 0 次。明天自动恢复，也可以在管理后台调高。）")]
    usage._quota_alerted.clear()                                      # 模拟重启：库里今天已有，不再发
    assert usage.check_model(member_id)
    assert len(_alerts()) == 1 and len(pushed) == 1
    monkeypatch.setenv("JARVIS_DEFAULT_DAILY_FLOW_RUNS", "0")
    assert usage.check_flow_run(member_id)                             # 流程配额用尽：另一条（标题不同不合并）
    assert sorted(r["title"] for r in _alerts()) == ["「bob」今天的模型调用次数用完了", "「bob」今天的流程运行次数用完了"]


# ---------- 告警 ----------

def test_alert_merges_same_title_within_an_hour_and_caps_distinct(owner_id, member_id, monkeypatch):
    pushed = []
    monkeypatch.setattr(usage, "_notify", lambda uid, text: pushed.append(text))
    now = {"t": dt.datetime(2026, 10, 3, 9, 0)}
    monkeypatch.setattr(usage, "_clock", lambda: now["t"])
    usage.alert("flow_paused", "定时流程「早报」已自动暂停", "模型超时", owner_id=member_id)
    usage.mark_alerts_read(all_=True)
    now["t"] += dt.timedelta(minutes=30)
    usage.alert("flow_paused", "定时流程「早报」已自动暂停", "模型又超时", owner_id=member_id)   # 同标题：合并
    usage.alert("flow_paused", "定时流程「早报」已自动暂停", owner_id=owner_id)              # 不同账号：单独一条
    usage.alert("channel_down", "飞书长连接断开超过 5 分钟")           # 系统级（没有账号）
    usage.alert("channel_down", "飞书长连接断开超过 5 分钟", "又断了")
    usage.alert("channel_down", "微信长连接断开超过 5 分钟")           # 同类不同标题：飞书、微信各一条
    rows = _alerts()
    assert len(rows) == 4
    merged = next(r for r in rows if r["owner_id"] == member_id)
    assert merged["detail"] == "模型又超时" and merged["read_at"] is None    # 又发生了：重新标未读
    assert len(pushed) == 4                                            # 合并的那几次不再推送
    for name in ("晚报", "周报", "月报", "年报"):                     # 同类同账号 1 小时最多 3 条不同标题
        usage.alert("flow_failed", f"定时流程「{name}」连续 2 次没跑成", owner_id=member_id)
    failed = [r for r in _alerts() if r["kind"] == "flow_failed"]
    assert len(failed) == 3 and any(r["title"] == "定时流程「年报」连续 2 次没跑成" for r in failed)
    assert len(pushed) == 7
    now["t"] += dt.timedelta(minutes=61)
    usage.alert("flow_paused", "定时流程「早报」已自动暂停", owner_id=member_id)   # 过了 1 小时：新的一条
    assert len(_alerts()) == 8 and len(pushed) == 8
    view = usage.list_alerts(10)
    assert view["unread"] == 8 and view["alerts"][0]["owner"] == {"id": member_id, "username": "bob"}
    assert next(a for a in view["alerts"] if a["kind"] == "channel_down")["owner"] is None
    assert usage.mark_alerts_read([view["alerts"][0]["id"]]) == 7


def test_alert_never_raises_and_cleans_input(owner_id, monkeypatch):
    def broken(uid, text):
        raise RuntimeError("push down")
    monkeypatch.setattr(usage, "_notify", broken)
    usage.alert("Bad Kind!", "  标题\n换行 ", "x" * 5000)
    [row] = _alerts()
    assert row["kind"] == "other" and row["title"] == "标题 换行" and len(row["detail"]) == 1000
    monkeypatch.setattr(usage, "TenantStore", lambda: (_ for _ in ()).throw(sqlite3.OperationalError("disk")))
    usage.alert("x", "写不进去也不抛")


# ---------- 渠道巡检 ----------

def test_channel_probes():
    assert usage.feishu_down({"configured": False, "state": "error"}) == (False, "")
    assert usage.feishu_down({"configured": True, "state": "connected"}) == (False, "")
    assert usage.feishu_down({"configured": True, "state": "stopped"}) == (False, "")
    assert usage.feishu_down({"configured": True, "state": "reconnecting", "error": "长连接已断开，正在重连"}) == \
        (True, "长连接已断开，正在重连")
    assert usage.wechat_down({"state": "idle", "error": ""}) == (False, "")          # 自己断开 / 没连
    assert usage.wechat_down({"state": "idle", "error": "微信登录态失效，请重新扫码"})[0] is True
    assert usage.wechat_down({"state": "connected", "error": ""}, 0.0) == (False, "")
    assert usage.wechat_down({"state": "connected", "error": ""}, 42.0)[0] is True


def test_channel_watch_alerts_after_five_minutes_once(owner_id, monkeypatch):
    fired = []
    monkeypatch.setattr(usage, "alert", lambda kind, title, detail="", **kw: fired.append((kind, title)))
    clock = {"t": 1000.0}
    state = {"down": True}
    watch = usage.ChannelWatch(clock=lambda: clock["t"])
    watch.channels = {"feishu": lambda: (state["down"], "长连接已断开"), "broken": lambda: 1 / 0}
    assert watch.tick() == []
    clock["t"] += 299
    assert watch.tick() == []
    clock["t"] += 2
    assert watch.tick() == ["feishu"] and fired == [("channel_down", "飞书长连接断开超过 5 分钟")]
    clock["t"] += 600
    assert watch.tick() == []                     # 一直断着：不重复
    state["down"] = False
    watch.tick()                                  # 恢复
    state["down"] = True
    watch.tick()
    clock["t"] += 301
    assert watch.tick() == ["feishu"] and len(fired) == 2   # 恢复后再断：再告一次


def test_wechat_poll_failures_are_tracked(monkeypatch):
    from jarvis import wechat
    bridge = wechat.WeChatBridge()
    assert bridge.poll_failing_seconds() == 0.0
    bridge._poll_failing_since = usage.time.monotonic() - 400
    assert bridge.poll_failing_seconds() >= 399


# ---------- 运行时挂回调 ----------

def test_default_runtime_model_carries_usage_callback(owner_id):
    from jarvis.provider_runtime import AgentRuntimeManager
    from jarvis.provider_settings import ResolvedLLM

    class Store:
        def integration_values(self):
            return {name: {"enabled": False, "base_url": "", "api_key": ""}
                    for name in ("searxng", "tavily", "pandascore")}

    manager = AgentRuntimeManager(Store(), checkpointer=object())
    llm = ResolvedLLM("openai", "https://api.deepseek.com/v1", "m", "sk-test", 1, "managed")
    import jarvis.provider_runtime as pr
    original = pr.build_agent
    pr.build_agent = lambda **kwargs: object()
    try:
        bundle = manager._default_factory(owner_id, llm, Store().integration_values())
    finally:
        pr.build_agent = original
    try:
        [callback] = [cb for cb in bundle.model.callbacks if isinstance(cb, usage.UsageCallback)]
        assert callback.user_id == owner_id and bundle.model.stream_usage is True
    finally:
        bundle.close()


def test_stream_usage_only_for_known_providers_unless_forced(monkeypatch):
    """第二十轮：自己接的不认 stream_options 的服务商不带这个参数，免得整轮对话失败。"""
    from jarvis import usage
    monkeypatch.delenv("JARVIS_STREAM_USAGE", raising=False)
    assert usage.stream_usage_enabled("https://api.deepseek.com/v1") is True
    assert usage.stream_usage_enabled("https://dashscope.aliyuncs.com/compatible-mode/v1") is True
    assert usage.stream_usage_enabled("https://llm.example.internal/v1") is False
    monkeypatch.setenv("JARVIS_STREAM_USAGE", "1")
    assert usage.stream_usage_enabled("https://llm.example.internal/v1") is True
    monkeypatch.setenv("JARVIS_STREAM_USAGE", "0")
    assert usage.stream_usage_enabled("https://api.deepseek.com/v1") is False
