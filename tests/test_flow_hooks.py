"""第二十轮 §4.2：消息触发——handle_message 的命中规则与回复内容，以及飞书 / 微信在交给对话前的分流。

运行用替身（run_headless 的 source / waiting / quota 归引擎代理）；流程与触发设置存在真实的库里。"""
import threading
import time
from types import SimpleNamespace

import pytest

from jarvis import wechat
from jarvis.accounts import AccountStore
from jarvis.channels.feishu.api import FeishuAPI
from jarvis.channels.feishu.bindings import BindingStore
from jarvis.channels.feishu.bridge import FeishuBridge, FeishuSettings
from jarvis.flows import engine, hooks
from jarvis.flows.graph import validate_graph
from jarvis.flows.store import FlowStore
from jarvis.tenancy import TenantStore, tenant_scope

from feishu_fakes import APP_ID, APP_SECRET, FakeAgent, FakeFeishu, bot_mention, bundle_for_agent, message_event

FIELDS = [{"key": "note", "label": "内容", "type": "paragraph", "required": True},
          {"key": "doc", "label": "附件", "type": "file"}]
OK = {"status": "ok", "run_id": "r1", "error": "",
      "output": {"text": "## 已记账\n- 午饭 35 元", "page_url": "/r/tok123",
                 "links": [{"label": "结果网页", "url": "/r/tok123"},
                           {"label": "账本.xlsx", "url": "/api/files/abcdefgh12"},
                           {"label": "飞书文档", "url": "https://feishu.cn/docx/abc"}]}}


def _graph(fields):
    return validate_graph({
        "nodes": [
            {"id": "start", "type": "start", "position": {"x": 0, "y": 0}, "data": {"fields": fields}},
            {"id": "ai", "type": "llm", "position": {"x": 200, "y": 0}, "data": {"title": "整理", "prompt": "整理"}},
            {"id": "end", "type": "end", "position": {"x": 400, "y": 0}, "data": {"output": "{{ai.text}}"}},
        ],
        "edges": [{"source": "start", "target": "ai"}, {"source": "ai", "target": "end"}],
    })


class FakeRuntime:
    def __init__(self):
        self.deps = engine.FlowDeps(tenant_store=TenantStore)
        self.calls = []
        self.result = dict(OK)
        self.error = None
        self.delay = 0.0

    def store(self):
        return FlowStore()

    def run_headless(self, user_id, flow_id, inputs=None, *, source="schedule"):
        self.calls.append({"user_id": user_id, "flow_id": flow_id, "inputs": inputs, "source": source,
                           "at": time.monotonic()})
        if self.delay:
            time.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return dict(self.result)


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.unique_active_owner().user_id


@pytest.fixture()
def runtime(monkeypatch):
    fake = FakeRuntime()
    monkeypatch.setattr(hooks, "_runtime_getter", lambda: fake)
    monkeypatch.delenv("JARVIS_PUBLIC_URL", raising=False)
    return fake


def _flow(owner, name, fields=FIELDS):
    return FlowStore().create_flow(owner, name=name, summary=name, graph=_graph(list(fields)))


def _hook(owner, flow, *, channels=("feishu", "wechat"), match="keywords", keywords=("记账",), enabled=True,
          input_field="note"):
    return hooks.HookStore().save_message(owner, flow["id"], enabled=enabled, config={
        "channels": list(channels), "match": match, "keywords": list(keywords), "input_field": input_field})


# ---------- handle_message ----------

def test_no_hooks_means_normal_chat(owner_id, runtime):
    assert hooks.handle_message(owner_id, "feishu", "记账 午饭 35") is None
    assert runtime.calls == []


