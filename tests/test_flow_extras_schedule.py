"""第十八轮好用层·定时运行：next_run_at 计算（跨天、工作日跳周末与节假日、每周几）、设置校验、接口与权限隔离、
到点触发、busy 顺延、过期不补跑、推送、连续失败自动暂停、流程删了触发器跟着清、调度线程干净退出。"""
import datetime as dt
import threading
import time

import pytest
from fastapi.testclient import TestClient

import jarvis.server as server_mod
from jarvis import delivery, flows, heartbeat
from jarvis.accounts import AccountStore
from jarvis.flows import extras, schedule as S
from jarvis.flows.store import FlowStore

CST = dt.timezone(dt.timedelta(hours=8))


def mon_to_fri(day):
    return day.weekday() < 5


def at(text):   # 北京时间 → aware
    return dt.datetime.fromisoformat(text).replace(tzinfo=CST)


@pytest.fixture(autouse=True)
def beijing(monkeypatch):
    monkeypatch.setattr(S, "LOCAL_TZ", CST)


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


GRAPH = {"nodes": [
    {"id": "start", "type": "start", "data": {"fields": [
        {"key": "city", "label": "城市", "type": "text", "required": True},
        {"key": "note", "label": "备注", "type": "paragraph"}]}},
    {"id": "n1", "type": "llm", "data": {"title": "写早报", "prompt": "写早报：{{start.city}}"}},
    {"id": "end", "type": "end", "data": {"output": "{{n1.text}}", "page": True}}],
    "edges": [{"source": "start", "target": "n1"}, {"source": "n1", "target": "end"}]}


# ---------- 时间计算 ----------

@pytest.mark.parametrize("now, schedule, expected", [
    ("2026-10-12 07:00", {"repeat": "daily", "time": "08:00"}, "2026-10-12 08:00"),     # 当天还没到
    ("2026-10-12 08:00", {"repeat": "daily", "time": "08:00"}, "2026-10-13 08:00"),     # 正好到点：排明天
    ("2026-10-12 23:30", {"repeat": "daily", "time": "00:15"}, "2026-10-13 00:15"),     # 跨天
    ("2026-12-31 22:00", {"repeat": "daily", "time": "07:00"}, "2027-01-01 07:00"),     # 跨年
    ("2026-10-16 09:00", {"repeat": "weekdays", "time": "08:00"}, "2026-10-19 08:00"),  # 周五过了点 → 下周一
    ("2026-10-17 06:00", {"repeat": "weekdays", "time": "08:00"}, "2026-10-19 08:00"),  # 周六 → 下周一
    ("2026-10-14 07:00", {"repeat": "weekly", "time": "08:00", "weekday": 3}, "2026-10-14 08:00"),  # 周三当天
    ("2026-10-15 07:00", {"repeat": "weekly", "time": "08:00", "weekday": 3}, "2026-10-21 08:00"),  # 周四 → 下周三
    ("2026-10-12 07:00", {"repeat": "weekly", "time": "18:00", "weekday": 7}, "2026-10-18 18:00"),  # 每周日
])
def test_next_run(now, schedule, expected):
    assert S.next_run(schedule, at(now), workday=mon_to_fri) == at(expected)


def test_weekdays_skip_public_holidays_and_include_makeup_days():
    weekdays = {"repeat": "weekdays", "time": "08:00"}
    assert S.next_run(weekdays, at("2026-09-30 09:00")) == at("2026-10-08 08:00")   # 国庆连休跳过
    assert S.next_run(weekdays, at("2026-10-09 09:00")) == at("2026-10-10 08:00")   # 周六调休上班照跑
    assert S.next_run(weekdays, at("2026-10-10 09:00")) == at("2026-10-12 08:00")


def test_labels_and_upcoming():
    assert S.label({"repeat": "daily", "time": "08:00"}) == "每天 08:00"
    assert S.label({"repeat": "weekdays", "time": "07:30"}) == "每个工作日 07:30"
    assert S.label({"repeat": "weekly", "time": "18:00", "weekday": 3}) == "每周三 18:00"
    now = at("2026-10-16 10:00")   # 周五
    assert S.when_label(at("2026-10-16 18:00"), now) == "今天 18:00"
    assert S.when_label(at("2026-10-17 08:00"), now) == "明天（周六）08:00"
    assert S.when_label(at("2026-10-18 08:00"), now) == "后天（周日）08:00"
    assert S.when_label(at("2026-10-21 08:00"), now) == "10月21日（周三）08:00"
    runs = S.upcoming({"repeat": "daily", "time": "08:00"}, now)
    assert runs == [at("2026-10-17 08:00"), at("2026-10-18 08:00"), at("2026-10-19 08:00")]


