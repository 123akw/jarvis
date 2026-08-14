"""每用户语音音色/语速：REST 设置、偏好落库、TTS 会话参数化。"""
import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
from jarvis.tenancy import TenantStore, tenant_scope
from jarvis.voice.gateway import VOICE_CATALOG, tts_prefs_for
from jarvis.voice.tts import TTSSession


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


def _authed_client():
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def test_voice_settings_roundtrip_and_validation():
    c = _authed_client()
    initial = c.get("/api/voice/settings").json()
    assert initial["voice"] == "male-qn-qingse" and initial["speed"] == 1.0
    assert {item["id"] for item in initial["catalog"]} == {item["id"] for item in VOICE_CATALOG}

    assert c.put("/api/voice/settings", json={"voice": "female-yujie", "speed": 1.2}).status_code == 200
    saved = c.get("/api/voice/settings").json()
    assert saved["voice"] == "female-yujie" and saved["speed"] == 1.2

    assert c.put("/api/voice/settings", json={"voice": "not-a-voice", "speed": 1.0}).status_code == 422
    assert c.put("/api/voice/settings", json={"voice": "female-yujie", "speed": 9}).status_code == 422
    assert TestClient(server_mod.app).get("/api/voice/settings").status_code == 401


def test_gateway_resolves_user_tts_prefs():
    owner = AccountStore().unique_active_owner()
    assert tts_prefs_for(owner.user_id) == {}          # 未配置：零参调用工厂
    store = TenantStore()
    store.set_pref("tts_voice", "presenter_female")
    store.set_pref("tts_speed", "1.30")
    assert tts_prefs_for(owner.user_id) == {"voice_id": "presenter_female", "speed": 1.3}


def test_tts_session_accepts_voice_and_clamps_speed(monkeypatch):
    monkeypatch.setenv("MINIMAX_API_KEY", "test-key")
    s = TTSSession(voice_id="female-yujie", speed=1.3)
    assert s.voice_id == "female-yujie" and s.speed == 1.3
    assert TTSSession(speed=9.9).speed == 2.0          # 越界收敛
    assert TTSSession(speed=0.1).speed == 0.5
    assert TTSSession().speed == 1.0
