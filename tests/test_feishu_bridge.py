"""飞书桥端到端：收消息 → 绑定/去重/@过滤 → Agent → 流式卡片或富文本回复，以及各级降级。"""
import json
import threading
import time

from jarvis.accounts import AccountStore
from jarvis.channels.feishu import bridge as bridge_mod
from jarvis.channels.feishu.api import FeishuAPI
from jarvis.channels.feishu.bindings import BindingStore
from jarvis.channels.feishu.bridge import FeishuBridge, FeishuSettings, split_markdown
from jarvis.channels.feishu.frame import METHOD_DATA
from jarvis.channels.feishu.ws import LongConnection
from jarvis.tenancy import TenantStore, tenant_scope
from jarvis.wechat import _ReplyDispatcher

from feishu_fakes import (APP_ID, APP_SECRET, FakeAgent, FakeFeishu, FakeWS, bot_mention, bundle_for_agent,
                          event_frame, message_event)


def chunk_text(content):
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content if isinstance(p, dict))


class FakeConnection:
    def __init__(self, **hooks):
        self.hooks = hooks
        self.started = self.stopped = False

    def start(self):
        self.started = True
        self.hooks["before_connect"]()
        self.hooks["on_state"]("connected", "")

    def stop(self, timeout=None):
        self.stopped = True


class Env:
    def __init__(self, tmp_path, agent=None, *, streaming=True, describe_image=None, wall_clock=time.time,
                 dispatcher_factory=lambda: None):
        self.fake = FakeFeishu()
        self.agent = agent or FakeAgent()
        self.accounts = AccountStore()
        self.accounts._ensure_bootstrap()
        self.owner = self.accounts.unique_active_owner()
        self.bindings = BindingStore(data_dir_getter=lambda: tmp_path)
        self.connections = []
        settings = FeishuSettings(APP_ID, APP_SECRET, streaming_card=streaming)

        def connection_factory(_settings, **hooks):
            conn = FakeConnection(**hooks)
            self.connections.append(conn)
            return conn

        self.bridge = FeishuBridge(
            settings_getter=lambda: settings,
            api_factory=lambda s: FeishuAPI(s.app_id, s.app_secret, client=self.fake.client()),
            connection_factory=connection_factory, bindings=self.bindings,
            describe_image=describe_image, wall_clock=wall_clock, dispatcher_factory=dispatcher_factory,
        )
        self.bridge.configure(bundle_for=bundle_for_agent(self.agent), chunk_text=chunk_text,
                              tenant_store=TenantStore, accounts=self.accounts)
        self.bridge.start()

    def bind(self, open_id="ou_alice", user_id=None):
        self.bindings.bind(open_id, user_id or self.owner.user_id)

    def send(self, *args, **kwargs):
        self.bridge.handle_event(message_event(*args, **kwargs))

    def texts(self):
        """所有非卡片回复的文字（富文本 md 与纯文本统一取出）。"""
        out = []
        for reply in self.fake.replies:
            if reply["msg_type"] == "text":
                out.append(reply["content"]["text"])
            elif reply["msg_type"] == "post":
                out.append(reply["content"]["zh_cn"]["content"][0][0]["text"])
        return out

    def threads(self):
        with tenant_scope(self.owner.user_id):
            return TenantStore().list_threads()


def test_p2p_text_streams_a_card_reply_in_an_isolated_thread(tmp_path):
    env = Env(tmp_path, FakeAgent(chunks=["明天", "晴，", "最高 25 度。"]))
    env.bind()

    env.send("明天天气怎么样", message_id="om_1")

    [call] = env.agent.calls
    assert call["text"] == "明天天气怎么样" and call["mode"] == "messages"
    [card_reply] = env.fake.replies
    assert card_reply["message_id"] == "om_1" and card_reply["msg_type"] == "interactive"
    assert card_reply["content"] == {"type": "card", "data": {"card_id": "card-1"}}
    card = env.fake.cards["card-1"]
    assert card["spec"]["config"]["streaming_mode"] is True
    assert card["spec"]["body"]["elements"][0] == {"tag": "markdown", "element_id": "answer", "content": "思考中…"}
    assert card["updates"][-1] == "明天晴，最高 25 度。"
    assert card["settings"][-1]["config"]["streaming_mode"] is False
    assert card["settings"][-1]["config"]["summary"]["content"] == "明天晴，最高 25 度。"
    [thread] = [t for t in env.threads() if t["id"].startswith("fs-p-")]
    assert thread["title"] == "飞书 · 明天天气怎么样"
    assert call["thread_id"].startswith("tenant:")