@pytest.mark.parametrize("body, message", [
    ({"schedule": {"repeat": "daily", "time": "25:00"}}, "24 小时制"),
    ({"schedule": {"repeat": "weekly", "time": "08:00"}}, "星期几"),
    ({"schedule": {"repeat": "weekly", "time": "08:00", "weekday": 8}}, "星期几"),
    ({"schedule": {"repeat": "hourly", "time": "08:00"}}, "重复方式"),
    ({"kind": "cron"}, "运行方式"),
    ({"enabled": "yes"}, "开或关"),
    ({"inputs": {"city": {"name": "a.pdf", "data_base64": "eA=="}}}, "没法带文件"),
    ({"inputs": {"city": "字" * 2001}}, "最多 2000 个字"),
    ({"notify": "feishu"}, "通知设置"),
])
def test_normalize_rejects_with_human_messages(body, message):
    with pytest.raises(S.TriggerError, match=message):
        S.normalize({"kind": "schedule", "enabled": True, "schedule": {"repeat": "daily", "time": "08:00"}, **body})


def test_normalize_and_check_inputs():
    settings = S.normalize({"kind": "schedule", "enabled": True,
                            "schedule": {"repeat": "weekly", "time": "7:05", "weekday": "5"},
                            "inputs": {"city": " 杭州 ", "Bad-Key": "x", "empty": ""},
                            "notify": {"feishu": True}})
    assert settings == {"kind": "schedule", "enabled": True, "schedule": {"repeat": "weekly", "time": "07:05", "weekday": 5},
                        "inputs": {"city": "杭州"}, "notify": {"feishu": True, "desktop": False}}
    checked = S.check_inputs({**settings, "inputs": {"city": "杭州", "ghost": "x"}}, GRAPH)
    assert checked["inputs"] == {"city": "杭州"}   # 开始节点没有的输入丢掉
    with pytest.raises(S.TriggerError, match="定时运行时没人填，先在这里填好：城市"):
        S.check_inputs({**settings, "inputs": {}}, GRAPH)
    assert S.check_inputs({**settings, "enabled": False, "inputs": {}}, GRAPH)["inputs"] == {}   # 关着不查必填
    file_graph = {"nodes": [{"id": "start", "type": "start", "data": {"fields": [
        {"key": "doc", "label": "合同", "type": "file", "required": True},
        {"key": "n", "label": "份数", "type": "number"}, {"key": "s", "label": "语气", "type": "select",
                                                        "options": ["正式", "轻松"]}]}}]}
    with pytest.raises(S.TriggerError, match="上传「合同」"):
        S.check_inputs({**settings, "inputs": {}}, file_graph)
    off = {**settings, "enabled": False}
    assert S.check_inputs({**off, "inputs": {"n": "3"}}, file_graph)["inputs"] == {"n": 3}
    with pytest.raises(S.TriggerError, match="要填数字"):
        S.check_inputs({**off, "inputs": {"n": "三"}}, file_graph)
    with pytest.raises(S.TriggerError, match="只能从选项里选"):
        S.check_inputs({**off, "inputs": {"s": "随便"}}, file_graph)


# ---------- 接口 ----------

def _client(username="admin", password="admin"):
    c = TestClient(server_mod.app)
    assert c.post("/api/login", json={"username": username, "password": password}).status_code == 200
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _put_body(**extra):
    return {"kind": "schedule", "enabled": True, "schedule": {"repeat": "weekdays", "time": "08:00"},
            "inputs": {"city": "北京"}, "notify": {"feishu": True, "desktop": True}, **extra}


