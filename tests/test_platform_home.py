"""智能体主页的问候与快捷问题（第十四轮）：规则版、模型版校验与回退、后台生成的触发时机、登录替换旧会话。"""
import datetime as dt
import json
import time
from concurrent.futures import Future

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import platform_home as home
from jarvis import platforms
from jarvis.accounts import AccountStore

STUDY = {"owner_id": "u-study", "name": "学习助手", "tagline": "搜索学习资料", "profession": "student",
         "plugins": ["todo", "schedule", "search", "recall"]}
SHOP = {"owner_id": "u-shop", "name": "奶茶店小管家", "tagline": "订单排班一手抓", "profession": "shop_owner",
        "plugins": ["memo", "todo", "schedule", "weather", "search", "memory"]}
OFF_TOPIC = ("火锅", "奶茶", "王姐", "报税")

GOOD = json.dumps({"greeting": "今天想先搞定哪门课？", "chips": [
    {"text": "帮我查下这道题的解题思路", "plugin": "search"},
    {"text": "记一下，晚上要写完作业", "plugin": "todo"},
    {"text": "提醒我明天早上背单词", "plugin": "schedule"},
    {"text": "上次聊的复习方法再说一遍", "plugin": "recall"},
]}, ensure_ascii=False)


class MemStore:
    def __init__(self):
        self.data = {}

    def __call__(self):   # 当 store_factory 用
        return self

    def get_pref(self, key, default=None, *, owner_id=None):
        return self.data.get((owner_id, key), default)

    def set_pref(self, key, value, *, owner_id=None):
        self.data[(owner_id, key)] = value


class Holding:
    """后台线程池替身：先攒着，测试里手动 run()，模拟「接口先返回、生成稍后完成」。"""

    def __init__(self):
        self.jobs = []

    def submit(self, fn, *args):
        self.jobs.append(lambda: fn(*args))

    def run(self):
        while self.jobs:
            self.jobs.pop(0)()


class SyncExecutor:
    def __init__(self):
        self.calls = 0

    def submit(self, fn, *args):
        self.calls += 1
        future = Future()
        future.set_result(fn(*args))
        return future


def _service(raw=GOOD, store=None, **kwargs):
    calls = []

    def complete(system, user):
        calls.append(user)
        return raw() if callable(raw) else raw
    svc = home.HomeService(lambda: complete, store_factory=store or MemStore(), executor=SyncExecutor(), **kwargs)
    return svc, calls


# ---------- 规则版 ----------

def test_rules_follow_the_agent_not_other_professions():
    for row in (STUDY, dict(STUDY, profession="")):
        result = home.rules_home(row)
        assert result["source"] == "rules" and len(result["chips"]) == 4
        assert set(result["chip_plugins"]) <= set(row["plugins"])
        assert not any(word in chip for chip in result["chips"] for word in OFF_TOPIC), result
    # 没有职业：用名字里的主题词做模板（学习助手 → 学习）
    plain = home.rules_home(dict(STUDY, profession=""))
    assert "帮我把这周的学习计划排进日程" in plain["chips"] and "帮我搜一下学习资料" in plain["chips"]
    assert plain["greeting"] == "你好，我是「学习助手」，有什么可以帮你？"
    # 学生：职业主题词「复习」，职业问候
    assert home.rules_home(STUDY)["greeting"] == "今天想先搞定哪门课？"


def test_rules_only_use_installed_chat_plugins():
    row = {"owner_id": "x", "name": "小林奶茶", "tagline": "", "profession": "shop_owner",
           "plugins": ["todo", "input_file", "feishu"]}
    result = home.rules_home(row)
    assert result["chips"] and set(result["chip_plugins"]) == {"todo"}
    assert not any("天气" in chip for chip in result["chips"])        # 没装天气就不该出现天气
    assert home.rules_home(dict(row, plugins=["input_file"]))["chips"] == []