def test_tool_status_is_shown_then_replaced_by_final_answer(tmp_path):
    env = Env(tmp_path, FakeAgent(chunks=["今天", "晴。"], tool="web_search"))
    env.bind()

    env.send("今天天气")

    updates = env.fake.cards["card-1"]["updates"]
    assert any("正在调用工具：web_search" in u for u in updates)
    assert updates[-1] == "今天晴。"  # 工具前的「我查一下。」不进最终答案


def test_invoke_only_agent_still_gets_answer_via_card(tmp_path):
    class InvokeOnly:
        def __init__(self):
            self.calls = []

        def invoke(self, inputs, config):
            self.calls.append(inputs)
            from types import SimpleNamespace
            return {"messages": [SimpleNamespace(content=[{"type": "text", "text": "好的"}])]}

    agent = InvokeOnly()
    env = Env(tmp_path, agent)
    env.bind()
    env.send("在吗")
    assert env.fake.cards["card-1"]["updates"][-1] == "好的"


def test_group_requires_bot_mention_and_strips_it(tmp_path):
    env = Env(tmp_path)
    env.bind()
    group = dict(chat_type="group", chat_id="oc_group_chat_00000000009")

    env.send("大家好", message_id="om_g1", event_id="e1", **group)
    env.send("@_user_1 你看下", message_id="om_g2", event_id="e2",
             mentions=[{"key": "@_user_1", "id": {"open_id": "ou_tom"}, "name": "Tom", "mentioned_type": "user"}],
             **group)
    assert env.agent.calls == [] and env.fake.replies == []

    env.send("@_user_1 帮我问问 @_user_2 明天的会", message_id="om_g3", event_id="e3",
             mentions=[bot_mention("@_user_1"),
                       {"key": "@_user_2", "id": {"open_id": "ou_tom"}, "name": "Tom", "mentioned_type": "user"}],
             **group)
    assert [c["text"] for c in env.agent.calls] == ["帮我问问 @Tom 明天的会"]


def test_bare_mention_in_group_becomes_greeting(tmp_path):
    env = Env(tmp_path)
    env.bind()
    env.send("@_user_1", chat_type="group", chat_id="oc_group_x", mentions=[bot_mention()])
    assert env.agent.calls[0]["text"] == "你好"


def test_p2p_group_and_topic_conversations_use_separate_threads(tmp_path):
    env = Env(tmp_path)
    env.bind()
    env.send("一", message_id="om_1", event_id="e1")
    env.send("@_user_1 二", message_id="om_2", event_id="e2", chat_type="group", chat_id="oc_group_0000000000001",
             mentions=[bot_mention()])
    env.send("@_user_1 三", message_id="om_3", event_id="e3", chat_type="group", chat_id="oc_group_0000000000001",
             thread_id="omt_topic_000000000042", mentions=[bot_mention()])
    env.send("四", message_id="om_4", event_id="e4")

    thread_ids = [c["thread_id"] for c in env.agent.calls]
    assert len(set(thread_ids[:3])) == 3 and thread_ids[3] == thread_ids[0]
    aliases = sorted(t["id"][:5] for t in env.threads())
    assert aliases == ["fs-g-", "fs-p-", "fs-t-"]
    assert env.fake.replies[2]["in_thread"] is True  # 话题里的消息就在话题里回


