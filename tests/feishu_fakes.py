"""飞书测试替身：用 httpx.MockTransport 模拟开放平台 HTTP，用内存队列模拟长连接。

只替换网络边界；FeishuAPI / LongConnection / FeishuBridge 走真实实现。
"""
from __future__ import annotations

import json
import queue
import re
from contextlib import contextmanager
from types import SimpleNamespace

import httpx
from langchain_core.messages import AIMessageChunk, ToolMessage

from jarvis.channels.feishu.frame import METHOD_DATA, Frame

APP_ID, APP_SECRET = "cli_test_app", "test-secret"


class FakeFeishu:
    """一个最小的「飞书开放平台」：按路径路由，记录每次调用，可注入错误码。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.token_count = 0
        self.expire = 7200
        self.revoked: set[str] = set()
        self.failures: dict[tuple[str, str], list[int]] = {}
        self.cards: dict[str, dict] = {}
        self.replies: list[dict] = []
        self.sent: list[dict] = []
        self.reactions: list[tuple[str, str]] = []
        self.resources: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.bot = {"open_id": "ou_bot", "app_name": "贾维斯", "activate_status": 2}
        self.endpoint = {"code": 0, "data": {
            "URL": "wss://ws.example.test/ws?device_id=dev-1&service_id=77",
            "ClientConfig": {"PingInterval": 90, "ReconnectInterval": 60, "ReconnectNonce": 10, "ReconnectCount": -1},
        }}

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))

    def fail(self, method: str, path_regex: str, *codes: int) -> None:
        """下一次（或几次）匹配的请求返回这些错误码。"""
        self.failures[(method, path_regex)] = list(codes)

    def _injected(self, method: str, path: str) -> int | None:
        for (m, pattern), codes in self.failures.items():
            if m == method and re.search(pattern, path) and codes:
                return codes.pop(0)
        return None

    @staticmethod
    def _json(payload: dict, status: int = 200) -> httpx.Response:
        return httpx.Response(status, json=payload)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else None
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        self.calls.append({"method": method, "path": path, "json": body, "token": token,
                           "params": dict(request.url.params)})
        if path == "/callback/ws/endpoint":
            assert body == {"AppID": APP_ID, "AppSecret": APP_SECRET}
            return self._json(self.endpoint)
        if path == "/open-apis/auth/v3/tenant_access_token/internal":
            if body != {"app_id": APP_ID, "app_secret": APP_SECRET}:
                return self._json({"code": 10014, "msg": "app secret invalid"}, 400)
            self.token_count += 1
            return self._json({"code": 0, "msg": "ok", "tenant_access_token": f"t-{self.token_count}",
                               "expire": self.expire})
        if not token.startswith("t-") or token in self.revoked:
            return self._json({"code": 99991663, "msg": "Invalid access token for authorization."}, 400)
        injected = self._injected(method, path)
        if injected is not None:
            return self._json({"code": injected, "msg": "injected failure"}, 400)
        if path == "/open-apis/bot/v3/info":
            return self._json({"code": 0, "msg": "ok", "bot": self.bot})
        if m := re.fullmatch(r"/open-apis/im/v1/messages/([^/]+)/reply", path):
            self.replies.append({"message_id": m.group(1), "msg_type": body["msg_type"],
                                 "content": json.loads(body["content"]),
                                 "in_thread": body.get("reply_in_thread", False), "uuid": body.get("uuid")})
            return self._json({"code": 0, "data": {"message_id": f"om_reply_{len(self.replies)}"}})
        if path == "/open-apis/im/v1/messages" and method == "POST":
            self.sent.append({"receive_id_type": request.url.params.get("receive_id_type"),
                              "receive_id": body["receive_id"], "msg_type": body["msg_type"],
                              "content": json.loads(body["content"])})
            return self._json({"code": 0, "data": {"message_id": f"om_sent_{len(self.sent)}"}})
        if path == "/open-apis/cardkit/v1/cards" and method == "POST":
            card_id = f"card-{len(self.cards) + 1}"
            self.cards[card_id] = {"spec": json.loads(body["data"]), "updates": [], "settings": [], "seq": 0}
            return self._json({"code": 0, "data": {"card_id": card_id}})
        if m := re.fullmatch(r"/open-apis/cardkit/v1/cards/([^/]+)/elements/([^/]+)/content", path):
            card = self.cards[m.group(1)]
            if body["sequence"] <= card["seq"]:
                return self._json({"code": 300317, "msg": "sequence not increasing"}, 400)
            card["seq"] = body["sequence"]
            card["updates"].append(body["content"])
            return self._json({"code": 0, "data": {}})
        if m := re.fullmatch(r"/open-apis/cardkit/v1/cards/([^/]+)/settings", path):
            card = self.cards[m.group(1)]
            if body["sequence"] <= card["seq"]:
                return self._json({"code": 300317, "msg": "sequence not increasing"}, 400)
            card["seq"] = body["sequence"]
            card["settings"].append(json.loads(body["settings"]))
            return self._json({"code": 0, "data": {}})
        if m := re.fullmatch(r"/open-apis/im/v1/messages/([^/]+)/reactions", path):
            self.reactions.append(("add", m.group(1)))
            return self._json({"code": 0, "data": {"reaction_id": "react-1"}})
        if m := re.fullmatch(r"/open-apis/im/v1/messages/([^/]+)/reactions/([^/]+)", path):
            self.reactions.append(("delete", m.group(1)))
            return self._json({"code": 0, "data": {}})
        if m := re.fullmatch(r"/open-apis/im/v1/messages/([^/]+)/resources/([^/]+)", path):
            data, ctype = self.resources.get((m.group(1), m.group(2)), (None, ""))
            if data is None:
                return self._json({"code": 234003, "msg": "File not in msg."}, 400)
            return httpx.Response(200, content=data, headers={"content-type": ctype})
        return self._json({"code": 404, "msg": f"unknown route {method} {path}"}, 404)

    def paths(self) -> list[str]:
        return [f"{c['method']} {c['path']}" for c in self.calls]


class FakeWS:
    """内存版 WebSocket：测试往 inbox 塞帧；send 的帧进 outbox。"""

    def __init__(self, frames=()) -> None:
        self.inbox: queue.Queue = queue.Queue()
        for frame in frames:
            self.inbox.put(frame)
        self.outbox: list[Frame] = []
        self.closed = False

    def recv(self, timeout=None):
        if self.closed:
            raise ConnectionError("closed")
        try:
            item = self.inbox.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError from None
        if isinstance(item, BaseException):
            raise item
        return item

    def send(self, data: bytes) -> None:
        self.outbox.append(Frame.decode(data))

    def close(self) -> None:
        self.closed = True


def event_frame(event: dict, *, seq_id: int = 1, message_id: str = "frame-msg-1") -> bytes:
    return Frame(seq_id=seq_id, log_id=9, service=77, method=METHOD_DATA, headers=[
        ("type", "event"), ("message_id", message_id), ("sum", "1"), ("seq", "0"), ("trace_id", "trace-1"),
    ], payload=json.dumps(event, ensure_ascii=False).encode("utf-8")).encode()


def message_event(text: str = "你好", *, message_id: str = "om_1", event_id: str = "ev_1",
                  chat_type: str = "p2p", chat_id: str = "oc_p2p_chat_0000000001", open_id: str = "ou_alice",
                  sender_type: str = "user", mentions=None, msg_type: str = "text", content: dict | None = None,
                  thread_id: str = "", create_time: str = "") -> dict:
    message = {
        "message_id": message_id, "chat_id": chat_id, "chat_type": chat_type,
        "message_type": msg_type,
        "content": json.dumps(content if content is not None else {"text": text}, ensure_ascii=False),
        "mentions": mentions or [],
    }
    if thread_id:
        message["thread_id"] = thread_id
    if create_time:
        message["create_time"] = create_time
    return {
        "schema": "2.0",
        "header": {"event_id": event_id, "event_type": "im.message.receive_v1", "app_id": APP_ID,
                   "create_time": "1", "token": "", "tenant_key": "tk"},
        "event": {"sender": {"sender_id": {"open_id": open_id, "union_id": "on_x"}, "sender_type": sender_type,
                             "tenant_key": "tk"},
                  "message": message},
    }


def bot_mention(key: str = "@_user_1", open_id: str = "ou_bot", name: str = "贾维斯") -> dict:
    return {"key": key, "id": {"open_id": open_id}, "name": name, "mentioned_type": "bot", "tenant_key": "tk"}


class FakeAgent:
    """记录调用；stream 按给定片段吐 AIMessageChunk，可在中间插一次工具调用。"""

    def __init__(self, reply: str = "收到", *, chunks=None, tool: str | None = None, error: Exception | None = None):
        self.reply, self.chunks, self.tool, self.error = reply, chunks, tool, error
        self.calls: list[dict] = []

    def _record(self, inputs, config, mode):
        self.calls.append({"text": inputs["messages"][0]["content"],
                           "thread_id": config["configurable"]["thread_id"], "mode": mode})
        if self.error is not None:
            raise self.error

    def invoke(self, inputs, config):
        self._record(inputs, config, "invoke")
        return {"messages": [SimpleNamespace(content=self.reply)]}

    def stream(self, inputs, config, stream_mode):
        self._record(inputs, config, stream_mode)
        if self.tool:
            yield AIMessageChunk(content="我查一下。", tool_call_chunks=[
                {"name": self.tool, "args": "{}", "id": "call-1", "index": 0}]), {}
            yield ToolMessage(content="ok", tool_call_id="call-1", name=self.tool), {}
        for part in self.chunks or [self.reply]:
            yield AIMessageChunk(content=part), {}


def bundle_for_agent(agent):
    @contextmanager
    def bundle_for(_user_id):
        yield SimpleNamespace(agent=agent)
    return bundle_for
