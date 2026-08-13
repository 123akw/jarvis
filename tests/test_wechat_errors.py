"""微信回复失败的用户文案：说人话、给下一步建议，不泄露异常类名。"""
import httpx

from jarvis import wechat


class WeirdInternalCrash(RuntimeError):
    """名字刻意怪异：一旦泄露进用户文案，断言立即失败。"""


def test_reply_failure_message_is_human_and_hides_exception_class():
    message = wechat.WeChatBridge._humanize_reply_failure(WeirdInternalCrash("boom"))
    assert "WeirdInternalCrash" not in message
    assert "RuntimeError" not in message
    assert "再试" in message, "必须给用户下一步建议"


def test_reply_timeout_message_suggests_retry_later():
    message = wechat.WeChatBridge._humanize_reply_failure(httpx.ReadTimeout("slow"))
    assert "ReadTimeout" not in message
    assert "超时" in message and "再" in message
