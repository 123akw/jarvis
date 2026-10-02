"""智能平台市场的推荐：规则兜底、模型只许从清单里挑、乱答 / 超时退回规则、公开接口限流。"""
import json
import threading

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import platforms
from jarvis.plugins import get_profession, is_plugin
from jarvis.plugins import recommend as rec
from jarvis.provider_settings import ResolvedLLM


@pytest.fixture(autouse=True)
def fresh_limiters():
    platforms.recommend_limiter.reset()
    platforms.signup_limiter.reset()
    yield
    platforms.recommend_limiter.reset()


def test_rules_profession_gives_its_bundle_and_flows():
    result = rec.rules("project_manager")
    assert result["source"] == "rules"
    assert result["plugins"] == get_profession("project_manager")["plugins"]
    assert [f["id"] for f in result["flows"]] == ["project_archive"]
    assert "项目经理" in result["reason"]


def test_rules_description_guesses_profession_and_adds_keyword_plugins():
    result = rec.rules(None, "我是开奶茶店的，想管订单和员工排班，顺便发发朋友圈")
    assert result["plugins"][:6] == get_profession("shop_owner")["plugins"]
    assert "wechat" not in result["plugins"]                  # 微信桥只连 Owner：别人不推荐
    assert "wechat" in rec.rules(None, "开奶茶店，想发朋友圈", owner=True)["plugins"]
    assert "个体店主" in result["reason"] and "「订单」" in result["reason"]
    assert result["flows"][0]["id"] == "new_arrival"
    meeting_heavy = rec.rules(None, "每周要开好几个例会，想自动记纪要，再把资料整理成文档")
    assert {"meeting", "input_file"} <= set(meeting_heavy["plugins"])
    assert meeting_heavy["flows"][0]["steps"][0]["plugin"] == "input_file"   # 提到资料就给资料类流程


def test_rules_without_any_signal_fall_back_to_common_set():
    result = rec.rules(None, "随便看看")
    assert result["plugins"] == list(rec.DEFAULT_PLUGINS)
    assert result["flows"][0]["steps"][0]["plugin"] == "input_text"
    assert all(is_plugin(p) for p in result["plugins"]) and len(result["plugins"]) <= rec.MAX_PLUGINS


def test_model_success_is_used_and_only_catalog_ids_pass():
    seen = {}

    def complete(system, user):
        seen["system"], seen["user"] = system, user
        return '```json\n{"profession": "sales", "plugins": ["schedule", "memory", "recall"], "reason": "跑客户最怕忘了谁喜欢啥"}\n```'

    result = rec.Recommender(complete).recommend(None, "我做房产中介，天天见客户")
    assert result == {"plugins": ["schedule", "memory", "recall"], "flows": get_profession("sales")["flows"],
                      "reason": "跑客户最怕忘了谁喜欢啥", "source": "model"}
    assert "memory：记住你的习惯" in seen["user"] and "我做房产中介" in seen["user"]
    assert "只能使用清单里出现的 id" in seen["system"]


def test_model_never_recommends_owner_only_plugins_to_others():
    raw = '{"profession": null, "plugins": ["wechat", "todo", "wechat_send"], "reason": "微信里收单"}'
    assert rec.Recommender(lambda s, u: raw).recommend(None, "微商")["plugins"] == ["todo"]
    assert rec.Recommender(lambda s, u: raw).recommend(None, "微商", owner=True)["plugins"] == [
        "wechat", "todo", "wechat_send"]
    only_wechat = '{"profession": null, "plugins": ["wechat"], "reason": "微信"}'
    assert rec.Recommender(lambda s, u: only_wechat).recommend(None, "微商")["source"] == "rules"


@pytest.mark.parametrize("raw", [
    "我觉得你应该装日程和待办",                                                         # 不是 JSON
    '{"profession": null, "plugins": ["schedule", "crm_pro"], "reason": "配了 CRM"}',      # 清单外 id
    '{"profession": "astronaut", "plugins": ["schedule"], "reason": "太空"}',             # 清单外职业
    '{"profession": null, "plugins": [], "reason": "啥也不配"}',                           # 空
    '{"profession": null, "plugins": ["schedule"], "reason": ""}',                         # 没理由
    '[1, 2, 3]',
])
def test_model_garbage_falls_back_to_rules(raw):
    result = rec.Recommender(lambda system, user: raw).recommend(None, "开奶茶店，想管排班")
    assert result == rec.rules(None, "开奶茶店，想管排班")


