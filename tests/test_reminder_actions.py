"""F5 可操作的提醒：稍后 / 完成的账本语义、回复短语解析、各渠道入口与跨渠道去重。"""
import datetime

import jarvis.server as server_mod
import jarvis.tenancy as tenancy_mod
import pytest
from fastapi.testclient import TestClient
from jarvis import reminders
from jarvis.accounts import AccountStore
from jarvis.reminders import (ReminderScanner, handle_quick_reply, parse_quick_reply, reminder_window,
                              resolve, snooze_until)
from jarvis.tenancy import TenantStore, tenant_scope

from tests.test_wechat import FakeClient, make_bridge

NOW = datetime.datetime(2026, 10, 2, 15, 3)
UTC_NOW = datetime.datetime(2026, 10, 2, 7, 3, tzinfo=datetime.timezone.utc)


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


def _due(store, now, channel):
    floor, ceiling = reminder_window(now)
    return store.due_reminders(floor=floor, ceiling=ceiling, channel=channel)


def _meeting(store=None):
    store = store or TenantStore()
    return store, store.add_schedule("项目复盘", "2026-10-02 15:00")["id"]


# ---------- 账本语义 ----------

def test_done_on_one_channel_stops_other_channels():
    store, sid = _meeting()
    item = _due(store, NOW, "wechat")[0]
    assert item == {"id": sid, "title": "项目复盘", "when": "2026-10-02 15:00", "at": "2026-10-02 15:00"}
    store.mark_reminded(sid, item["at"], "wechat")
    result = resolve(store, sid, item["at"], "done", NOW)
    assert result == {"status": "done", "title": "项目复盘", "already": False}
    for channel in ("web", "desktop", "feishu"):
        assert _due(store, NOW, channel) == []      # 微信里点了「好了」，其他地方不再弹
    assert store.list_schedule()[0]["when"] == "2026-10-02 15:00"   # 日程本身原样保留


def test_snooze_rings_again_without_moving_the_schedule():
    store, sid = _meeting()
    result = resolve(store, sid, "2026-10-02 15:00", "snooze", NOW)
    assert result["status"] == "snoozed" and result["until"] == "2026-10-02 15:13"   # 从「现在」起算 10 分钟
    assert _due(store, NOW, "web") == []                          # 原来那次已处理
    assert _due(store, NOW.replace(minute=12), "web") == []       # 还没到再响时间
    again = _due(store, NOW.replace(minute=13), "web")
    assert again == [{"id": sid, "title": "项目复盘", "when": "2026-10-02 15:00", "at": "2026-10-02 15:13"}]
    assert store.list_schedule()[0]["when"] == "2026-10-02 15:00"
    assert reminders.format_reminder(again[0]).startswith("⏰ 再次提醒：2026-10-02 15:00 项目复盘")


def test_snooze_is_idempotent_and_done_wins():
    store, sid = _meeting()
    first = resolve(store, sid, "2026-10-02 15:00", "snooze", NOW)
    # 另一个渠道几分钟后也点了「稍后」：不越推越晚，返回第一次排好的时间
    second = resolve(store, sid, "2026-10-02 15:00", "snooze", NOW.replace(minute=8))
    assert second == {**first, "already": True}
    # 「完成」压过「稍后」：撤掉还没响的那次
    done = resolve(store, sid, "2026-10-02 15:00", "done", NOW.replace(minute=9))
    assert done["status"] == "done" and done["already"] is False
    assert _due(store, NOW.replace(minute=13), "web") == []
    assert resolve(store, sid, "2026-10-02 15:00", "snooze", NOW)["status"] == "done"
    assert resolve(store, sid, "2026-10-02 15:00", "done", NOW)["already"] is True


def test_resolve_reports_missing_and_stale():
    store, sid = _meeting()
    assert resolve(store, 999, "2026-10-02 15:00", "done", NOW)["status"] == "missing"
    assert resolve(store, sid, "2026-10-02 14:00", "done", NOW)["status"] == "stale"   # 不是任何一次响铃


def test_snooze_until_counts_from_now_or_ring_time():
    assert snooze_until("2026-10-02 15:00", datetime.datetime(2026, 10, 2, 15, 5, 40), 10) == "2026-10-02 15:15"
    assert snooze_until("2026-10-02 15:00", datetime.datetime(2026, 10, 2, 14, 59), 10) == "2026-10-02 15:10"


# ---------- 回复短语 ----------

@pytest.mark.parametrize("text, expected", [
    ("稍后", ("snooze", 10)),
    ("稍后！", ("snooze", 10)),
    ("等会儿", ("snooze", 10)),
    ("10分钟后再提醒", ("snooze", 10)),
    ("20 分钟后再提醒我", ("snooze", 20)),
    ("十五分钟后提醒", ("snooze", 15)),
    ("半小时后再提醒", ("snooze", 30)),
    ("一小时后再提醒我", ("snooze", 60)),
    ("好了", ("done", 0)),
    ("完成了。", ("done", 0)),
    ("搞定", ("done", 0)),
])
def test_parse_quick_reply_accepts_known_phrases(text, expected):
    assert parse_quick_reply(text) == expected