def test_duplicate_deliveries_are_processed_once(tmp_path):
    """官方：特殊情况下会重复推送，应按 message_id 去重（event_id 也一并记）。"""
    env = Env(tmp_path)
    env.bind()
    env.send("一次", message_id="om_dup", event_id="e1")
    env.send("一次", message_id="om_dup", event_id="e1")
    env.send("一次", message_id="om_dup", event_id="e2")
    env.send("另一条", message_id="om_other", event_id="e1")
    assert [c["text"] for c in env.agent.calls] == ["一次"]


def test_stale_messages_and_bot_senders_are_ignored(tmp_path):
    env = Env(tmp_path, wall_clock=lambda: 10_000.0)
    env.bind()
    env.send("旧消息", message_id="om_old", event_id="e1", create_time=str((10_000 - 3600) * 1000))
    env.send("机器人说", message_id="om_bot", event_id="e2", sender_type="bot")
    env.send("新消息", message_id="om_new", event_id="e3", create_time=str((10_000 - 5) * 1000))
    assert [c["text"] for c in env.agent.calls] == ["新消息"]


def test_unbound_user_is_guided_then_binds_with_one_time_code(tmp_path):
    env = Env(tmp_path)
    env.send("你好", message_id="om_1", event_id="e1")
    env.send("还在吗", message_id="om_2", event_id="e2")
    assert env.agent.calls == []
    assert env.texts() == [bridge_mod.UNBOUND_REPLY]  # 指引 10 分钟内只发一次

    code = env.bindings.issue_code(env.owner.user_id)
    env.send(f"绑定 {code}", message_id="om_3", event_id="e3")
    assert "绑定成功" in env.texts()[-1] and "admin" in env.texts()[-1]
    env.send(f"绑定 {code}", message_id="om_4", event_id="e4", open_id="ou_mallory")
    assert env.texts()[-1] == bridge_mod.BIND_INVALID_REPLY  # 码是一次性的

    env.send("现在呢", message_id="om_5", event_id="e5")
    assert [c["text"] for c in env.agent.calls] == ["现在呢"]

    env.send("解绑", message_id="om_6", event_id="e6")
    assert env.texts()[-1] == bridge_mod.UNBIND_REPLY
    env.send("再聊", message_id="om_7", event_id="e7")
    assert env.texts()[-1] == bridge_mod.UNBOUND_REPLY and len(env.agent.calls) == 1


def test_bind_code_brute_force_is_locked_out_and_group_bind_refused(tmp_path):
    env = Env(tmp_path)
    code = env.bindings.issue_code(env.owner.user_id)
    wrong = "000000" if code != "000000" else "111111"
    for i in range(5):
        env.send(f"绑定 {wrong}", message_id=f"om_w{i}", event_id=f"ew{i}")
    env.send(f"绑定 {code}", message_id="om_right", event_id="er")
    assert env.texts()[-1] == bridge_mod.BIND_LOCKED_REPLY
    assert env.bindings.user_for("ou_alice") is None

    env.send(f"@_user_1 绑定 {code}", message_id="om_grp", event_id="eg", chat_type="group",
             chat_id="oc_g", open_id="ou_bob", mentions=[bot_mention()])
    assert env.texts()[-1] == bridge_mod.BIND_IN_GROUP_REPLY


def test_disabled_account_binding_is_refused(tmp_path):
    env = Env(tmp_path)
    member = env.accounts.create_user("feishu-member", "pw", "Member")
    env.bind(user_id=member["id"])
    env.accounts.update_user(member["id"], active=False)
    env.send("你好")
    assert env.agent.calls == [] and env.texts() == [bridge_mod.STALE_BINDING_REPLY]


def test_member_binding_runs_agent_in_member_tenant(tmp_path):
    env = Env(tmp_path)
    member = env.accounts.create_user("feishu-member", "pw", "Member")
    env.bind(user_id=member["id"])
    env.send("你好")
    with tenant_scope(member["id"]):
        assert [t["id"][:5] for t in TenantStore().list_threads()] == ["fs-p-"]
    assert env.threads() == []  # Owner 的租户里没有这条对话


