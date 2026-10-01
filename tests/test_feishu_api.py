"""飞书 HTTP 客户端：tenant_access_token 缓存、到期刷新、失效重试与接口报文形状。"""
import pytest

from jarvis.channels.feishu.api import FeishuAPI, FeishuAPIError

from feishu_fakes import APP_ID, APP_SECRET, FakeFeishu


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def make_api(fake, clock=None):
    return FeishuAPI(APP_ID, APP_SECRET, client=fake.client(), clock=clock or Clock())


def test_token_is_cached_until_refresh_margin_then_renewed():
    """token 有效期 7200 秒：提前 10 分钟内复用缓存，过了刷新点才重新获取。"""
    fake, clock = FakeFeishu(), Clock()
    api = make_api(fake, clock)

    api.bot_info()
    clock.now += 7200 - 600 - 1
    api.bot_info()
    assert fake.token_count == 1

    clock.now += 2
    api.bot_info()
    assert fake.token_count == 2
    assert [c["token"] for c in fake.calls if c["path"] == "/open-apis/bot/v3/info"] == ["t-1", "t-1", "t-2"]


def test_revoked_token_is_refreshed_and_request_retried_once():
    """防回归：缓存里的 token 被平台判失效（99991663）时强制刷新并重试，不把错误抛给业务。"""
    fake = FakeFeishu()
    api = make_api(fake)
    api.bot_info()
    fake.revoked.add("t-1")

    assert api.reply("om_1", "text", {"text": "hi"}) == "om_reply_1"
    assert fake.token_count == 2
    assert fake.replies[0]["content"] == {"text": "hi"}


def test_persistent_token_failure_raises_after_single_retry():
    fake = FakeFeishu()
    api = make_api(fake)
    fake.fail("POST", r"/reply$", 99991663, 99991663, 99991663)

    with pytest.raises(FeishuAPIError) as caught:
        api.reply("om_1", "text", {"text": "hi"})
    assert caught.value.token_invalid
    assert sum(1 for c in fake.calls if c["path"].endswith("/reply")) == 2


def test_bad_secret_surfaces_error_without_leaking_secret():
    fake = FakeFeishu()
    api = FeishuAPI(APP_ID, "wrong-secret", client=fake.client())
    with pytest.raises(FeishuAPIError) as caught:
        api.bot_info()
    assert caught.value.code == 10014
    assert "wrong-secret" not in str(caught.value)


def test_reply_and_card_payload_shapes():
    """报文形状按官方文档：content 为 JSON 字符串、带去重 uuid、话题内回复带 reply_in_thread。"""
    fake = FakeFeishu()
    api = make_api(fake)

    api.reply("om_9", "post", {"zh_cn": {"content": [[{"tag": "md", "text": "**hi**"}]]}}, in_thread=True)
    card_id = api.create_card({"schema": "2.0", "body": {"elements": []}})
    api.update_card_text(card_id, "answer", "hello", 1)
    api.card_settings(card_id, {"config": {"streaming_mode": False}}, 2)

    reply = fake.replies[0]
    assert reply["in_thread"] is True and len(reply["uuid"]) == 32
    assert fake.cards[card_id]["updates"] == ["hello"]
    assert fake.cards[card_id]["settings"] == [{"config": {"streaming_mode": False}}]
    put = next(c for c in fake.calls if c["method"] == "PUT")
    assert put["path"] == f"/open-apis/cardkit/v1/cards/{card_id}/elements/answer/content"


def test_download_resource_returns_bytes_and_maps_json_errors():
    fake = FakeFeishu()
    fake.resources[("om_1", "img_1")] = (b"\x89PNG....", "image/png")
    api = make_api(fake)

    assert api.download_resource("om_1", "img_1") == (b"\x89PNG....", "image/png")
    assert fake.calls[-1]["params"] == {"type": "image"}
    with pytest.raises(FeishuAPIError) as caught:
        api.download_resource("om_1", "img_missing")
    assert caught.value.code == 234003