@pytest.mark.parametrize("text", [
    "好的", "嗯", "稍后我们再讨论一下这个方案", "提醒我明天交报告", "500分钟后再提醒", "0分钟后再提醒",
    "半分钟后再提醒", "帮我查下天气", "",
])
def test_parse_quick_reply_leaves_normal_chat_alone(text):
    assert parse_quick_reply(text) is None


def test_quick_reply_only_inside_window_for_that_channel(monkeypatch):
    store, sid = _meeting()
    monkeypatch.setattr(tenancy_mod, "_now", lambda: UTC_NOW.isoformat())
    store.mark_reminded(sid, "2026-10-02 15:00", "wechat")
    # 飞书没发过这条：飞书里的「稍后」不归它管
    assert handle_quick_reply(store, "feishu", "稍后", NOW, utc_now=UTC_NOW) is None
    # 窗口外（31 分钟后）：当普通聊天
    late = UTC_NOW + datetime.timedelta(minutes=31)
    assert handle_quick_reply(store, "wechat", "稍后", NOW, utc_now=late) is None
    reply = handle_quick_reply(store, "wechat", "20分钟后再提醒", NOW, utc_now=UTC_NOW)
    assert reply == "好的，15:23 再提醒你「项目复盘」。"
    assert handle_quick_reply(store, "wechat", "好了", NOW, utc_now=UTC_NOW) == "好的，「项目复盘」不再提醒。"
    assert handle_quick_reply(store, "wechat", "稍后", NOW, utc_now=UTC_NOW) == "「项目复盘」已经标记完成了。"
    assert handle_quick_reply(store, "wechat", "今天天气怎么样", NOW, utc_now=UTC_NOW) is None


# ---------- 扫描线程：再响、渠道开关、飞书 ----------

def test_scanner_pushes_snoozed_ring_and_skips_acked_on_feishu():
    store, sid = _meeting()
    owner = AccountStore().unique_active_owner()
    wechat_sent, feishu_sent = [], []
    scanner = ReminderScanner(
        owner_getter=lambda: owner, push_wechat=lambda t: wechat_sent.append(t) or True,
        push_feishu=lambda uid, t: feishu_sent.append((uid, t)) or True,
        feishu_users=lambda: [owner.user_id], now_fn=lambda: NOW)
    assert scanner.scan_once() == 2
    assert wechat_sent[0].startswith("⏰ 日程提醒：2026-10-02 15:00 项目复盘（回「稍后」")
    assert feishu_sent[0][0] == owner.user_id
    resolve(store, sid, "2026-10-02 15:00", "snooze", NOW)
    later = ReminderScanner(
        owner_getter=lambda: owner, push_wechat=lambda t: wechat_sent.append(t) or True,
        push_feishu=lambda uid, t: feishu_sent.append((uid, t)) or True,
        feishu_users=lambda: [owner.user_id], now_fn=lambda: NOW.replace(minute=13))
    assert later.scan_once() == 2
    assert wechat_sent[-1].startswith("⏰ 再次提醒") and feishu_sent[-1][1].startswith("⏰ 再次提醒")
    assert later.scan_once() == 0


def test_scanner_skips_channel_turned_off_in_settings():
    store, _sid = _meeting()
    store.set_pref("delivery_channels", '["web", "feishu"]')
    owner = AccountStore().unique_active_owner()
    sent = []
    scanner = ReminderScanner(owner_getter=lambda: owner, push_wechat=lambda t: sent.append(t) or True,
                              now_fn=lambda: NOW)
    assert scanner.scan_once() == 0 and sent == []
    assert len(_due(store, NOW, "wechat")) == 1   # 不记账：重新打开后宽限期内还能补上


# ---------- 接口 ----------

