"""F6 送达与免打扰：账号级渠道开关、免打扰攒消息与合并、各主动来源按偏好分发、设置接口。"""
import datetime
import json

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis import delivery
from jarvis.accounts import AccountStore
from jarvis.heartbeat import HeartbeatScanner, PendingOutbox, SentLog
from jarvis.reminders import MorningRadio, ReminderScanner
from jarvis.tenancy import TenantStore, tenant_scope

NIGHT = datetime.datetime(2026, 10, 2, 23, 10)
MORNING = datetime.datetime(2026, 10, 3, 8, 1)


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


@pytest.fixture
def owner():
    return AccountStore().unique_active_owner()


def _notifier(owner, sent, outbox=None):
    return delivery.Notifier(
        push_wechat=lambda t: sent.append(("wechat", t)) or True, wechat_user=lambda: owner.user_id,
        push_feishu=lambda uid, t: sent.append(("feishu", t)) or True, outbox=outbox)


# ---------- 偏好 ----------

def test_prefs_default_to_all_channels_and_no_quiet_hours():
    prefs = delivery.load_prefs(TenantStore())
    assert prefs.channels == frozenset(delivery.CHANNELS) and prefs.dnd is None
    assert not prefs.quiet(NIGHT)


def test_prefs_parse_channels_and_cross_midnight_dnd():
    store = TenantStore()
    store.set_pref(delivery.PREF_CHANNELS, '["feishu", "web", "bogus"]')
    store.set_pref(delivery.PREF_DND, "22:30-08:00")
    prefs = delivery.load_prefs(store)
    assert prefs.channels == {"feishu", "web"}
    assert prefs.quiet(NIGHT) and prefs.quiet(datetime.datetime(2026, 10, 3, 7, 59)) and not prefs.quiet(MORNING)
    store.set_pref(delivery.PREF_CHANNELS, "not json")
    assert delivery.load_prefs(store).channels == frozenset(delivery.CHANNELS)   # 坏了宁可多送


# ---------- 免打扰：攒着、结束后合并成一条 ----------

def test_notifier_holds_during_quiet_hours_and_flushes_once(owner):
    TenantStore().set_pref(delivery.PREF_DND, "22:30-08:00")
    sent, outbox = [], PendingOutbox()
    notifier = _notifier(owner, sent, outbox)
    assert notifier.send(owner.user_id, "记得给妈妈回电话", NIGHT) is True
    assert notifier.send(owner.user_id, "明早九点交周报", NIGHT.replace(minute=40)) is True
    assert sent == [] and outbox.drain(owner.user_id) == []
    assert notifier.flush(owner.user_id, datetime.datetime(2026, 10, 3, 7, 0)) is False   # 还在免打扰
    assert notifier.flush(owner.user_id, MORNING) is True
    expected = "免打扰期间攒下 2 条消息：\n· 23:10 记得给妈妈回电话\n· 23:40 明早九点交周报"
    assert sent == [("wechat", f"🌙 {expected}"), ("feishu", f"🌙 {expected}")]
    assert [x["title"] for x in outbox.drain(owner.user_id)] == [expected]
    assert notifier.flush(owner.user_id, MORNING) is False and len(sent) == 2   # 只合并一次


def test_merge_single_held_message():
    assert delivery.merge_held([{"at": "2026-10-02 23:10", "text": "记得回电话"}]) == "免打扰期间有 1 条消息：23:10 记得回电话"


def test_notifier_respects_channels_and_wechat_belongs_to_owner(owner):
    store = TenantStore()
    store.set_pref(delivery.PREF_CHANNELS, '["feishu"]')
    sent, outbox = [], PendingOutbox()
    notifier = _notifier(owner, sent, outbox)
    assert notifier.send(owner.user_id, "该开会了", MORNING) is True
    assert sent == [("feishu", "🔔 该开会了")] and outbox.drain(owner.user_id) == []
    store.set_pref(delivery.PREF_CHANNELS, None)
    other = delivery.Notifier(push_wechat=lambda t: sent.append(("wechat", t)) or True,
                              wechat_user=lambda: "someone-else")
    assert other.send(owner.user_id, "该开会了", MORNING) is False   # 微信桥不是这个账号的


def test_heartbeat_deliver_hook_holds_and_dedups_during_quiet_hours(owner, tmp_path):
    TenantStore().set_pref(delivery.PREF_DND, "22:30-08:00")
    sent = []
    notifier = _notifier(owner, sent)
    path = tmp_path / "HEARTBEAT.md"
    path.write_text("盯着周报", encoding="utf-8")
    calls = []

    def scanner(now):
        return HeartbeatScanner(owner_getter=lambda: owner, compose=lambda o, c, n: calls.append(1) or "记得交周报",
                                path_fn=lambda: path, now_fn=lambda: now, quiet_hours=None,
                                sent_log=SentLog(lambda: tmp_path / "sent.json"), deliver=notifier.send)

    assert scanner(NIGHT).scan_once() is True          # 已攒下（记去重）
    assert scanner(NIGHT.replace(minute=40)).scan_once() is False   # 同一句不再攒第二条
    assert sent == [] and len(calls) == 2
    notifier.flush(owner.user_id, MORNING)
    assert sent[0] == ("wechat", "🌙 免打扰期间有 1 条消息：23:10 记得交周报")