def test_http_trigger_get_put_and_flow_list(owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "早报", "graph": GRAPH}).json()["flow"]
    default = owner.get(f"/api/flows/{flow['id']}/trigger")
    assert default.status_code == 200 and default.headers["cache-control"] == "no-store"
    body = default.json()
    assert body["trigger"]["kind"] == "manual" and body["trigger"]["enabled"] is False
    assert body["trigger"]["label"] == "手动运行" and body["trigger"]["next_run_at"] is None
    assert body["channels"]["feishu"] == {"ready": False, "reason": "还没绑定飞书，先到设置里绑定"}
    saved = owner.put(f"/api/flows/{flow['id']}/trigger", json=_put_body(),
                      headers={"X-Forwarded-Proto": "https", "X-Forwarded-Host": "jv.example.com"})
    assert saved.status_code == 200, saved.text
    trigger = saved.json()["trigger"]
    assert trigger["label"] == "每个工作日 08:00" and trigger["enabled"] is True
    assert trigger["next_run_at"].endswith("+08:00") and trigger["next_run_at"][11:16] == "08:00"
    assert trigger["next_run_label"].endswith("08:00") and len(trigger["upcoming"]) == 3
    assert trigger["note"] == "法定节假日不跑，调休上班的周末照常跑"
    assert trigger["inputs"] == {"city": "北京"} and trigger["paused_reason"] == ""
    assert owner.get(f"/api/flows/{flow['id']}/trigger").json()["trigger"] == trigger
    row = S.TriggerStore().get(owner_id, flow["id"])
    assert row["config"]["origin"] == "https://jv.example.com" and row["config"]["schedule"]["repeat"] == "weekdays"
    listed = owner.get("/api/flows").json()["flows"][0]["trigger"]   # 引擎的列表按同一份 config 出 label
    assert listed["label"] == "每个工作日 08:00" and listed["next_run_at"] == row["next_run_at"]
    # 只改一部分：其余沿用；关掉后 next_run_at 清空
    off = owner.put(f"/api/flows/{flow['id']}/trigger", json={"enabled": False}).json()["trigger"]
    assert off["enabled"] is False and off["next_run_at"] is None and off["schedule"]["repeat"] == "weekdays"
    assert owner.get("/api/flows").json()["flows"][0]["trigger"] is None
    manual = owner.put(f"/api/flows/{flow['id']}/trigger", json={"kind": "manual"}).json()["trigger"]
    assert manual["label"] == "手动运行" and manual["enabled"] is False


def test_http_trigger_errors_and_isolation(owner_id):
    owner = _client()
    flow = owner.post("/api/flows", json={"name": "早报", "graph": GRAPH}).json()["flow"]
    bad = owner.put(f"/api/flows/{flow['id']}/trigger", json=_put_body(schedule={"repeat": "daily", "time": "8点"}))
    assert bad.status_code == 400 and bad.json() == {"error": "时间要写成「08:00」这样的 24 小时制"}
    missing = owner.put(f"/api/flows/{flow['id']}/trigger", json=_put_body(inputs={}))
    assert missing.status_code == 400 and missing.json()["error"] == "定时运行时没人填，先在这里填好：城市"
    assert owner.get("/api/flows/nope123/trigger").status_code == 404
    assert owner.put("/api/flows/nope123/trigger", json=_put_body()).json() == {"error": "没有找到这条流程"}
    no_csrf = TestClient(server_mod.app)
    no_csrf.cookies = owner.cookies
    assert no_csrf.put(f"/api/flows/{flow['id']}/trigger", json=_put_body()).status_code == 403
    assert TestClient(server_mod.app).get(f"/api/flows/{flow['id']}/trigger").status_code == 401
    AccountStore().create_user("member", "member", "Member")
    member = _client("member", "member")
    assert member.get(f"/api/flows/{flow['id']}/trigger").status_code == 404
    assert member.put(f"/api/flows/{flow['id']}/trigger", json=_put_body()).status_code == 404
    assert S.TriggerStore().get(owner_id, flow["id"]) is None
    assert owner.delete(f"/api/flows/{flow['id']}").status_code == 200


# ---------- 调度 ----------

class FakeDeps:
    def __init__(self, bound=True):
        self.bound, self.sent = bound, []

    def feishu_ready(self, user_id):
        return self.bound

    def push_feishu(self, user_id, text):
        self.sent.append((user_id, text))
        return True


class FakeRuntime:
    def __init__(self, results=None, deps=None):
        self.results = list(results or [{"status": "ok", "run_id": "r1", "error": "",
                                         "output": {"text": "## 早报\n- 晴，18°C\n- 10 点开会", "links": [],
                                                    "page_url": "/r/tok123456"}}])
        self.calls = []
        self.deps = deps or FakeDeps()

    def run_headless(self, user_id, flow_id, inputs):
        self.calls.append((user_id, flow_id, inputs))
        return self.results[min(len(self.calls), len(self.results)) - 1]


class Clock:
    def __init__(self, text):
        self.now = at(text)

    def __call__(self):
        return self.now


def _setup(owner_id, *, schedule=None, notify=None, now="2026-10-12 07:00", name="早报"):
    flow = FlowStore().create_flow(owner_id, name=name, summary="", graph=GRAPH)
    settings = S.normalize({"kind": "schedule", "enabled": True,
                            "schedule": schedule or {"repeat": "daily", "time": "08:00"},
                            "inputs": {"city": "北京"}, "notify": notify or {"feishu": True, "desktop": True}})
    S.apply(S.TriggerStore(), owner_id, flow["id"], settings, origin="https://jv.example.com", now=at(now))
    return flow["id"]