def _frozen(monkeypatch, now=NOW):
    class FrozenDT(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return now if tz is None else now.replace(tzinfo=tz)
    monkeypatch.setattr(server_mod.datetime, "datetime", FrozenDT)


def _web_client():
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def test_web_snooze_and_done_endpoints(monkeypatch):
    _frozen(monkeypatch)
    _store, sid = _meeting()
    anon = TestClient(server_mod.app)
    assert anon.post(f"/api/reminders/{sid}/done", json={"at": "2026-10-02 15:00"}).status_code == 401
    c = _web_client()
    item = c.get("/api/reminders/pending").json()["items"][0]
    assert item["at"] == "2026-10-02 15:00"
    r = c.post(f"/api/reminders/{sid}/snooze", json={"at": item["at"]})
    assert r.status_code == 200 and r.json()["until"] == "2026-10-02 15:13" and r.json()["status"] == "snoozed"
    again = c.post(f"/api/reminders/{sid}/snooze", json={"at": item["at"], "minutes": 30}).json()
    assert again["until"] == "2026-10-02 15:13" and again["already"] is True
    assert c.post(f"/api/reminders/{sid}/done", json={"at": item["at"]}).json()["status"] == "done"
    assert c.post("/api/reminders/999/done", json={"at": "2026-10-02 15:00"}).status_code == 404
    assert c.post(f"/api/reminders/{sid}/done", json={"at": "2026-10-02 09:00"}).status_code == 409
    assert c.post(f"/api/reminders/{sid}/done", json={"at": "明天"}).status_code == 422
    assert c.post(f"/api/reminders/{sid}/snooze", json={"at": item["at"], "minutes": 999}).status_code == 422


def test_web_action_requires_csrf_but_desktop_token_does_not(monkeypatch):
    _frozen(monkeypatch)
    _store, sid = _meeting()
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    assert c.post(f"/api/reminders/{sid}/done", json={"at": "2026-10-02 15:00"}).status_code == 403
    token = c.post("/api/desktop/login", json={"username": "admin", "password": "admin"}).json()["access_token"]
    d = TestClient(server_mod.app)
    d.headers["X-JWS-Token"] = token
    assert d.post(f"/api/reminders/{sid}/done", json={"at": "2026-10-02 15:00"}).json()["status"] == "done"
    assert d.get("/api/reminders/pending").json()["items"] == []   # 已处理：桌面不再弹


# ---------- 微信 / 飞书入口 ----------

def _wechat_message(text, from_id="contact-abc@ilink"):
    return {"get_updates_buf": "", "msgs": [{
        "message_type": 1, "from_user_id": from_id, "context_token": "ctx-1",
        "item_list": [{"type": 1, "text_item": {"text": text}}]}]}


def test_wechat_quick_reply_only_from_push_target(tmp_path):
    sent = []
    client = FakeClient(sent=sent)
    bridge, agent_calls = make_bridge(tmp_path, client)
    seen = []
    bridge.set_quick_reply(lambda text: seen.append(text) or ("好的，15:13 再提醒你「项目复盘」。" if text == "稍后" else None))
    bridge._handle_updates_response(client, "token", _wechat_message("稍后"))
    assert seen == [] and len(agent_calls) == 1           # 没绑定推送：不是在回提醒，照常对话
    bridge._handle_updates_response(client, "token", _wechat_message("提醒发给我"))
    bridge._handle_updates_response(client, "token", _wechat_message("稍后"))
    assert sent[-1] == "好的，15:13 再提醒你「项目复盘」。" and len(agent_calls) == 1   # 不进大模型
    bridge._handle_updates_response(client, "token", _wechat_message("稍后", from_id="someone-else@ilink"))
    assert len(agent_calls) == 2                          # 别的联系人说「稍后」不算
    bridge._handle_updates_response(client, "token", _wechat_message("今天怎么样"))
    assert len(agent_calls) == 3                          # 处理器返回 None：交给模型


def test_server_wechat_quick_reply_acts_on_latest_reminder(monkeypatch):
    store, sid = _meeting()
    _frozen(monkeypatch)
    store.mark_reminded(sid, "2026-10-02 15:00", "wechat")
    assert server_mod._wechat_quick_reply("帮我订个会议室") is None
    assert server_mod._wechat_quick_reply("稍后") == "好的，15:13 再提醒你「项目复盘」。"
    assert _due(store, NOW, "web") == []


def test_feishu_push_and_quick_reply(tmp_path):
    from tests.test_feishu_bridge import Env

    env = Env(tmp_path)
    replies = []
    env.bridge.configure(bundle_for=env.bridge._bundle_for, chunk_text=env.bridge._chunk_text,
                         tenant_store=TenantStore, accounts=env.accounts,
                         quick_reply=lambda uid, text: replies.append((uid, text)) or ("好的" if text == "稍后" else None))
    assert env.bridge.bound_users() == [] and env.bridge.push_text(env.owner.user_id, "提醒") is False
    env.bind("ou_alice")
    assert env.bridge.bound_users() == [env.owner.user_id] and env.bridge.push_ready(env.owner.user_id)
    assert env.bridge.push_text(env.owner.user_id, "⏰ 日程提醒：15:00 项目复盘") is True
    assert env.fake.sent[-1] == {"receive_id_type": "open_id", "receive_id": "ou_alice", "msg_type": "text",
                                 "content": {"text": "⏰ 日程提醒：15:00 项目复盘"}}
    env.send("稍后", message_id="om_q1", event_id="ev_q1")
    assert replies == [(env.owner.user_id, "稍后")]
    assert env.fake.replies[-1]["content"] == {"text": "好的"} and env.agent.calls == []
    # 群里说「稍后」不当作回提醒（提醒只私聊推送）
    from tests.feishu_fakes import bot_mention
    env.send("@_user_1 稍后", message_id="om_q2", event_id="ev_q2", chat_type="group",
             chat_id="oc_group_000000000001", mentions=[bot_mention()])
    assert len(replies) == 1