def test_long_reply_fills_card_then_continues_in_markdown_messages(tmp_path):
    paragraphs = [f"第{i}段：" + "内容" * 400 for i in range(12)]  # ≈ 9700 字
    answer = "\n\n".join(paragraphs)
    env = Env(tmp_path, FakeAgent(answer))
    env.bind()
    env.send("写长文")

    final = env.fake.cards["card-1"]["updates"][-1]
    assert final.endswith("*（回复较长，后续内容见下一条消息）*") and len(final) <= 6100
    rest = env.texts()
    assert rest and all(r["msg_type"] == "post" for r in env.fake.replies[1:])
    body = final.removesuffix("\n\n*（回复较长，后续内容见下一条消息）*")
    assert "\n\n".join([body, *rest]).replace("\n", "") == answer.replace("\n", "")


def test_split_markdown_keeps_code_fences_balanced():
    text = "前言\n```python\n" + "\n".join(f"print({i})" for i in range(400)) + "\n```\n结尾"
    chunks = split_markdown(text, limit=1000)
    assert len(chunks) > 1 and all(c.count("```") % 2 == 0 for c in chunks)
    assert all(len(c) <= 1010 for c in chunks)


def test_missing_card_permission_degrades_to_markdown_with_typing_reaction(tmp_path):
    env = Env(tmp_path, FakeAgent("**好的**"))
    env.bind()
    env.fake.fail("POST", r"/cardkit/v1/cards$", 99991672)

    env.send("一", message_id="om_1", event_id="e1")
    env.send("二", message_id="om_2", event_id="e2")

    assert [r["msg_type"] for r in env.fake.replies] == ["post", "post"]
    assert env.fake.replies[0]["content"] == {"zh_cn": {"content": [[{"tag": "md", "text": "**好的**"}]]}}
    assert sum(1 for p in env.fake.paths() if p == "POST /open-apis/cardkit/v1/cards") == 1  # 冷却期内不再试卡片
    assert env.fake.reactions == [("add", "om_1"), ("delete", "om_1"), ("add", "om_2"), ("delete", "om_2")]
    assert env.bridge.status()["streaming_card"] is False


def test_reply_failures_fall_back_to_text_then_direct_send(tmp_path):
    env = Env(tmp_path, FakeAgent("答复"), streaming=False)
    env.bind()
    env.fake.fail("POST", r"/reply$", 230001, 230011)

    env.send("你好", chat_id="oc_p2p_chat_7")

    assert env.fake.replies == []
    assert env.fake.sent == [{"receive_id_type": "chat_id", "receive_id": "oc_p2p_chat_7", "msg_type": "text",
                              "content": {"text": "答复"}}]


def test_agent_failures_are_humanized(tmp_path):
    env = Env(tmp_path, FakeAgent(error=RuntimeError("secret upstream detail sk-123")))
    env.bind()
    env.send("你好")
    final = env.fake.cards["card-1"]["updates"][-1]
    assert "没处理成功" in final and "sk-123" not in final

    env2 = Env(tmp_path / "b", FakeAgent(error=TimeoutError()))
    env2.bind()
    env2.send("你好")
    assert "超时" in env2.fake.cards["card-1"]["updates"][-1]


def test_image_message_is_described_by_vision_and_injected(tmp_path):
    seen = []
    env = Env(tmp_path, describe_image=lambda data, ext: seen.append((data[:4], ext)) or "一只橘猫趴在键盘上")
    env.bind()
    env.fake.resources[("om_img", "img_v3_1")] = (b"\x89PNGrest", "image/png")

    env.send(message_id="om_img", msg_type="image", content={"image_key": "img_v3_1"})

    assert seen == [(b"\x89PNG", "png")]
    assert "【图片内容】\n一只橘猫趴在键盘上\n【图片内容结束】" in env.agent.calls[0]["text"]