def _scheduler(runtime, clock, outbox=None):
    notifier = delivery.Notifier(outbox=outbox) if outbox is not None else None
    return S.FlowScheduler(runtime=lambda: runtime, notifier=notifier, now_fn=clock, sync=True)


def test_tick_runs_due_trigger_and_notifies(owner_id):
    flow_id = _setup(owner_id)
    runtime, clock, outbox = FakeRuntime(), Clock("2026-10-12 07:59"), heartbeat.PendingOutbox()
    scheduler = _scheduler(runtime, clock, outbox)
    assert scheduler.tick() == 0 and runtime.calls == []   # 还没到点
    clock.now = at("2026-10-12 08:00:20")
    assert scheduler.tick() == 1
    assert runtime.calls == [(owner_id, flow_id, {"city": "北京"})]
    row = S.TriggerStore().get(owner_id, flow_id)
    assert row["last_status"] == "ok" and S.from_iso(row["last_run_at"]) == clock.now
    assert S.from_iso(row["next_run_at"]) == at("2026-10-13 08:00")   # 排到明天
    assert scheduler.tick() == 0   # 同一次不会再跑
    (user, text), = runtime.deps.sent
    assert user == owner_id and text.startswith("⏰ 定时流程「早报」跑完了")
    assert "【早报】\n• 晴，18°C" in text and "结果网页：https://jv.example.com/r/tok123456" in text
    (item,) = outbox.drain(owner_id)
    assert item["title"] == "「早报」跑完了：晴，18°C" and item["when"] == "2026-10-12 08:00"   # 跳过小标题行
    view = S.view(row, clock.now)
    assert view["last_run_at"] == "2026-10-12T08:00:20+08:00" and view["next_run_label"] == "明天（周二）08:00"


def test_notify_respects_channels_and_public_url(owner_id, monkeypatch):
    monkeypatch.setenv("JARVIS_PUBLIC_URL", "https://jarvis.example.cn/")
    _setup(owner_id, notify={"feishu": False, "desktop": False})
    runtime, clock, outbox = FakeRuntime(), Clock("2026-10-12 08:00"), heartbeat.PendingOutbox()
    _scheduler(runtime, clock, outbox).tick()
    assert runtime.deps.sent == [] and outbox.drain(owner_id) == []
    text, _title = S.message("早报", runtime.results[0], {"origin": "https://other"})
    assert "https://jarvis.example.cn/r/tok123456" in text
    unbound = FakeRuntime(deps=FakeDeps(bound=False))
    _setup(owner_id, name="晚报")
    _scheduler(unbound, clock).tick()
    assert unbound.calls and unbound.deps.sent == []   # 飞书没绑定就不推


def test_busy_postpones_one_minute(owner_id):
    flow_id = _setup(owner_id)
    runtime = FakeRuntime([{"status": "busy", "run_id": None, "output": None, "error": "正在跑别的"},
                           {"status": "ok", "run_id": "r2", "output": {"text": "好了", "links": []}, "error": ""}])
    clock = Clock("2026-10-12 08:00:10")
    scheduler = _scheduler(runtime, clock)
    assert scheduler.tick() == 1
    row = S.TriggerStore().get(owner_id, flow_id)
    assert S.from_iso(row["next_run_at"]) == at("2026-10-12 08:01:10") and row["last_run_at"] is None
    clock.now = at("2026-10-12 08:00:40")
    assert scheduler.tick() == 0
    clock.now = at("2026-10-12 08:01:15")
    assert scheduler.tick() == 1 and len(runtime.calls) == 2
    row = S.TriggerStore().get(owner_id, flow_id)
    assert row["last_status"] == "ok" and S.from_iso(row["next_run_at"]) == at("2026-10-13 08:00")


def test_stale_trigger_is_not_backfilled(owner_id):
    flow_id = _setup(owner_id, now="2026-10-11 20:00")   # 该在 10-12 08:00 跑
    runtime = FakeRuntime()
    _scheduler(runtime, Clock("2026-10-12 09:30")).tick()   # 服务停了 1.5 小时
    assert runtime.calls == []
    assert S.from_iso(S.TriggerStore().get(owner_id, flow_id)["next_run_at"]) == at("2026-10-13 08:00")
    flow2 = _setup(owner_id, now="2026-10-11 20:00", name="晚一点也跑")
    _scheduler(runtime, Clock("2026-10-12 08:50")).tick()   # 不到 1 小时：照跑
    assert [c[1] for c in runtime.calls] == [flow2]