def test_keyword_hit_runs_flow_and_replies_result_with_links(owner_id, runtime):
    flow = _flow(owner_id, "记账")
    _hook(owner_id, flow)
    started = []
    reply = hooks.handle_message(owner_id, "feishu", "记账 午饭 35 元", on_start=started.append)
    [call] = runtime.calls
    assert call["source"] == "message" and call["flow_id"] == flow["id"] and call["inputs"] == {"note": "记账 午饭 35 元"}
    assert started == ["记账"]
    assert reply.startswith("「记账」跑完了：") and "【已记账】" in reply and "• 午饭 35 元" in reply
    assert "结果网页：/r/tok123" in reply and "账本.xlsx：/api/files/abcdefgh12" in reply
    assert "飞书文档：https://feishu.cn/docx/abc" in reply
    assert hooks.LINK_NOTE in reply                                       # 没配对外地址：相对地址并注明
    row = hooks.HookStore().get(owner_id, flow["id"], "message")
    assert row["last_hit_at"] and row["last_status"] == "ok"


def test_public_url_makes_links_absolute(owner_id, runtime, monkeypatch):
    monkeypatch.setenv("JARVIS_PUBLIC_URL", "https://jv.example.com")
    _hook(owner_id, _flow(owner_id, "记账"))
    reply = hooks.handle_message(owner_id, "wechat", "记账 打车 20")
    assert "结果网页：https://jv.example.com/r/tok123" in reply and hooks.LINK_NOTE not in reply


def test_miss_wrong_channel_and_disabled_fall_through(owner_id, runtime):
    flow = _flow(owner_id, "记账")
    _hook(owner_id, flow, channels=("wechat",))
    assert hooks.handle_message(owner_id, "feishu", "记账 午饭") is None          # 渠道没选飞书
    assert hooks.handle_message(owner_id, "wechat", "今天天气怎么样") is None     # 没命中关键词
    _hook(owner_id, flow, channels=("wechat",), enabled=False)
    assert hooks.handle_message(owner_id, "wechat", "记账 午饭") is None          # 关掉了
    assert hooks.handle_message(owner_id, "wechat", "") is None
    assert runtime.calls == []


def test_keyword_beats_all_and_all_catches_the_rest(owner_id, runtime):
    catch_all, ledger = _flow(owner_id, "收件箱"), _flow(owner_id, "记账")
    _hook(owner_id, catch_all, match="all", keywords=())
    _hook(owner_id, ledger, keywords=("记账", "花了"))
    hooks.handle_message(owner_id, "feishu", "刚才打车花了 20")
    hooks.handle_message(owner_id, "feishu", "明天下午开会")
    assert [c["flow_id"] for c in runtime.calls] == [ledger["id"], catch_all["id"]]
    assert hooks.handle_message(owner_id, "feishu", "Hello") is not None   # 关键词不分大小写之外，全部消息兜底


def test_keyword_match_ignores_case(owner_id, runtime):
    _hook(owner_id, _flow(owner_id, "日报"), keywords=("Daily",))
    assert hooks.handle_message(owner_id, "feishu", "daily 今天做了三件事") is not None


def test_deleted_flow_hook_is_cleaned_and_falls_through(owner_id, runtime):
    flow = _flow(owner_id, "记账")
    _hook(owner_id, flow)
    FlowStore().delete_flow(owner_id, flow["id"])
    assert hooks.handle_message(owner_id, "feishu", "记账 午饭") is None
    assert hooks.HookStore().get(owner_id, flow["id"], "message") is None and runtime.calls == []


def test_attachments_and_markers_fill_file_field(owner_id, runtime):
    _hook(owner_id, _flow(owner_id, "记账"))
    hooks.handle_message(owner_id, "feishu", "记账 发票见附件", attachments=["［附件：发票.pdf · file_id=AbCdEf123456］"])
    assert runtime.calls[-1]["inputs"] == {"doc": {"file_id": "AbCdEf123456"}, "note": "记账 发票见附件"}


def test_input_field_can_be_the_file_field(owner_id, runtime):
    flow = _flow(owner_id, "收发票")
    _hook(owner_id, flow, keywords=("发票",), input_field="doc")
    hooks.handle_message(owner_id, "feishu", "发票 ［附件：发票.pdf · file_id=AbCdEf123456］")
    assert runtime.calls[-1]["inputs"] == {"doc": {"file_id": "AbCdEf123456"}, "note": "发票"}