def test_topics_from_profession_name_and_tagline():
    assert home.topics(STUDY) == ("复习", "学习资料")
    assert home.topics(dict(STUDY, profession="")) == ("学习", "学习资料")
    assert home.topics({"name": "奶茶店小管家", "tagline": "订单排班一手抓"}) == ("奶茶店", "奶茶店的最新资讯")
    assert home.topics({"name": "我的智能体", "tagline": ""})[0] == "工作"


# ---------- 模型版校验 ----------

def test_parse_model_output_accepts_good_json():
    parsed = home.parse_model_output("```json\n" + GOOD + "\n```", STUDY)
    assert parsed["source"] == "model" and parsed["greeting"] == "今天想先搞定哪门课？"
    assert parsed["chip_plugins"] == ["search", "todo", "schedule", "recall"]


@pytest.mark.parametrize("raw", [
    "", "好的，以下是主页", "[1, 2]", '{"greeting": "你好"}',
    '{"greeting": "", "chips": []}',
    '{"greeting": "' + "很" * 40 + '", "chips": []}',
    '{"greeting": "你好", "chips": "今天有啥作业"}',
])
def test_parse_model_output_rejects_garbage(raw):
    assert home.parse_model_output(raw, STUDY) is None


def test_parse_model_output_drops_bad_chips_and_tops_up_from_rules():
    raw = json.dumps({"greeting": "今天学点什么？", "chips": [
        {"text": "帮我查下这道题怎么做", "plugin": "search"},
        {"text": "上次你推荐的那家火锅叫啥", "plugin": "weather"},       # 没装的插件
        {"text": "记一下给王姐回个电话", "plugin": "todo"},              # 具体人名
        {"text": "帮我把这学期所有考试的时间都排进日程里", "plugin": "schedule"},   # 超过 18 字
        {"text": "🔥 今天学啥", "plugin": "todo"},                       # 表情
        {"text": "提醒我周六上午复习", "plugin": "schedule"},
    ]}, ensure_ascii=False)
    parsed = home.parse_model_output(raw, STUDY)
    assert parsed["source"] == "model" and len(parsed["chips"]) == 4
    assert parsed["chips"][:2] == ["帮我查下这道题怎么做", "提醒我周六上午复习"]
    assert not any(word in chip for chip in parsed["chips"] for word in OFF_TOPIC)
    only_one = json.dumps({"greeting": "你好", "chips": [{"text": "今天有啥作业", "plugin": "todo"}]})
    assert home.parse_model_output(only_one, STUDY) is None
    # 问候不合格（太长 / 自称贾维斯）只换成规则版的问候，chips 照用
    for greeting in ("很" * 25, "我是贾维斯"):
        raw = json.dumps({"greeting": greeting, "chips": [{"text": "今天有啥作业", "plugin": "todo"},
                                                          {"text": "帮我查资料", "plugin": "search"}]}, ensure_ascii=False)
        parsed = home.parse_model_output(raw, STUDY)
        assert parsed["greeting"] == "今天想先搞定哪门课？" and parsed["chips"][:2] == ["今天有啥作业", "帮我查资料"]


# ---------- 生成与回退 ----------

def test_generate_with_model_stores_model_result():
    store = MemStore()
    svc, calls = _service(store=store)
    result = svc.generate(STUDY)
    assert result["source"] == "model" and len(calls) == 1
    assert "学习助手" in calls[0] and "search：" in calls[0] and "weather" not in calls[0]
    view = svc.view(STUDY)
    assert view["source"] == "model" and view["chips"][0] == "帮我查下这道题的解题思路"


def test_generate_falls_back_to_rules_on_garbage_error_and_timeout():
    for raw in ("我不知道", lambda: (_ for _ in ()).throw(RuntimeError("boom"))):
        svc, _calls = _service(raw=raw)
        assert svc.generate(STUDY)["source"] == "rules"
        assert svc.view(STUDY)["source"] == "rules"
    svc, _calls = _service(raw=lambda: time.sleep(0.5) or GOOD, timeout=0.05)
    started = time.monotonic()
    assert svc.generate(STUDY)["source"] == "rules" and time.monotonic() - started < 0.4