def test_post_with_image_and_question_and_vision_failure(tmp_path):
    from jarvis import vision

    def broken(_data, _ext):
        raise vision.VisionError("图像识别未配置（缺 DASHSCOPE_API_KEY）")

    env = Env(tmp_path, describe_image=broken)
    env.bind()
    env.fake.resources[("om_post", "img_9")] = (b"\xff\xd8jpeg", "image/jpeg")
    env.send(message_id="om_post", msg_type="post", content={"title": "", "content": [
        [{"tag": "text", "text": "这是什么？"}], [{"tag": "img", "image_key": "img_9"}]]})

    assert env.agent.calls == []
    assert env.fake.cards["card-1"]["updates"][-1] == "（图片识别失败：图像识别未配置（缺 DASHSCOPE_API_KEY））"


def test_audio_and_other_types_get_clear_hints(tmp_path):
    env = Env(tmp_path)
    env.bind()
    env.send(message_id="om_a", event_id="ea", msg_type="audio", content={"file_key": "f", "duration": 2000})
    env.send(message_id="om_s", event_id="es", msg_type="sticker", content={"file_key": "s"})
    assert env.texts() == [bridge_mod.AUDIO_REPLY, bridge_mod.UNSUPPORTED_REPLY]
    assert env.agent.calls == []


def test_bare_link_becomes_summary_instruction(tmp_path):
    env = Env(tmp_path)
    env.bind()
    env.send("https://example.com/article")
    assert "web_extract" in env.agent.calls[0]["text"]


def test_expired_token_mid_session_is_refreshed_transparently(tmp_path):
    env = Env(tmp_path, streaming=False)
    env.bind()
    env.send("一", message_id="om_1", event_id="e1")
    env.fake.revoked.add("t-1")
    env.send("二", message_id="om_2", event_id="e2")
    assert env.texts() == ["收到", "收到"] and env.fake.token_count == 2


def test_ack_is_written_before_slow_agent_finishes(tmp_path):
    """官方要求 3 秒内 ack：长连接线程只入队，慢 Agent 在工作池里跑。"""
    release = threading.Event()

    class SlowAgent(FakeAgent):
        def invoke(self, inputs, config):
            release.wait(5)
            return super().invoke(inputs, config)

    dispatchers = []

    def dispatcher_factory():
        dispatchers.append(_ReplyDispatcher(2, thread_name_prefix="test-feishu"))
        return dispatchers[-1]

    env = Env(tmp_path, SlowAgent("慢回答"), streaming=False, dispatcher_factory=dispatcher_factory)
    env.bind()
    conn = LongConnection(APP_ID, APP_SECRET, on_event=env.bridge.handle_event)
    ws = FakeWS()

    started = time.monotonic()
    conn.handle_frame(ws, event_frame(message_event("慢问题")))
    assert time.monotonic() - started < 1
    assert len(ws.outbox) == 1 and ws.outbox[0].method == METHOD_DATA
    assert json.loads(ws.outbox[0].payload) == {"code": 200}
    assert env.fake.replies == []

    release.set()
    assert dispatchers[0].drain(timeout=5)
    assert env.texts() == ["慢回答"]
    env.bridge.shutdown()


def test_lifecycle_status_and_stale_generation_callbacks(tmp_path, monkeypatch):
    disabled = FeishuBridge(settings_getter=FeishuSettings.from_env)
    assert disabled.start()["state"] == "disabled" and disabled.status()["configured"] is False

    env = Env(tmp_path)
    status = env.bridge.status()
    assert status["state"] == "connected" and status["bot_name"] == "贾维斯" and status["since"]
    old_conn = env.connections[0]
    env.bridge.shutdown()
    assert old_conn.stopped and env.bridge.status()["state"] == "stopped"

    env.bridge.start()
    old_conn.hooks["on_state"]("error", "旧连接的迟到回调")
    assert env.bridge.status()["state"] == "connected"


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("FEISHU_APP_ID", " cli_x ")
    monkeypatch.setenv("FEISHU_APP_SECRET", "s")
    monkeypatch.setenv("FEISHU_STREAMING_CARD", "0")
    monkeypatch.setenv("FEISHU_DOMAIN", "https://open.larksuite.com")
    settings = FeishuSettings.from_env()
    assert settings.configured and settings.app_id == "cli_x"
    assert settings.streaming_card is False and settings.domain == "https://open.larksuite.com"
