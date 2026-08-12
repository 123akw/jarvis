"""个人微信桥状态机：二维码、凭据、消息收发与并发代次。"""
from types import SimpleNamespace

import httpx

from jarvis import wechat
from jarvis.accounts import AccountStore


class FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self.payload = payload or {}
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", "https://example.test")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("failed", request=request, response=response)

    def json(self):
        return self.payload


class FakeClient:
    def __init__(self, get_responses=(), post_responses=(), sent=None):
        self.get_responses = list(get_responses)
        self.post_responses = list(post_responses)
        self.get_calls = []
        self.post_calls = []
        self.sent = sent if sent is not None else []
        self.closed = False

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        if not self.get_responses:
            raise AssertionError(f"unexpected GET {url}")
        return self.get_responses.pop(0)

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        if url.endswith("/sendmessage"):
            text = kwargs["json"]["msg"]["item_list"][0]["text_item"]["text"]
            self.sent.append(text)
        return self.post_responses.pop(0) if self.post_responses else FakeResponse({"ret": 0})

    def close(self):
        self.closed = True


class DeferredThread:
    created = []

    def __init__(self, target, args=(), daemon=False, name=None):
        self.target = target
        self.args = args
        self.daemon = daemon
        self.name = name
        self.started = False
        self.__class__.created.append(self)

    def start(self):
        self.started = True

    def run(self):
        self.target(*self.args)

    def is_alive(self):
        return self.started


def make_bridge(tmp_path, client, reply="收到"):
    """只替换 iLink/线程边界；状态机与文件写入走真实实现。"""
    bridge_cls = getattr(wechat, "WeChatBridge", None)
    assert bridge_cls is not None, "production bridge must expose WeChatBridge"
    agent_calls = []

    class FakeAgent:
        def invoke(self, state, config):
            agent_calls.append({
                "text": state["messages"][0]["content"],
                "thread_id": config["configurable"]["thread_id"],
            })
            return {"messages": [SimpleNamespace(content=reply)]}

    DeferredThread.created.clear()
    bridge = bridge_cls(
        agent_getter=lambda: FakeAgent(),
        chunk_text=lambda content: str(content),
        data_dir_getter=lambda: tmp_path,
        client_factory=lambda: client,
        thread_factory=DeferredThread,
        sleeper=lambda _seconds: None,
        owner_getter=lambda: (AccountStore()._ensure_bootstrap() or AccountStore().unique_active_owner()),
    )
    return bridge, agent_calls


def test_connect_returns_svg_qr_and_is_idempotent(tmp_path):
    """防回归：重复点击不得请求第二张二维码或创建第二个扫码线程。"""
    client = FakeClient(get_responses=[FakeResponse({
        "ret": 0,
        "qrcode": "qr-id",
        "qrcode_img_content": "https://liteapp.weixin.qq.com/q/example?x=1",
    })])
    bridge, _ = make_bridge(tmp_path, client)

    first = bridge.connect()
    second = bridge.connect()

    assert first["state"] == second["state"] == "waiting"
    assert first["qr_uri"].startswith("data:image/svg+xml")
    assert set(first) == {"state", "qr_uri", "error", "since"}
    assert len(DeferredThread.created) == 1
    assert len(client.get_calls) == 1


def test_stale_qr_confirmation_cannot_replace_new_generation(tmp_path):
    """防回归：过期扫码请求晚返回时不能写入旧 Token。"""
    bridge, _ = make_bridge(tmp_path, FakeClient())
    bridge._generation = 4
    bridge._set(state="waiting")

    bridge._confirm_login(3, "stale-token")

    assert bridge.status()["state"] == "waiting"
    assert not (tmp_path / "wechat_token").exists()


def test_confirm_login_persists_private_token_and_starts_updates(tmp_path):
    """防回归：扫码确认必须持久化凭据并启动唯一消息轮询。"""
    bridge, _ = make_bridge(tmp_path, FakeClient())
    bridge._generation = 2
    bridge._set(state="waiting", qr_uri="data:image/svg+xml,qr")

    bridge._confirm_login(2, "secret-token")

    token_path = tmp_path / "wechat_token"
    assert token_path.read_text(encoding="utf-8") == "secret-token"
    assert token_path.stat().st_mode & 0o777 == 0o600
    assert bridge.status() == {
        "state": "connected", "qr_uri": "", "error": "", "since": ""
    }
    assert len(DeferredThread.created) == 1