def test_schedule_reminders_ignore_quiet_hours_and_scanner_flushes(owner):
    store = TenantStore()
    store.set_pref(delivery.PREF_DND, "22:30-08:00")
    store.add_schedule("值班交接", "2026-10-02 23:05")
    sent = []
    notifier = _notifier(owner, sent)
    notifier.send(owner.user_id, "巡检：服务器磁盘 91%", NIGHT)
    night = ReminderScanner(owner_getter=lambda: owner, push_wechat=lambda t: sent.append(("wechat", t)) or True,
                            notifier=notifier, now_fn=lambda: NIGHT)
    assert night.scan_once() == 1                       # 日程是用户亲手设的：照常送达
    assert sent == [("wechat", "⏰ 日程提醒：2026-10-02 23:05 值班交接（回「稍后」推迟 10 分钟，回「好了」表示已处理）")]
    morning = ReminderScanner(owner_getter=lambda: owner, push_wechat=lambda t: True,
                              notifier=notifier, now_fn=lambda: MORNING)
    morning.scan_once()
    assert sent[-1] == ("feishu", "🌙 免打扰期间有 1 条消息：23:10 巡检：服务器磁盘 91%")


# ---------- 晨报：按渠道取舍，飞书也能收 ----------

def test_radio_goes_to_feishu_when_wechat_turned_off(owner):
    store = TenantStore()
    store.set_pref("radio_time", "08:00")
    store.set_pref(delivery.PREF_CHANNELS, '["web", "feishu"]')
    voice, feishu = [], []
    radio = MorningRadio(owner_getter=lambda: owner, compose=lambda o: "今天晴", now_fn=lambda: MORNING,
                         push_voice=lambda t: voice.append(t) or True, push_available=lambda: True,
                         push_feishu=lambda uid, t: feishu.append((uid, t)) or True, feishu_ready=lambda uid: True)
    assert radio.scan_once() is True
    assert voice == [] and feishu == [(owner.user_id, "📻 今天晴")]


def test_radio_skips_model_when_no_chosen_channel_is_ready(owner):
    store = TenantStore()
    store.set_pref("radio_time", "08:00")
    store.set_pref(delivery.PREF_CHANNELS, '["web"]')
    composed = []
    radio = MorningRadio(owner_getter=lambda: owner, compose=lambda o: composed.append(1) or "今天晴",
                         now_fn=lambda: MORNING, push_voice=lambda t: True, push_available=lambda: True)
    assert radio.scan_once() is False and composed == []


# ---------- 接口 ----------

def _web_client():
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def test_delivery_settings_roundtrip(monkeypatch):
    assert TestClient(server_mod.app).get("/api/delivery").status_code == 401
    monkeypatch.setattr(server_mod.wechat, "push_bound", lambda: True)
    c = _web_client()
    view = c.get("/api/delivery").json()
    assert [(x["id"], x["available"], x["enabled"]) for x in view["channels"]] == [
        ("web", True, True), ("desktop", True, True), ("wechat", True, True), ("feishu", False, True)]
    assert view["dnd"] == {"enabled": False, "start": "22:30", "end": "08:00"}
    r = c.put("/api/delivery", json={"channels": ["wechat", "web"], "dnd_enabled": True,
                                     "dnd_start": "23:00", "dnd_end": "07:30"})
    assert r.status_code == 200 and r.json()["channels"] == ["web", "wechat"]
    view = c.get("/api/delivery").json()
    assert {x["id"]: x["enabled"] for x in view["channels"]} == {"web": True, "desktop": False, "wechat": True, "feishu": False}
    assert view["dnd"] == {"enabled": True, "start": "23:00", "end": "07:30"}
    store = TenantStore()
    assert json.loads(store.get_pref(delivery.PREF_CHANNELS)) == ["web", "wechat"]
    c.put("/api/delivery", json={"channels": list(delivery.CHANNELS), "dnd_enabled": False})
    assert store.get_pref(delivery.PREF_CHANNELS) is None and store.get_pref(delivery.PREF_DND) is None


def test_delivery_settings_validation():
    c = _web_client()
    assert c.put("/api/delivery", json={"channels": ["sms"]}).status_code == 422
    assert c.put("/api/delivery", json={"channels": [], "dnd_enabled": True,
                                        "dnd_start": "9:00", "dnd_end": "10:00"}).status_code == 422
    assert c.put("/api/delivery", json={"channels": [], "dnd_enabled": True,
                                        "dnd_start": "25:00", "dnd_end": "10:00"}).status_code == 422
    assert c.put("/api/delivery", json={"channels": [], "dnd_enabled": True,
                                        "dnd_start": "10:00", "dnd_end": "10:00"}).status_code == 422
    plain = TestClient(server_mod.app)
    plain.post("/api/login", json={"username": "admin", "password": "admin"})
    assert plain.put("/api/delivery", json={"channels": []}).status_code == 403   # 写操作要 CSRF


def test_member_never_sees_wechat_channel(monkeypatch):
    monkeypatch.setattr(server_mod.wechat, "push_bound", lambda: True)
    member = type("P", (), {"is_owner": False, "user_id": "u-2"})()
    assert server_mod._delivery_channel_status(member) == {"wechat": False, "feishu": False}


def test_pending_endpoint_honours_web_switch(monkeypatch):
    class FrozenDT(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.datetime(2026, 10, 2, 15, 3)
    monkeypatch.setattr(server_mod.datetime, "datetime", FrozenDT)
    store = TenantStore()
    store.add_schedule("项目复盘", "2026-10-02 15:00")
    store.set_pref(delivery.PREF_CHANNELS, '["desktop"]')
    c = _web_client()
    assert c.get("/api/reminders/pending").json()["items"] == []
    store.set_pref(delivery.PREF_CHANNELS, None)
    assert [x["title"] for x in c.get("/api/reminders/pending").json()["items"]] == ["项目复盘"]   # 没记过账：还能补上
