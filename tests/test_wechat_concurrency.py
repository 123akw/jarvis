"""微信消息并发处理：入队即返回、按发信人串行、不同发信人互不等待。"""
import threading
import time
from types import SimpleNamespace

from jarvis import wechat
from jarvis.accounts import AccountStore


class FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self.payload = payload if payload is not None else {"ret": 0}
        self.status_code = status_code

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class RecordingClient:
    """线程安全地记录 sendmessage 的目标、内容与时刻。"""

    def __init__(self):
        self._lock = threading.Lock()
        self.sends = []  # (to_user_id, text, monotonic)

    def post(self, url, **kwargs):
        if url.endswith("/sendmessage"):
            message = kwargs["json"]["msg"]
            text = message["item_list"][0]["text_item"]["text"]
            with self._lock:
                self.sends.append((message["to_user_id"], text, time.monotonic()))
        return FakeResponse()

    def get(self, url, **kwargs):
        raise AssertionError(f"unexpected GET {url}")

    def close(self):
        pass

    def sent_to(self, to_user_id):
        with self._lock:
            return [item for item in self.sends if item[0] == to_user_id]


class InertThread:
    """长轮询线程占位：只登记不运行，让测试自己驱动消息处理入口。"""

    def __init__(self, target, args=(), daemon=False, name=None):
        self.target, self.args, self.daemon, self.name = target, args, daemon, name

    def start(self):
        pass

    def is_alive(self):
        return False


def _message(from_id, text):
    return {
        "message_type": 1,
        "from_user_id": from_id,
        "context_token": "ctx",
        "item_list": [{"type": 1, "text_item": {"text": text}}],
    }


def make_connected_bridge(tmp_path, invoke):
    """走真实 _confirm_login 建立带回复工作池的连接态桥。"""
    client = RecordingClient()

    class Agent:
        def invoke(self, state, config):
            return invoke(state["messages"][0]["content"])

    bridge = wechat.WeChatBridge(
        agent_getter=lambda: Agent(),
        chunk_text=lambda content: str(content),
        data_dir_getter=lambda: tmp_path,
        client_factory=lambda: client,
        thread_factory=InertThread,
        sleeper=lambda _seconds: None,
        owner_getter=lambda: (
            AccountStore()._ensure_bootstrap() or AccountStore().unique_active_owner()
        ),
    )
    bridge._generation = 1
    bridge._set(state="waiting")
    assert bridge._confirm_login(1, "token")
    assert bridge._dispatcher is not None, "连接态必须持有回复工作池"
    return bridge, client


def _wait_until(predicate, timeout=8.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_slow_reply_does_not_block_other_sender(tmp_path):
    """用户 A 的回复慢 3 秒时，用户 B 的回复不等 A；长轮询线程入队即返回。"""

    def invoke(text):
        if text == "慢问题":
            time.sleep(3)
        return {"messages": [SimpleNamespace(content=f"回复:{text}")]}

    bridge, client = make_connected_bridge(tmp_path, invoke)

    start = time.monotonic()
    next_buf = bridge._handle_updates_response(client, "token", {
        "get_updates_buf": "next",
        "msgs": [
            _message("alice@example", "慢问题"),
            _message("bob@example", "快问题"),
        ],
    })
    enqueue_elapsed = time.monotonic() - start

    assert next_buf == "next"
    assert enqueue_elapsed < 1.0, "长轮询线程必须入队即返回，不得等待回复计算"
    assert _wait_until(lambda: client.sent_to("bob@example"), timeout=2.5), (
        "B 的回复必须在 A 的 3 秒慢回复完成之前送达"
    )
    bob_done_at = client.sent_to("bob@example")[0][2]
    assert bob_done_at - start < 2.5, "B 的回复耗时不得包含 A 的 3 秒"
    assert not client.sent_to("alice@example"), "此刻 A 还没算完，不该已有 A 的回复"
    assert bridge._dispatcher.drain(10)
    assert [text for _to, text, _at in client.sent_to("alice@example")] == ["回复:慢问题"]


def test_same_sender_replies_keep_message_order(tmp_path):
    """同一发信人的消息必须串行：第一条慢也不能被第二条超车。"""

    def invoke(text):
        if text == "第一条":
            time.sleep(0.5)
        return {"messages": [SimpleNamespace(content=f"回复:{text}")]}

    bridge, client = make_connected_bridge(tmp_path, invoke)
    bridge._handle_updates_response(client, "token", {
        "get_updates_buf": "next",
        "msgs": [
            _message("alice@example", "第一条"),
            _message("alice@example", "第二条"),
        ],
    })

    assert bridge._dispatcher.drain(10)
    texts = [text for _to, text, _at in client.sent_to("alice@example")]
    assert texts == ["回复:第一条", "回复:第二条"]


def test_reply_worker_pool_is_bounded_and_parallel(tmp_path):
    """不同发信人真并行，但总并发不得超过 REPLY_WORKERS 上限。"""
    lock = threading.Lock()
    state = {"running": 0, "peak": 0}

    def invoke(_text):
        with lock:
            state["running"] += 1
            state["peak"] = max(state["peak"], state["running"])
        time.sleep(0.4)
        with lock:
            state["running"] -= 1
        return {"messages": [SimpleNamespace(content="收到")]}

    bridge, client = make_connected_bridge(tmp_path, invoke)
    bridge._handle_updates_response(client, "token", {
        "get_updates_buf": "next",
        "msgs": [_message(f"user-{i}@example", f"问题{i}") for i in range(8)],
    })

    assert bridge._dispatcher.drain(20)
    assert len(client.sends) == 8
    assert state["peak"] <= wechat.REPLY_WORKERS, "总并发不得超过工作池上限"
    assert state["peak"] >= 2, "工作池必须真的并行处理不同发信人"


def test_disconnect_stops_reply_dispatcher(tmp_path):
    """断开连接后回复工作池必须停止接收新任务。"""

    def invoke(text):
        return {"messages": [SimpleNamespace(content=f"回复:{text}")]}

    bridge, client = make_connected_bridge(tmp_path, invoke)
    dispatcher = bridge._dispatcher
    bridge.disconnect()

    assert bridge._dispatcher is None
    assert dispatcher.submit("alice@example", lambda: None) is False