def test_view_ignores_result_for_old_content():
    svc, _calls = _service()
    svc.generate(STUDY)
    renamed = dict(STUDY, name="考研搭子", tagline="")
    assert svc.view(renamed)["source"] == "rules"
    assert svc.view(dict(STUDY, icon="📚", accent="#5E5CE6"))["source"] == "model"   # 图标 / 主题色不影响


# ---------- 触发时机 ----------

def test_schedule_skips_without_model_and_when_up_to_date():
    no_model = home.HomeService(lambda: None, store_factory=MemStore(), executor=SyncExecutor())
    assert no_model.schedule(STUDY) is False and no_model.view(STUDY)["source"] == "rules"
    svc, calls = _service()
    assert svc.schedule(STUDY) is True and len(calls) == 1
    assert svc.schedule(STUDY) is False and len(calls) == 1            # 已是模型版
    assert svc.schedule(dict(STUDY, plugins=["todo", "search"])) is True and len(calls) == 2   # 改了插件重生成


def test_schedule_retries_rules_only_after_a_while():
    now = [dt.datetime(2026, 10, 2, 9, tzinfo=dt.timezone.utc)]
    svc, calls = _service(raw="乱答", clock=lambda: now[0])
    assert svc.schedule(STUDY) is True and svc.view(STUDY)["source"] == "rules"
    assert svc.schedule(STUDY) is False and len(calls) == 1              # 刚失败过，不每次刷新都重试
    now[0] += dt.timedelta(seconds=home.RETRY_AFTER + 1)
    assert svc.schedule(STUDY) is True and len(calls) == 2


def test_schedule_dedupes_inflight_generation():
    executor = Holding()
    svc = home.HomeService(lambda: (lambda s, u: GOOD), store_factory=MemStore(), executor=executor)
    assert svc.schedule(STUDY) is True and svc.schedule(STUDY) is False and len(executor.jobs) == 1
    executor.jobs[0]()
    assert svc.view(STUDY)["source"] == "model"


# ---------- 接口 ----------

@pytest.fixture
def accounts():
    store = AccountStore()
    store._ensure_bootstrap()
    return store


@pytest.fixture
def model_service(monkeypatch):
    calls = []

    def complete(system, user):
        calls.append(user)
        return GOOD
    executor = SyncExecutor()
    svc = home.HomeService(lambda: complete, executor=executor)
    monkeypatch.setattr(home, "_service", svc)
    platforms.signup_limiter.reset()
    return calls


def _login(username, password):
    client = TestClient(server_mod.app)
    assert client.post("/api/login", json={"username": username, "password": password}).status_code == 200
    client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    return client


def test_signup_generates_home_in_background(accounts, monkeypatch, model_service):
    monkeypatch.setenv("JARVIS_MARKET_SIGNUP", "open")
    body = TestClient(server_mod.app).post("/api/market/signup", json={"platform": {
        "name": "学习助手", "tagline": "搜索学习资料", "accent": "#0A84FF", "profession": "student",
        "plugins": ["todo", "schedule", "search", "recall"]}}).json()
    assert len(model_service) == 1                                        # 开号就排了一次生成
    assert body["platform"]["home"]["source"] in ("rules", "model")
    member = _login(body["username"], body["password"])
    got = member.get("/api/platform").json()["platform"]["home"]
    assert got["source"] == "model" and got["chips"][0] == "帮我查下这道题的解题思路"
    assert len(model_service) == 1                                        # 再读不重复生成