def test_private_text_uses_contact_thread_and_sends_chunked_reply(tmp_path):
    """防回归：私聊必须进入联系人记忆线程，超长回复不得单包发送。"""
    sent = []
    client = FakeClient(sent=sent)
    bridge, agent_calls = make_bridge(tmp_path, client, reply="甲" * 3100)

    next_buf = bridge._handle_updates_response(client, "token", {
        "get_updates_buf": "next",
        "msgs": [{
            "message_type": 1,
            "from_user_id": "contact-123456789012@example",
            "context_token": "ctx",
            "item_list": [{"type": 1, "text_item": {"text": "你好"}}],
        }],
    })

    assert next_buf == "next"
    assert len(agent_calls) == 1 and agent_calls[0]["text"] == "你好"
    assert agent_calls[0]["thread_id"].startswith("tenant:")
    assert [len(item) for item in sent] == [1500, 1500, 100]


def test_group_and_non_text_messages_are_ignored(tmp_path):
    """防回归：默认安全边界不能误回复群聊或非文本消息。"""
    client = FakeClient()
    bridge, agent_calls = make_bridge(tmp_path, client)

    bridge._handle_updates_response(client, "token", {
        "get_updates_buf": "next",
        "msgs": [
            {
                "message_type": 1,
                "from_user_id": "g@im.chatroom",
                "context_token": "ctx1",
                "item_list": [{"type": 1, "text_item": {"text": "群消息"}}],
            },
            {
                "message_type": 2,
                "from_user_id": "person",
                "context_token": "ctx2",
                "item_list": [{"type": 3}],
            },
        ],
    })

    assert agent_calls == []
    assert client.sent == []


def test_unauthorized_update_clears_token_and_requires_rescan(tmp_path):
    """防回归：失效 Token 不能留下假在线状态。"""
    bridge, _ = make_bridge(tmp_path, FakeClient())
    bridge._generation = 1
    bridge._set(state="connected")
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")

    bridge._handle_unauthorized(1)

    assert bridge.status()["state"] == "idle"
    assert "重新扫码" in bridge.status()["error"]
    assert not (tmp_path / "wechat_token").exists()


def test_disconnect_invalidates_workers_and_deletes_token(tmp_path):
    """防回归：主动断开必须让当前代次失效并删除服务器凭据。"""
    bridge, _ = make_bridge(tmp_path, FakeClient())
    bridge._generation = 7
    bridge._set(state="connected")
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")

    result = bridge.disconnect()

    assert result == {"state": "idle", "qr_uri": "", "error": "", "since": ""}
    assert bridge._generation == 8
    assert bridge._updates_stop.is_set()
    assert not (tmp_path / "wechat_token").exists()


def test_resume_on_boot_starts_updates_without_deleting_token(tmp_path):
    """防回归：服务重启后必须复用持久化 Token 恢复在线。"""
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")
    bridge, _ = make_bridge(tmp_path, FakeClient())

    result = bridge.resume_on_boot()

    assert result["state"] == "connected"
    assert (tmp_path / "wechat_token").read_text(encoding="utf-8") == "saved"
    assert len(DeferredThread.created) == 1


def test_malformed_qr_response_becomes_retryable_error(tmp_path):
    """防回归：协议字段缺失时不得留在 loading 或泄露原始响应。"""
    client = FakeClient(get_responses=[FakeResponse({"ret": 0, "qrcode": "qr-id"})])
    bridge, _ = make_bridge(tmp_path, client)

    result = bridge.connect()

    assert result["state"] == "error"
    assert result["qr_uri"] == ""
    assert "响应异常" in result["error"]
    assert "qr-id" not in result["error"]


