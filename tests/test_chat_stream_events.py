"""聊天 SSE 工具事件契约：tool_start 带 id，tool_result 带 id/ok/ms/detail。"""
import json
from contextlib import contextmanager
from types import SimpleNamespace

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
from jarvis.tenancy import tenant_scope
from langchain_core.messages import AIMessageChunk, ToolMessage


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


class FakeAgent:
    def stream(self, _payload, config=None, stream_mode=None):
        yield AIMessageChunk(content="", tool_call_chunks=[
            {"name": "now", "id": "call-1", "args": "", "index": 0, "type": "tool_call_chunk"},
        ]), {}
        yield ToolMessage(content="2026-08-14 17:00", name="now", tool_call_id="call-1"), {}
        yield AIMessageChunk(content="现在是下午五点。"), {}


def test_tool_events_carry_id_ok_ms_and_detail(monkeypatch):
    @contextmanager
    def fake_bundle(_user_id):
        yield SimpleNamespace(agent=FakeAgent())

    monkeypatch.setattr(server_mod, "_bundle_for", fake_bundle)
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]

    r = c.post("/api/chat", json={"message": "现在几点", "thread_id": "t-sse"})
    assert r.status_code == 200
    events = [json.loads(line[6:]) for line in r.text.split("\n\n") if line.startswith("data: ")]
    kinds = [e["type"] for e in events]
    assert kinds == ["tool_start", "tool_result", "token", "done"]

    start = events[0]
    assert start["name"] == "now" and start["id"] == "call-1"
    result = events[1]
    assert result["name"] == "now" and result["id"] == "call-1"
    assert result["ok"] is True
    assert isinstance(result["ms"], int) and result["ms"] >= 0
    assert result["detail"] == "2026-08-14 17:00"
