"""SMTP 邮件发送：会议纪要等场景的最小发信封装（标准库实现，零新增依赖）。

配置只从环境变量读（与 voice/asr.py、voice/tts.py 的 key 习惯一致）：
- JARVIS_SMTP_HOST / JARVIS_SMTP_PORT（默认 465；465 走 SMTP_SSL，其他端口走 STARTTLS）
- JARVIS_SMTP_USER / JARVIS_SMTP_PASSWORD（QQ 邮箱等填「授权码」，不是登录密码）
- JARVIS_SMTP_FROM（默认与 JARVIS_SMTP_USER 相同）
- JARVIS_MEETING_MAIL_TO（会议纪要默认收件人）

任何失败只抛 MailError（人话文案可直接给用户），上游异常细节只留类名进日志，
绝不透传（可能含凭据回显）。
"""
import logging
import os
import re
import smtplib
from email.message import EmailMessage

log = logging.getLogger("jarvis")

DEFAULT_MEETING_RECIPIENT = "1539598158@qq.com"
_SEND_TIMEOUT_SECONDS = 30
_ADDRESS_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class MailError(RuntimeError):
    """发信失败；message 是可以直接展示给用户的人话。"""


def valid_address(value: str) -> bool:
    return bool(isinstance(value, str) and _ADDRESS_RE.match(value.strip()))


def smtp_configured() -> bool:
    return all(os.getenv(key, "").strip() for key in (
        "JARVIS_SMTP_HOST", "JARVIS_SMTP_USER", "JARVIS_SMTP_PASSWORD"))


def default_meeting_recipient() -> str:
    return os.getenv("JARVIS_MEETING_MAIL_TO", "").strip() or DEFAULT_MEETING_RECIPIENT


def _default_factory(host: str, port: int):
    if port == 465:
        return smtplib.SMTP_SSL(host, port, timeout=_SEND_TIMEOUT_SECONDS)
    client = smtplib.SMTP(host, port, timeout=_SEND_TIMEOUT_SECONDS)
    client.starttls()
    return client


def send_mail(subject: str, body: str, to: str, *, smtp_factory=None) -> None:
    """同步发一封纯文本邮件；调用方若在事件循环里应套 asyncio.to_thread。"""
    if not smtp_configured():
        raise MailError("邮件服务未配置（缺 JARVIS_SMTP_HOST/USER/PASSWORD），纪要已保存但没有发出")
    if not valid_address(to):
        raise MailError("收件邮箱格式不对")
    host = os.getenv("JARVIS_SMTP_HOST", "").strip()
    user = os.getenv("JARVIS_SMTP_USER", "").strip()
    password = os.getenv("JARVIS_SMTP_PASSWORD", "").strip()
    try:
        port = int(os.getenv("JARVIS_SMTP_PORT", "") or "465")
    except ValueError:
        port = 465
    message = EmailMessage()
    message["Subject"] = str(subject)[:200]
    message["From"] = os.getenv("JARVIS_SMTP_FROM", "").strip() or user
    message["To"] = to.strip()
    message.set_content(str(body))
    factory = smtp_factory or _default_factory
    try:
        with factory(host, port) as client:
            client.login(user, password)
            client.send_message(message)
    except MailError:
        raise
    except Exception as exc:
        log.warning("mail send failed: %s", type(exc).__name__)
        raise MailError("邮件发送失败，请检查 SMTP 配置或授权码") from exc