@pytest.mark.parametrize("result, expect", [
    ({"status": "waiting", "approval": {"id": "ap12345678", "url": "/approve/ap12345678",
                                        "expires_at": "2026-10-04T08:00:00+00:00"}},
     ["「记账」有一步等你确认：/approve/ap12345678", "确认后会接着跑完", "前有效", hooks.LINK_NOTE]),
    ({"status": "error", "error": "「发到飞书」：先在设置里绑定飞书"},
     ["「记账」这次没跑成：「发到飞书」：先在设置里绑定飞书", "「我的流程」"]),
    ({"status": "busy", "error": "你有一条流程正在运行，等它跑完再试"}, ["「记账」这次没开跑：你有一条流程正在运行"]),
    ({"status": "quota", "error": "今天的流程运行次数到上限了，明天再来，或请管理员调高"}, ["今天的流程运行次数到上限了"]),
])
def test_not_ok_results_are_human(owner_id, runtime, result, expect):
    _hook(owner_id, _flow(owner_id, "记账"))
    runtime.result = {"run_id": None, "output": None, "error": "", **result}
    reply = hooks.handle_message(owner_id, "feishu", "记账 午饭")
    for piece in expect:
        assert piece in reply
    assert "status" not in reply and "run_id" not in reply


def test_run_crash_is_human_and_lookup_crash_falls_through(owner_id, runtime, monkeypatch):
    _hook(owner_id, _flow(owner_id, "记账"))
    runtime.error = RuntimeError("boom")
    assert hooks.handle_message(owner_id, "feishu", "记账 午饭") == "「记账」这次没跑成：流程运行出了点问题，请稍后再试\n打开贾维斯网页的「我的流程」看看是哪一步出了问题。"
    monkeypatch.setattr(hooks.HookStore, "enabled_messages", lambda self, owner: 1 / 0)
    assert hooks.handle_message(owner_id, "feishu", "记账 午饭") is None   # 查不了触发设置：照常对话


def test_hooks_are_per_account(owner_id, runtime):
    member = AccountStore().create_user("member", "Member-pass-123", "Member")["id"]
    _hook(owner_id, _flow(owner_id, "记账"))
    assert hooks.handle_message(member, "feishu", "记账 午饭") is None and runtime.calls == []


def test_long_result_is_clipped(owner_id, runtime):
    _hook(owner_id, _flow(owner_id, "记账"))
    runtime.result = {**OK, "output": {"text": "字" * 5000, "page_url": "/r/tok123", "links": []}}
    reply = hooks.handle_message(owner_id, "feishu", "记账")
    assert "（完整结果见结果网页）" in reply and len(reply) < hooks.REPLY_TEXT_CHARS + 200


# ---------- 飞书：交给对话之前先问消息触发 ----------

class FakeConnection:
    def __init__(self, **hooks_):
        self.hooks = hooks_

    def start(self):
        self.hooks["before_connect"]()
        self.hooks["on_state"]("connected", "")

    def stop(self, timeout=None):
        pass


def _chunk_text(content):
    return content if isinstance(content, str) else str(content)


class FeishuEnv:
    def __init__(self, tmp_path, message_hook):
        self.fake, self.agent = FakeFeishu(), FakeAgent("对话回复")
        self.accounts = AccountStore(); self.accounts._ensure_bootstrap()
        self.owner = self.accounts.unique_active_owner()
        self.bindings = BindingStore(data_dir_getter=lambda: tmp_path)
        settings = FeishuSettings(APP_ID, APP_SECRET, streaming_card=False)
        self.bridge = FeishuBridge(
            settings_getter=lambda: settings,
            api_factory=lambda s: FeishuAPI(s.app_id, s.app_secret, client=self.fake.client()),
            connection_factory=lambda _s, **h: FakeConnection(**h), bindings=self.bindings,
            dispatcher_factory=lambda: None)
        self.bridge.configure(bundle_for=bundle_for_agent(self.agent), chunk_text=_chunk_text,
                              tenant_store=TenantStore, accounts=self.accounts, message_hook=message_hook)
        self.bridge.start()
        self.bindings.bind("ou_alice", self.owner.user_id)

    def send(self, *args, **kwargs):
        self.bridge.handle_event(message_event(*args, **kwargs))

    def texts(self):
        out = []
        for reply in self.fake.replies:
            if reply["msg_type"] == "post":
                out.append(reply["content"]["zh_cn"]["content"][0][0]["text"])
            elif reply["msg_type"] == "text":
                out.append(reply["content"]["text"])
        return out


