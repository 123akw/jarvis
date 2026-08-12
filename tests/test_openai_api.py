"""OpenAI 兼容接口测试：认证与响应结构，模型层打桩不联网。"""
import jarvis.server as server_mod
from fastapi.testclient import TestClient


class _FakeMsg:
    def __init__(self, content):
        self.content = content
        self.type = "ai"


class _FakeAgent:
    def invoke(self, state, config=None):
        return {"messages": [_FakeMsg("你好，领导。")]}


def _patch_agent(monkeypatch):
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _FakeAgent())


def _token():
    c = TestClient(server_mod.app)
    return c.post("/api/desktop/login", json={"username": "admin", "password": "admin"}).json()["openai_token"]


def test_oai_requires_auth():
    r = TestClient(server_mod.app).post("/v1/chat/completions", json={
        "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 401


def test_oai_bearer_token_and_shape(monkeypatch):
    _patch_agent(monkeypatch)
    tok = _token()
    r = TestClient(server_mod.app).post("/v1/chat/completions",
        headers={"Authorization": f"Bearer {tok}"},
        json={"model": "jarvis", "messages": [{"role": "user", "content": "在吗"}]})
    assert r.status_code == 200
    d = r.json()
    assert d["object"] == "chat.completion"
    assert d["choices"][0]["message"]["content"] == "你好，领导。"


def test_oai_bad_bearer_rejected():
    r = TestClient(server_mod.app).post("/v1/chat/completions",
        headers={"Authorization": "Bearer wrongwrongwrong"},
        json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 401


def test_oai_empty_message_rejected(monkeypatch):
    _patch_agent(monkeypatch)
    tok = _token()
    r = TestClient(server_mod.app).post("/v1/chat/completions",
        headers={"Authorization": f"Bearer {tok}"},
        json={"messages": [{"role": "assistant", "content": "x"}]})
    assert r.status_code == 400
