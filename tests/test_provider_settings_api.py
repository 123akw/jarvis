import base64
import json
from pathlib import Path

import pytest

from jarvis.provider_settings import ConfigConflict, ManagedConfigUnavailable, ProviderSettingsError, SecretStore
from jarvis.provider_runtime import AgentRuntimeManager, RuntimeBundle
from jarvis.accounts import AccountStore
import jarvis.server as server_mod
from fastapi.testclient import TestClient


def _key(byte=b"K"):
    return base64.urlsafe_b64encode(byte * 32).decode()


def _candidate(key="user-fake-key"):
    return {"provider": "openai", "base_url": "https://api.openai.com/v1", "model": "gpt-test", "api_key": key}


def test_secret_store_is_per_user_encrypted_and_never_serializes_keys(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_PROVIDER", "deepseek")
    monkeypatch.setenv("JARVIS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("JARVIS_MODEL", "env-model")
    monkeypatch.setenv("JARVIS_API_KEY", "environment-fake-key")
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)

    first = store.commit_llm("user-a", _candidate("alpha-fake-key"), expected_generation=0)
    second = store.commit_llm("user-b", {**_candidate("beta-fake-key"), "model": "other"}, expected_generation=0)

    assert (first.api_key, second.api_key) == ("alpha-fake-key", "beta-fake-key")
    assert store.resolved_llm("user-a").model == "gpt-test"
    assert store.resolved_llm("user-b").model == "other"
    status = json.dumps(store.status("user-a", owner=False), ensure_ascii=False)
    disk = b"".join(path.read_bytes() for path in tmp_path.rglob("*.*") if path.is_file())
    assert "alpha-fake-key" not in status and b"alpha-fake-key" not in disk
    assert store.manifest.stat().st_mode & 0o777 == 0o600
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in store.generations.glob("*.enc"))


def test_generation_cas_and_credential_scope_require_a_new_key(tmp_path):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    store.commit_llm("u", _candidate(), expected_generation=0)
    with pytest.raises(ConfigConflict):
        store.commit_llm("u", _candidate(), expected_generation=0)
    kept = store.commit_llm("u", {**_candidate(""), "model": "gpt-next"}, expected_generation=1, keep_existing_key=True)
    assert kept.api_key == "user-fake-key"
    with pytest.raises(ProviderSettingsError) as error:
        store.commit_llm("u", {"provider": "custom", "base_url": "https://relay.example/v1", "model": "x", "api_key": ""}, expected_generation=2, keep_existing_key=True)
    assert error.value.code == "PROVIDER_AUTH"


def test_corrupt_active_generation_recovers_previous_and_missing_master_fails_closed(tmp_path):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    store.commit_llm("u", _candidate("one-fake-key"), expected_generation=0)
    store.commit_llm("u", {**_candidate("two-fake-key"), "model": "two"}, expected_generation=1)
    active = json.loads(store.manifest.read_text())["active_generation"]
    (store.generations / f"{active}.enc").write_bytes(b"damaged")
    recovered = store.resolved_llm("u")
    assert recovered.model == "gpt-test" and recovered.api_key == "one-fake-key"
    with pytest.raises(ManagedConfigUnavailable):
        SecretStore(tmp_path, master_key="", write_enabled=False).status("u", owner=False)