def test_feishu_hit_replies_flow_result_and_skips_agent(tmp_path, owner_id, runtime):
    _hook(owner_id, _flow(owner_id, "记账"), channels=("feishu",))
    env = FeishuEnv(tmp_path, lambda user_id, channel, text, **kw: hooks.handle_message(user_id, channel, text, **kw))
    env.send("记账 午饭 35", message_id="om_1")
    assert env.agent.calls == []
    [text] = env.texts()
    assert text.startswith("「记账」跑完了") and runtime.calls[0]["source"] == "message"
    assert ("add", "om_1") in env.fake.reactions and ("delete", "om_1") in env.fake.reactions   # 跑的时候挂「打字中」


def test_feishu_miss_goes_to_agent(tmp_path, owner_id, runtime):
    _hook(owner_id, _flow(owner_id, "记账"), channels=("feishu",))
    env = FeishuEnv(tmp_path, lambda user_id, channel, text, **kw: hooks.handle_message(user_id, channel, text, **kw))
    env.send("明天天气怎么样")
    assert [c["text"] for c in env.agent.calls] == ["明天天气怎么样"] and env.texts() == ["对话回复"]
    assert runtime.calls == []


def test_feishu_group_only_when_mentioned_and_text_is_stripped(tmp_path, owner_id):
    seen = []

    def hook(user_id, channel, text, **kw):
        seen.append((user_id, channel, text))
        return "流程回复"

    env = FeishuEnv(tmp_path, hook)
    group = dict(chat_type="group", chat_id="oc_group_chat_00000000009")
    env.send("记账 午饭", message_id="om_g1", event_id="e1", **group)               # 没 @：群里不理
    assert seen == [] and env.texts() == []
    env.send("@_user_1 记账 午饭", message_id="om_g2", event_id="e2", mentions=[bot_mention()], **group)
    assert seen == [(owner_id, "feishu", "记账 午饭")] and env.texts() == ["流程回复"]
    env.send("@_user_1", message_id="om_g3", event_id="e3", mentions=[bot_mention()], **group)   # 光 @ 一下：照常寒暄
    assert len(seen) == 1 and env.agent.calls[0]["text"] == "你好"


def test_feishu_commands_and_hook_failures_never_swallow_messages(tmp_path, owner_id):
    calls = []

    def broken(user_id, channel, text, **kw):
        calls.append(text)
        raise RuntimeError("boom")

    env = FeishuEnv(tmp_path, broken)
    env.send("解绑", message_id="om_1", event_id="e1")                                # 命令不进消息触发
    assert calls == []
    env.bindings.bind("ou_alice", owner_id)
    env.send("记账 午饭", message_id="om_2", event_id="e2")
    assert calls == ["记账 午饭"] and [c["text"] for c in env.agent.calls] == ["记账 午饭"]


# ---------- 微信：私聊与群里 @ 才走消息触发 ----------

class WxClient:
    def __init__(self):
        self.sent = []
        self.lock = threading.Lock()

    def post(self, url, **kwargs):
        if url.endswith("/sendmessage"):
            message = kwargs["json"]["msg"]
            item = message["item_list"][0]
            if "text_item" in item:
                with self.lock:
                    self.sent.append((message["to_user_id"], item["text_item"]["text"], time.monotonic()))
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"ret": 0}, status_code=200)

    def close(self):
        pass