def test_model_error_or_timeout_falls_back_to_rules():
    def boom(system, user):
        raise RuntimeError("upstream down")

    assert rec.Recommender(boom).recommend(None, "开奶茶店")["source"] == "rules"
    release = threading.Event()

    def slow(system, user):
        release.wait(5)
        return '{"profession": null, "plugins": ["todo"], "reason": "慢"}'

    try:
        assert rec.Recommender(slow, timeout=0.05).recommend(None, "开奶茶店")["source"] == "rules"
    finally:
        release.set()


def test_no_description_or_no_model_never_calls_model():
    calls = []
    recommender = rec.Recommender(lambda s, u: calls.append(1) or "{}")
    assert recommender.recommend("teacher", "")["source"] == "rules"
    assert rec.Recommender(None).recommend(None, "开奶茶店")["source"] == "rules"
    assert calls == []


def test_recommender_validates_input():
    with pytest.raises(rec.RecommendError):
        rec.Recommender(None).recommend("astronaut", "")
    with pytest.raises(rec.RecommendError):
        rec.Recommender(None).recommend(None, "字" * 301)


def test_model_reason_is_cleaned_and_clipped():
    raw = json.dumps({"profession": None, "plugins": ["todo"], "reason": "**" + "很长" * 60 + "**"}, ensure_ascii=False)
    reason = rec.Recommender(lambda s, u: raw).recommend(None, "记事")["reason"]
    assert "*" not in reason and len(reason) == rec.REASON_MAX_CHARS and reason.endswith("…")


def test_model_complete_posts_chat_completion_without_proxies(monkeypatch):
    sent = {}

    class Response:
        def raise_for_status(self): pass
        def json(self): return {"choices": [{"message": {"content": "好的"}}]}

    class Client:
        def post(self, url, headers, json):
            sent.update(url=url, auth=headers["Authorization"], body=json)
            return Response()
        def close(self): sent["closed"] = True

    import jarvis.provider_runtime as runtime
    monkeypatch.setattr(runtime, "safe_http_clients", lambda timeout: (Client(), None))
    llm = ResolvedLLM("deepseek", "https://api.deepseek.com", "deepseek-chat", "sk-test", 0, "environment")
    assert rec.model_complete(llm, "系统", "用户") == "好的"
    assert sent["url"] == "https://api.deepseek.com/chat/completions" and sent["auth"] == "Bearer sk-test"
    assert sent["body"]["model"] == "deepseek-chat" and sent["body"]["stream"] is False and sent["closed"]


# ---------- 接口 ----------

def test_recommend_endpoint_uses_rules_without_server_key(monkeypatch):
    monkeypatch.setattr(server_mod._provider_store, "_environment_llm",
                        lambda: ResolvedLLM("deepseek", "https://api.deepseek.com", "deepseek-chat", "", 0, "environment"))
    client = TestClient(server_mod.app)
    body = client.post("/api/market/recommend", json={"profession": "student", "description": "要考研了"}).json()
    assert body["source"] == "rules" and body["plugins"][:4] == get_profession("student")["plugins"]
    assert client.post("/api/market/recommend", json={"profession": "nope"}).status_code == 422
    assert client.post("/api/market/recommend", json={"description": "字" * 301}).status_code == 422
    assert client.post("/api/market/recommend", json={"description": 3}).status_code == 422


def test_recommend_endpoint_uses_server_model_when_configured(monkeypatch):
    monkeypatch.setattr(server_mod._provider_store, "_environment_llm",
                        lambda: ResolvedLLM("deepseek", "https://api.deepseek.com", "deepseek-chat", "sk-env", 0, "environment"))
    calls = []

    def fake_complete(llm, system, user, **kwargs):
        calls.append(llm.api_key)
        return '{"profession": "creator", "plugins": ["search", "movies"], "reason": "做影评号得先会找料"}'

    monkeypatch.setattr(rec, "model_complete", fake_complete)
    body = TestClient(server_mod.app).post("/api/market/recommend", json={"description": "我做影评视频"}).json()
    assert body["source"] == "model" and body["plugins"] == ["search", "movies"] and calls == ["sk-env"]


def test_recommend_endpoint_is_rate_limited_per_ip():
    client = TestClient(server_mod.app)
    for _ in range(platforms.RECOMMEND_PER_IP):
        assert client.post("/api/market/recommend", json={"profession": "teacher"}).status_code == 200
    limited = client.post("/api/market/recommend", json={"profession": "teacher"})
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) >= 1
    assert "频繁" in limited.json()["error"]


def test_window_limiter_slides():
    clock = [0.0]
    limiter = platforms.WindowLimiter(2, 60, clock=lambda: clock[0])
    assert limiter.hit("a") is None and limiter.hit("a") is None
    assert limiter.hit("a") == 60 and limiter.hit("b") is None
    clock[0] = 61
    assert limiter.hit("a") is None