def test_delete_restores_environment_without_requiring_key_for_later_reads(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_PROVIDER", "deepseek")
    monkeypatch.setenv("JARVIS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("JARVIS_MODEL", "env-model")
    monkeypatch.setenv("JARVIS_API_KEY", "env-fake-key")
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    store.commit_llm("u", _candidate(), expected_generation=0)
    restored = store.delete_llm("u", expected_generation=1)
    assert restored.source == "environment" and restored.model == "env-model" and restored.generation == 2
    without_key = SecretStore(tmp_path, master_key="", write_enabled=False).resolved_llm("u")
    assert without_key.source == "environment" and without_key.generation == 2


@pytest.mark.parametrize("url", [
    "http://relay.example/v1", "https://user:pw@relay.example/v1",
    "https://relay.example/v1?key=x", "https://relay.example/v1#secret",
])
def test_custom_provider_rejects_unsafe_urls(tmp_path, url):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    with pytest.raises(ProviderSettingsError) as error:
        store.commit_llm("u", {"provider": "custom", "base_url": url, "model": "x", "api_key": "fake"}, expected_generation=0)
    assert error.value.code == "INVALID_URL"


def test_owner_integrations_are_global_and_managed_disable_overrides_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("TAVILY_API_KEY", "environment-tavily")
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    disabled = store.commit_integration("tavily", {"enabled": False, "api_key": ""}, expected_generation=0)
    assert disabled == {"enabled": False, "source": "managed", "key_configured": False, "healthy": None, "generation": 1}
    assert store.integration_values()["tavily"]["enabled"] is False
    assert store.status("member", owner=False)["integrations"] == {}


def test_searxng_environment_status_matches_the_effective_url(tmp_path, monkeypatch):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    assert store.status("owner", owner=True)["integrations"]["searxng"] == {
        "enabled": False, "source": "environment", "key_configured": False,
        "healthy": None, "generation": 0, "base_url": "",
    }
    monkeypatch.setenv("SEARXNG_BASE_URL", "http://127.0.0.1:18888")
    status = store.status("owner", owner=True)["integrations"]["searxng"]
    assert status["enabled"] is True and status["base_url"] == "http://127.0.0.1:18888"


def test_updating_one_integration_preserves_other_encrypted_keys(tmp_path):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    store.commit_integration("tavily", {"enabled": True, "api_key": "tavily-fake-key"}, expected_generation=0)
    store.commit_integration("pandascore", {"enabled": True, "api_key": "panda-fake-key"}, expected_generation=1)
    values = store.integration_values()
    assert values["tavily"]["api_key"] == "tavily-fake-key"
    assert values["pandascore"]["api_key"] == "panda-fake-key"


def test_no_secret_field_or_repr_leaks_from_public_status(tmp_path):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    store.commit_llm("u", _candidate("sensitive-fake-key"), expected_generation=0)
    public = store.status("u", owner=True)
    assert "sensitive-fake-key" not in repr(public)
    assert not any("secret" in key or "api_key" in key for key in public["llm"])


class _Probe:
    def test(self, candidate):
        return {"ok": True, "latency_ms": 1, "non_stream_tool": True, "stream_text": True, "stream_tool": True}


class _Search:
    def close(self): pass


def _factory(user, llm, integrations):
    return RuntimeBundle(user, llm.generation, object(), _Search())


def _web_login(client):
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    return client.get("/api/session").json()["csrf_token"]


def test_settings_api_is_tenant_scoped_cas_protected_and_never_reads_back_key(tmp_path, monkeypatch):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    manager = AgentRuntimeManager(store, factory=_factory, probe=_Probe(), checkpointer=False)
    monkeypatch.setattr(server_mod, "_provider_store", store)
    monkeypatch.setattr(server_mod, "_runtime_manager", manager)
    client = TestClient(server_mod.app)
    csrf = _web_login(client)
    body = {"provider": "openai", "base_url": "https://api.openai.com/v1", "model": "gpt-test",
            "api_key": "api-fake-secret", "admin_password": "admin", "expected_generation": 0}

    tested = client.post("/api/settings/llm/test", headers={"X-JWS-CSRF": csrf}, json=body)
    saved = client.put("/api/settings/llm", headers={"X-JWS-CSRF": csrf}, json=body)
    stale = client.put("/api/settings/llm", headers={"X-JWS-CSRF": csrf}, json=body)
    status = client.get("/api/settings/providers")

    assert tested.status_code == 200 and tested.json()["stream_tool"] is True
    assert saved.status_code == 200 and saved.json()["llm"]["generation"] == 1
    assert stale.status_code == 409 and stale.json()["code"] == "CONFIG_CONFLICT"
    rendered = tested.text + saved.text + stale.text + status.text
    assert "api-fake-secret" not in rendered and '"api_key":' not in status.text
    assert status.headers["cache-control"] == "no-store"


def test_member_can_manage_only_own_llm_and_cannot_manage_global_search(tmp_path, monkeypatch):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    manager = AgentRuntimeManager(store, factory=_factory, probe=_Probe(), checkpointer=False)
    monkeypatch.setattr(server_mod, "_provider_store", store)
    monkeypatch.setattr(server_mod, "_runtime_manager", manager)
    accounts = AccountStore(); accounts._ensure_bootstrap()
    assert accounts.create_user("member", "member-password", "Member")
    client = TestClient(server_mod.app)
    assert client.post("/api/login", json={"username": "member", "password": "member-password"}).status_code == 200
    csrf = client.get("/api/session").json()["csrf_token"]

    status = client.get("/api/settings/providers").json()
    denied = client.put("/api/settings/integrations/tavily", headers={"X-JWS-CSRF": csrf}, json={
        "enabled": False, "admin_password": "member-password", "expected_generation": 0,
    })
    own = client.put("/api/settings/llm", headers={"X-JWS-CSRF": csrf}, json={
        "provider": "deepseek", "base_url": "https://api.deepseek.com", "model": "member-model",
        "api_key": "member-fake-key", "admin_password": "member-password", "expected_generation": 0,
    })

    assert status["integrations"] == {}
    assert denied.status_code == 403
    assert own.status_code == 200
    assert store.status("not-member", owner=False)["llm"]["source"] == "environment"


def test_settings_validation_and_auth_errors_do_not_echo_secret_fields(tmp_path, monkeypatch):
    store = SecretStore(tmp_path, master_key=_key(), write_enabled=True)
    monkeypatch.setattr(server_mod, "_provider_store", store)
    monkeypatch.setattr(server_mod, "_runtime_manager", AgentRuntimeManager(store, factory=_factory, probe=_Probe(), checkpointer=False))
    client = TestClient(server_mod.app); csrf = _web_login(client)
    bad = client.put("/api/settings/llm", headers={"X-JWS-CSRF": csrf}, json={
        "provider": "openai", "model": "x", "api_key": "never-echo-fake-key",
        "admin_password": "wrong-never-echo", "expected_generation": "not-an-int",
    })
    assert bad.status_code == 422
    assert "never-echo" not in bad.text and "not-an-int" not in bad.text