def test_updates_poll_read_timeout_undercuts_heartbeat_and_recycles_immediately(tmp_path):
    """iLink 心跳帧（实测约 18 秒一个）会重置 read 超时；read 超时不压到心跳
    间隔以下，僵死会话（心跳在发、响应永不完成、消息不派发）会无限挂起，
    表现为状态已连接却永远收不到消息（2026-08-12 线上事故）。超时翻新必须
    立即重发，不得按错误退避。"""

    class HeartbeatWedgedClient(FakeClient):
        def post(self, url, **kwargs):
            self.post_calls.append((url, kwargs))
            if len(self.post_calls) == 1:
                raise httpx.ReadTimeout("wedged long poll")
            return FakeResponse(status_code=401)

    class RecordingStop:
        def __init__(self):
            self.waits = []

        def is_set(self):
            return False

        def set(self):
            pass

        def wait(self, seconds):
            self.waits.append(seconds)

    client = HeartbeatWedgedClient()
    bridge, _ = make_bridge(tmp_path, client)
    bridge._generation = 1
    bridge._set(state="connected")
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")
    stop = RecordingStop()

    bridge._updates_loop(1, "saved", stop)

    assert len(client.post_calls) == 2
    timeout = client.post_calls[0][1]["timeout"]
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read is not None and timeout.read < 18
    assert stop.waits == []
    assert bridge.status()["state"] == "idle"


def test_updates_use_current_ilink_protocol_identity(tmp_path):
    """旧版 channel/client identity 会被 iLink 接受连接却不可靠派发消息。"""
    client = FakeClient(post_responses=[FakeResponse(status_code=401)])
    bridge, _ = make_bridge(tmp_path, client)
    bridge._generation = 1
    bridge._set(state="connected")
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")

    bridge._updates_loop(1, "saved", bridge._updates_stop)

    assert len(client.post_calls) == 1
    _url, request = client.post_calls[0]
    assert request["headers"]["iLink-App-Id"] == "bot"
    assert request["headers"]["iLink-App-ClientVersion"] == "132102"
    assert request["json"]["base_info"] == {
        "channel_version": "2.4.6",
        "bot_agent": "JWS-Agent",
    }


def test_api_level_expired_session_stops_polling_and_requires_rescan(tmp_path):
    """iLink 通过 HTTP 200 + errcode=-14 通知失效，不能继续假在线轮询。"""
    client = FakeClient(post_responses=[
        FakeResponse({"ret": 0, "errcode": -14, "msgs": []}),
        FakeResponse(status_code=401),
    ])
    bridge, _ = make_bridge(tmp_path, client)
    bridge._generation = 1
    bridge._set(state="connected")
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")

    bridge._updates_loop(1, "saved", bridge._updates_stop)

    assert len(client.post_calls) == 1
    assert bridge.status()["state"] == "idle"
    assert "重新扫码" in bridge.status()["error"]
    assert not (tmp_path / "wechat_token").exists()


def test_updates_cursor_survives_bridge_restart(tmp_path):
    """重启后必须延续 get_updates_buf，否则重启窗口内的微信消息会丢失。"""
    first, _ = make_bridge(tmp_path, FakeClient())
    first._handle_updates_response(
        FakeClient(), "saved", {"ret": 0, "msgs": [], "get_updates_buf": "cursor-1"}
    )

    client = FakeClient(post_responses=[FakeResponse(status_code=401)])
    resumed, _ = make_bridge(tmp_path, client)
    resumed._generation = 1
    resumed._set(state="connected")
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")

    resumed._updates_loop(1, "saved", resumed._updates_stop)

    assert client.post_calls[0][1]["json"]["get_updates_buf"] == "cursor-1"


def test_reply_uses_complete_ilink_send_contract(tmp_path):
    """缺 client_id/base_info 时 iLink 可能回 HTTP 200 但静默丢弃回复。"""
    client = FakeClient()
    bridge, _ = make_bridge(tmp_path, client)

    bridge._handle_updates_response(client, "saved", {
        "ret": 0,
        "get_updates_buf": "next",
        "msgs": [{
            "message_type": 1,
            "from_user_id": "contact@example",
            "context_token": "ctx",
            "item_list": [{"type": 1, "text_item": {"text": "你好"}}],
        }],
    })

    send = next(call for call in client.post_calls if call[0].endswith("/sendmessage"))
    payload = send[1]["json"]
    assert payload["base_info"] == {
        "channel_version": "2.4.6",
        "bot_agent": "JWS-Agent",
    }
    assert payload["msg"]["from_user_id"] == ""
    assert payload["msg"]["client_id"].startswith("jws-agent:")