def _wechat_bridge(tmp_path, message_hook):
    agent_calls = []

    class Agent:
        def invoke(self, state, config):
            agent_calls.append(state["messages"][0]["content"])
            return {"messages": [SimpleNamespace(content="对话回复")]}

    bridge = wechat.WeChatBridge(
        agent_getter=lambda: Agent(), chunk_text=lambda c: str(c), data_dir_getter=lambda: tmp_path,
        client_factory=WxClient, thread_factory=lambda **kw: SimpleNamespace(start=lambda: None, is_alive=lambda: False),
        sleeper=lambda _s: None,
        owner_getter=lambda: (AccountStore()._ensure_bootstrap() or AccountStore().unique_active_owner()))
    bridge.set_message_hook(message_hook)
    return bridge, agent_calls


def _wx(from_id, text):
    return {"message_type": 1, "from_user_id": from_id, "context_token": "ctx",
            "item_list": [{"type": 1, "text_item": {"text": text}}]}


def test_wechat_private_hit_and_miss(tmp_path, owner_id, runtime):
    _hook(owner_id, _flow(owner_id, "记账"), channels=("wechat",))
    bridge, agent_calls = _wechat_bridge(
        tmp_path, lambda user_id, channel, text, **kw: hooks.handle_message(user_id, channel, text, **kw))
    client = WxClient()
    bridge._handle_updates_response(client, "token", {"msgs": [_wx("alice@im.wechat", "记账 午饭 35"),
                                                               _wx("alice@im.wechat", "今天天气")]})
    texts = [text for _to, text, _at in client.sent]
    assert texts[0].startswith("「记账」跑完了") and texts[-1] == "对话回复"
    assert agent_calls == ["今天天气"] and [c["source"] for c in runtime.calls] == ["message"]


def test_wechat_group_needs_mention(tmp_path, owner_id):
    seen = []

    def hook(user_id, channel, text, **kw):
        seen.append((channel, text))
        return "流程回复"

    bridge, agent_calls = _wechat_bridge(tmp_path, hook)
    client = WxClient()
    bridge._handle_updates_response(client, "token", {"msgs": [_wx("123@im.chatroom", "记账 午饭"),
                                                               _wx("123@im.chatroom", "@贾维斯 记账 午饭")]})
    assert seen == [("wechat", "记账 午饭")] and [t for _to, t, _at in client.sent] == ["流程回复"]
    assert agent_calls == []


def test_wechat_hook_failure_falls_back_to_chat(tmp_path, owner_id):
    bridge, agent_calls = _wechat_bridge(tmp_path, lambda *a, **kw: 1 / 0)
    client = WxClient()
    bridge._handle_updates_response(client, "token", {"msgs": [_wx("alice@im.wechat", "记账 午饭")]})
    assert agent_calls == ["记账 午饭"] and [t for _to, t, _at in client.sent] == ["对话回复"]


def test_wechat_same_sender_runs_flow_messages_one_after_another(tmp_path, owner_id, runtime):
    """运行中再来的消息按现有并发规则：同一个人的消息串行，第二条等第一条的流程跑完才开跑。"""
    _hook(owner_id, _flow(owner_id, "记账"), channels=("wechat",))
    runtime.delay = 0.3
    bridge, _agent_calls = _wechat_bridge(
        tmp_path, lambda user_id, channel, text, **kw: hooks.handle_message(user_id, channel, text, **kw))
    dispatcher = wechat._ReplyDispatcher(2)
    client = WxClient()
    for text in ("记账 午饭", "记账 晚饭"):
        bridge._route_message(client, "token", _wx("alice@im.wechat", text), dispatcher)
    assert dispatcher.drain(5)
    dispatcher.stop()
    first, second = runtime.calls
    assert [c["inputs"]["note"] for c in runtime.calls] == ["记账 午饭", "记账 晚饭"]
    assert second["at"] - first["at"] >= 0.29
    assert len(client.sent) == 2