def test_five_failures_pause_and_notify_once(owner_id):
    flow_id = _setup(owner_id, notify={"feishu": True, "desktop": False})
    failing = FakeRuntime([{"status": "error", "run_id": "x", "output": None, "error": "「写早报」没成功：模型暂时不可用"}])
    store = S.TriggerStore()
    for day in range(12, 17):
        clock = Clock(f"2026-10-{day} 08:00")
        assert _scheduler(failing, clock).tick() == 1
    row = store.get(owner_id, flow_id)
    assert row["enabled"] is False and row["next_run_at"] is None and row["config"]["fail_streak"] == 5
    view = S.view(row, clock.now)
    assert view["paused_reason"] == "连续 5 次没跑成，已暂停定时。最近一次的原因：「写早报」没成功：模型暂时不可用"
    assert view["last_status"] == "error" and view["last_error"].startswith("「写早报」没成功")
    texts = [t for _u, t in failing.deps.sent]
    assert len(texts) == 5 and all(t.startswith("⚠️ 定时流程「早报」这次没跑成") for t in texts[:4])
    assert texts[4].startswith("⏸️ 定时流程「早报」连续 5 次没跑成，已暂停定时") and "重新开启" in texts[4]
    assert view["kind"] == "schedule" and view["enabled"] is False   # 自动暂停：仍是定时，只是关着
    assert _scheduler(failing, Clock("2026-10-18 08:00")).tick() == 0   # 暂停后不再跑
    # 重新开启：清零、清掉暂停原因
    settings = S.normalize({"enabled": True}, S.settings_of(row))
    again = S.view(S.apply(store, owner_id, flow_id, settings, now=at("2026-10-18 09:00")), at("2026-10-18 09:00"))
    assert again["enabled"] is True and again["paused_reason"] == ""
    assert store.get(owner_id, flow_id)["config"]["fail_streak"] == 0


def test_success_resets_fail_streak(owner_id):
    flow_id = _setup(owner_id)
    flaky = FakeRuntime([{"status": "error", "error": "坏了"}, {"status": "error", "error": "坏了"},
                         {"status": "ok", "output": {"text": "好", "links": []}}])
    for day in (12, 13, 14):
        _scheduler(flaky, Clock(f"2026-10-{day} 08:00")).tick()
    row = S.TriggerStore().get(owner_id, flow_id)
    assert row["config"]["fail_streak"] == 0 and row["enabled"] is True and row["last_status"] == "ok"


def test_deleted_flow_drops_trigger_and_runs_are_per_owner(owner_id):
    flow_id = _setup(owner_id)
    member = AccountStore().create_user("member", "member", "Member")
    other = _setup(member["id"], name="别人的")
    with FlowStore()._connect() as c:   # 绕过引擎直接删流程行（模拟旧数据留下孤儿触发器）
        c.execute("DELETE FROM tenant_flows WHERE owner_id=? AND id=?", (owner_id, flow_id))
    runtime = FakeRuntime()
    _scheduler(runtime, Clock("2026-10-12 08:00")).tick()
    assert runtime.calls == [(member["id"], other, {"city": "北京"})]
    assert S.TriggerStore().get(owner_id, flow_id) is None


def test_runtime_crash_is_recorded_as_error(owner_id):
    flow_id = _setup(owner_id, notify={"feishu": False, "desktop": False})

    class Boom(FakeRuntime):
        def run_headless(self, *args):
            raise RuntimeError("secret detail")

    _scheduler(Boom(), Clock("2026-10-12 08:00")).tick()
    row = S.TriggerStore().get(owner_id, flow_id)
    assert row["last_status"] == "error" and row["config"]["last_error"] == "流程运行出了点问题，请稍后再试"


def test_scheduler_thread_starts_and_stops_cleanly(owner_id):
    _setup(owner_id)
    ran = threading.Event()

    class Runtime(FakeRuntime):
        def run_headless(self, *args):
            ran.set()
            return super().run_headless(*args)

    scheduler = S.FlowScheduler(runtime=lambda: Runtime(), now_fn=lambda: at("2026-10-12 08:00"), interval=0.05,
                                startup_delay=0)
    scheduler.start()
    assert ran.wait(3)
    started = time.monotonic()
    scheduler.stop()
    assert not scheduler.running and time.monotonic() - started < 2


def test_start_scheduler_hook_and_missing_runtime():
    scheduler = extras.start_scheduler(runtime=lambda: None)
    try:
        assert scheduler.running and scheduler.tick() == 0   # 引擎没装好：什么都不做
    finally:
        scheduler.stop()
    assert not scheduler.running
    assert flows.start_scheduler is not None
