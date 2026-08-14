"""晨报电台：到点判定、成本护栏（通道不通不生成/失败不重烧）、语音+文字推送。"""
import datetime
from types import SimpleNamespace

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis import wechat
from jarvis.accounts import AccountStore
from jarvis.reminders import MorningRadio
from jarvis.tenancy import TenantStore, tenant_scope

from tests.test_wechat import FakeClient, FakeResponse, make_bridge


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


def _radio(now, *, compose, push, available=lambda: True):
    owner = AccountStore().unique_active_owner()
    return MorningRadio(
        owner_getter=lambda: owner, compose=compose, push_voice=push,
        push_available=available, now_fn=lambda: now)


def test_radio_fires_once_after_configured_time():
    TenantStore().set_pref("radio_time", "08:00")
    composed, pushed = [], []
    radio_early = _radio(datetime.datetime(2026, 8, 14, 7, 59),
                         compose=lambda o: composed.append(1) or "晨报内容",
                         push=lambda t: pushed.append(t) or True)
    assert radio_early.scan_once() is False and composed == []   # 没到点不生成

    radio = _radio(datetime.datetime(2026, 8, 14, 8, 1),
                   compose=lambda o: composed.append(1) or "晨报内容",
                   push=lambda t: pushed.append(t) or True)
    assert radio.scan_once() is True
    assert composed == [1] and pushed == ["晨报内容"]
    assert radio.scan_once() is False and composed == [1]        # 当日只发一次


def test_radio_skips_compose_when_channel_down_and_never_respins_after_failure():
    TenantStore().set_pref("radio_time", "08:00")
    composed = []
    down = _radio(datetime.datetime(2026, 8, 14, 8, 5),
                  compose=lambda o: composed.append(1) or "晨报",
                  push=lambda t: True, available=lambda: False)
    assert down.scan_once() is False and composed == []          # 通道不通不烧模型

    failing = _radio(datetime.datetime(2026, 8, 14, 8, 5),
                     compose=lambda o: composed.append(1) or "晨报",
                     push=lambda t: False)
    assert failing.scan_once() is False and composed == [1]
    assert failing.scan_once() is False and composed == [1]      # 失败也不重烧


def test_radio_window_expires_without_composing():
    TenantStore().set_pref("radio_time", "08:00")
    composed = []
    late = _radio(datetime.datetime(2026, 8, 14, 11, 30),
                  compose=lambda o: composed.append(1) or "晨报",
                  push=lambda t: True)
    assert late.scan_once() is False and composed == []          # 过窗作罢，明天再来


def test_push_voice_then_text_degrades_and_delivers(tmp_path):
    sent = []
    client = FakeClient(sent=sent)
    bridge, _ = make_bridge(tmp_path, client)
    bridge._voice = SimpleNamespace(
        voice_reply_items=lambda text: [{"type": 34, "voice_item": {"voice_data": "aGV4"}}])
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")
    bridge._set(state="connected")
    bridge._save_push_target("contact-a@ilink", "ctx")

    assert bridge.push_available() is True
    assert bridge.push_voice_then_text("今日晨报……") is True
    voice_posts = [k for _u, k in client.post_calls
                   if k["json"]["msg"]["item_list"][0].get("type") == 34]
    assert len(voice_posts) == 1 and sent == ["今日晨报……"]      # 语音条 + 文字各一

    import jarvis.wechat_voice as wechat_voice
    bridge._voice = SimpleNamespace(voice_reply_items=lambda text: (_ for _ in ()).throw(
        wechat_voice.VoiceError("no tts")))
    assert bridge.push_voice_then_text("只有文字的晨报") is True   # 语音失败降级纯文字
    assert sent[-1] == "只有文字的晨报"


def test_radio_rest_roundtrip():
    c = TestClient(server_mod.app)
    assert c.get("/api/radio").status_code == 401
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    assert c.get("/api/radio").json() == {"time": ""}
    assert c.put("/api/radio", json={"time": "08:30"}).status_code == 200
    assert c.get("/api/radio").json() == {"time": "08:30"}
    assert c.put("/api/radio", json={"time": "8点半"}).status_code == 422
    assert c.put("/api/radio", json={"time": ""}).status_code == 200   # 清空=关闭
    assert c.get("/api/radio").json() == {"time": ""}