def test_existing_platform_backfills_on_first_get_and_regenerates_on_content_change(accounts, model_service, monkeypatch):
    accounts.create_user("old1", "Member-pass-123", "Member")
    member = _login("old1", "Member-pass-123")
    # 上一轮建的智能体：没有生成过主页（直接写库，绕过触发）
    no_model = home.HomeService(lambda: None)
    monkeypatch.setattr(home, "_service", no_model)
    member.post("/api/platform", json={"name": "学习助手", "tagline": "搜索学习资料", "accent": "#0A84FF",
                                       "plugins": ["todo", "schedule", "search", "recall"]})
    executor = Holding()
    svc = home.HomeService(lambda: (lambda s, u: model_service.append(u) or GOOD), executor=executor)
    monkeypatch.setattr(home, "_service", svc)
    first = member.get("/api/platform").json()["platform"]["home"]
    assert first["source"] == "rules" and len(first["chips"]) == 4       # 这次先回规则版，不等模型
    assert len(executor.jobs) == 1 and model_service == []
    member.get("/api/platform")
    assert len(executor.jobs) == 1                                        # 生成中再读不重复排
    executor.run()
    assert len(model_service) == 1
    assert member.get("/api/platform").json()["platform"]["home"]["source"] == "model"
    member.put("/api/platform", json={"accent": "#5E5CE6"})               # 只改主题色：不重生成
    assert executor.jobs == []
    edited = member.put("/api/platform", json={"tagline": "陪我考研"}).json()["platform"]["home"]
    assert edited["source"] == "rules" and len(executor.jobs) == 1       # 改了介绍：先回规则版、后台重生成
    executor.run()
    assert len(model_service) == 2 and "陪我考研" in model_service[-1]
    assert member.get("/api/platform").json()["platform"]["home"]["source"] == "model"


def test_login_replaces_and_revokes_the_previous_web_session(accounts):
    accounts.create_user("newbie", "Member-pass-123", "Member")
    browser = _login("admin", "admin")
    old_cookie = browser.cookies.get(server_mod._COOKIE)
    assert old_cookie
    assert browser.post("/api/login", json={"username": "newbie", "password": "Member-pass-123"}).status_code == 200
    assert browser.get("/api/session").json()["username"] == "newbie"
    stale = TestClient(server_mod.app)
    stale.cookies.set(server_mod._COOKIE, old_cookie)
    assert stale.get("/api/session").json() == {"authed": False}          # admin 的旧会话已作废


def test_register_wires_server_default_model(monkeypatch):
    from fastapi import FastAPI
    from jarvis.provider_settings import ResolvedLLM

    sent = []
    monkeypatch.setattr(home, "model_complete", lambda llm, system, user, **kw: sent.append(llm.api_key) or GOOD)
    key = ["sk-env"]
    llm = lambda: ResolvedLLM("deepseek", "https://api.deepseek.com", "deepseek-chat", key[0], 0, "environment")
    platforms.register(FastAPI(), accounts=None, request_principal=None, write_authorized=None, deny=None,
                       csrf_deny=None, client_address=None, environment_llm=llm)
    complete = home.service()._model()
    assert complete is not None and complete("s", "u") == GOOD and sent == ["sk-env"]
    key[0] = ""
    assert home.service()._model() is None                               # 服务器没配 key：只走规则


def test_model_complete_leaves_room_for_reasoning_and_skips_proxies(monkeypatch):
    from jarvis.provider_settings import ResolvedLLM
    import jarvis.provider_runtime as runtime

    sent = {}

    class Response:
        def raise_for_status(self): pass
        def json(self): return {"choices": [{"message": {"content": GOOD}}]}

    class Client:
        def post(self, url, headers, json):
            sent.update(url=url, body=json)
            return Response()
        def close(self): sent["closed"] = True

    monkeypatch.setattr(runtime, "safe_http_clients", lambda timeout: sent.update(timeout=timeout) or (Client(), None))
    llm = ResolvedLLM("deepseek", "https://api.deepseek.com", "deepseek-chat", "sk-test", 0, "environment")
    assert home.model_complete(llm, "系统", "用户") == GOOD
    assert sent["url"] == "https://api.deepseek.com/chat/completions" and sent["closed"]
    # 推理模型的思考也算 max_tokens：给足余量，不然 JSON 会被截断成空串
    assert sent["body"]["max_tokens"] >= 1000 and sent["timeout"] == home.MODEL_TIMEOUT
