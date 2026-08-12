import base64
from contextlib import contextmanager

import pytest

from jarvis.provider_runtime import AgentRuntimeManager, RuntimeBundle, _PinnedSyncBackend
from jarvis.provider_settings import ProviderSettingsError, ResolvedLLM, SecretStore


class Resolver:
    def __init__(self, answers): self.answers = answers
    def resolve(self, host, port, timeout): return self.answers


class Backend:
    def __init__(self): self.calls = []
    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.calls.append((host, port)); return object()
    def sleep(self, seconds): pass


def _key(): return base64.urlsafe_b64encode(b"R" * 32).decode()


def test_pinned_backend_rejects_if_any_dns_answer_is_private_and_connects_approved_ip():
    backend = Backend()
    pinned = _PinnedSyncBackend(Resolver(("93.184.216.34",)), backend)
    pinned.connect_tcp("relay.example", 443, 3)
    assert backend.calls == [("93.184.216.34", 443)]
    blocked = _PinnedSyncBackend(Resolver(("93.184.216.34", "127.0.0.1")), backend)
    with pytest.raises(OSError, match="DNS_BLOCKED"):
        blocked.connect_tcp("relay.example", 443, 3)


class FakeProbe:
    def __init__(self, fail=False): self.fail = fail; self.calls = []
    def test(self, candidate):
        self.calls.append(candidate)
        if self.fail: raise ProviderSettingsError("TIMEOUT", "timeout")
        return {"ok": True, "stream_text": True, "stream_tool": True, "non_stream_tool": True}


class FakeService:
    def __init__(self): self.closed = False
    def close(self): self.closed = True


def factory(created):
    def build(user, llm, integrations):
        bundle = RuntimeBundle(user, llm.generation, object(), FakeService())
        created.append((bundle, llm.model, integrations))
        return bundle
    return build


def test_leases_pin_old_generation_until_stream_finishes(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_PROVIDER", "deepseek"); monkeypatch.setenv("JARVIS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("JARVIS_MODEL", "old"); monkeypatch.setenv("JARVIS_API_KEY", "env-key")
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    created = []; manager = AgentRuntimeManager(store, factory=factory(created), probe=FakeProbe(), checkpointer=False)
    with manager.acquire("u") as old:
        committed, _ = manager.apply_llm("u", {"provider": "openai", "base_url": "https://api.openai.com/v1", "model": "new", "api_key": "new-key"}, expected_generation=0)
        assert committed.generation == 1 and old.closed is False
        with manager.acquire("u") as new:
            assert (old.generation, new.generation) == (0, 1)
    assert old.closed is True


def test_probe_or_build_failure_keeps_generation_and_current_bundle(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_PROVIDER", "deepseek"); monkeypatch.setenv("JARVIS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("JARVIS_MODEL", "old"); monkeypatch.setenv("JARVIS_API_KEY", "env-key")
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    created = []; manager = AgentRuntimeManager(store, factory=factory(created), probe=FakeProbe(fail=True), checkpointer=False)
    with manager.acquire("u") as old:
        with pytest.raises(ProviderSettingsError):
            manager.apply_llm("u", {"provider": "openai", "base_url": "https://api.openai.com/v1", "model": "new", "api_key": "new-key"}, expected_generation=0)
        assert store.status("u", owner=False)["llm"]["generation"] == 0
        assert old.closed is False


def test_two_users_hold_distinct_runtime_generations(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_PROVIDER", "deepseek"); monkeypatch.setenv("JARVIS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("JARVIS_MODEL", "env"); monkeypatch.setenv("JARVIS_API_KEY", "env-key")
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    created = []; manager = AgentRuntimeManager(store, factory=factory(created), probe=FakeProbe(), checkpointer=False)
    manager.apply_llm("a", {"provider": "openai", "base_url": "https://api.openai.com/v1", "model": "a", "api_key": "a-key"}, expected_generation=0)
    with manager.acquire("a") as a, manager.acquire("b") as b:
        assert (a.generation, b.generation) == (1, 0)
        assert a is not b
