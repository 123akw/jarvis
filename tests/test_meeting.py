"""会议纪要：领域逻辑 / WS 网关 / REST 端点 / 邮件发送，全部打桩不联网。"""
import asyncio
import datetime
import json

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessageChunk
from starlette.websockets import WebSocketDisconnect

import jarvis.mailer as mailer_mod
import jarvis.meeting as meeting_mod
import jarvis.server as server_mod
import jarvis.voice.meeting_gateway as gateway_mod
from jarvis.voice.asr import ASRError, ASRResult


class _FakeAgent:
    """固定输出「纪要」文本的假 agent（stream/invoke 双形状）。"""

    def __init__(self, text="# 会议纪要\n- 讨论了进度"):
        self.text = text
        self.invocations = []

    def invoke(self, state, config=None):
        self.invocations.append(state)
        return {"messages": [type("M", (), {"content": self.text})()]}

    def stream(self, state, config=None, stream_mode=None):
        yield AIMessageChunk(content=self.text), {}

    def update_state(self, config, values):
        pass

    def get_state(self, config):
        return type("S", (), {"values": {"messages": []}})()


class _FakeASR:
    """脚本式假识别：P:增量 / F:定稿 / E:断连；finish() 结束结果流。"""

    instances = []

    def __init__(self):
        self.received = []
        self.closed = False
        self.finished = False
        self._q = asyncio.Queue()
        _FakeASR.instances.append(self)

    async def connect(self):
        pass

    async def send_audio(self, chunk):
        self.received.append(chunk)
        text = chunk.decode("utf-8", errors="ignore")
        if text.startswith("P:"):
            self._q.put_nowait(ASRResult(text=text[2:], is_final=False))
        elif text.startswith("F:"):
            self._q.put_nowait(ASRResult(text=text[2:], is_final=True))
        elif text.startswith("E:"):
            self._q.put_nowait(ASRError("语音识别连接中断"))

    async def finish(self):
        self.finished = True
        self._q.put_nowait(None)

    async def results(self):
        while True:
            item = await self._q.get()
            if item is None:
                return
            if isinstance(item, ASRError):
                raise item
            yield item

    async def close(self):
        self.closed = True


class _BrokenASR(_FakeASR):
    async def connect(self):
        raise ASRError("语音识别连接失败")


# ---------- 纯逻辑：会话 / 注册表 / 指令箱 ----------

def test_session_accumulates_segments_with_speaker_and_time():
    fixed = datetime.datetime(2026, 8, 24, 10, 0, 0)
    session = meeting_mod.MeetingSession("u1", "产品周会", now_fn=lambda: fixed)
    assert session.add_segment(meeting_mod.SPEAKER_ME, "  大家好  开始吧 ")["text"] == "大家好 开始吧"
    session.add_segment(meeting_mod.SPEAKER_OTHERS, "收到")
    text = session.transcript_text()
    assert "[10:00:00] 我：大家好 开始吧" in text
    assert "对方：收到" in text
    assert session.add_segment(meeting_mod.SPEAKER_ME, "   ") is None


def test_session_transcript_is_capped():
    session = meeting_mod.MeetingSession("u1")
    session._chars = meeting_mod.MAX_TRANSCRIPT_CHARS  # 直接顶到上限
    assert session.add_segment(meeting_mod.SPEAKER_ME, "再说一句") is None
    assert session.truncated and "未纳入转写" in session.transcript_text() or "未纳入" in session.transcript_text()


def test_registry_allows_single_active_meeting_per_user():
    registry = meeting_mod.MeetingRegistry()
    first = registry.start("u1", "A")
    assert first is not None
    assert registry.start("u1", "B") is None, "同一用户不允许两场并行会议"
    assert registry.start("u2", "C") is not None, "不同用户互不影响"
    finished = registry.finish("u1")
    assert finished is first and finished.ended_at is not None
    assert registry.get("u1") is None
    assert registry.start("u1", "D") is not None, "结束后可以再开"


def test_command_outbox_drain_clears_and_caps():
    box = meeting_mod.CommandOutbox()
    for i in range(meeting_mod.MAX_COMMANDS + 3):
        box.put("u1", {"command": f"c{i}"})
    items = box.drain("u1")
    assert len(items) == meeting_mod.MAX_COMMANDS, "超上限先进先出"
    assert items[-1] == {"command": f"c{meeting_mod.MAX_COMMANDS + 2}"}
    assert box.drain("u1") == [], "领取即清"


# ---------- 邮件发送 ----------

class _FakeSMTP:
    sent = []
    fail = False

    def __init__(self, host, port):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, user, password):
        if type(self).fail:
            raise RuntimeError("auth failed")

    def send_message(self, message):
        type(self).sent.append(message)


def _smtp_env(monkeypatch):
    monkeypatch.setenv("JARVIS_SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("JARVIS_SMTP_USER", "bot@example.com")
    monkeypatch.setenv("JARVIS_SMTP_PASSWORD", "auth-code")


def test_send_mail_requires_configuration(monkeypatch):
    for key in ("JARVIS_SMTP_HOST", "JARVIS_SMTP_USER", "JARVIS_SMTP_PASSWORD"):
        monkeypatch.delenv(key, raising=False)
    assert not mailer_mod.smtp_configured()
    with pytest.raises(mailer_mod.MailError) as exc:
        mailer_mod.send_mail("s", "b", "a@b.cn")
    assert "未配置" in str(exc.value)


def test_send_mail_delivers_via_factory(monkeypatch):
    _smtp_env(monkeypatch)
    _FakeSMTP.sent.clear()
    _FakeSMTP.fail = False
    mailer_mod.send_mail("会议纪要", "正文", "1539598158@qq.com", smtp_factory=_FakeSMTP)
    assert len(_FakeSMTP.sent) == 1
    message = _FakeSMTP.sent[0]
    assert message["To"] == "1539598158@qq.com"
    assert message["From"] == "bot@example.com"
    assert "正文" in message.get_content()


def test_send_mail_wraps_upstream_failures(monkeypatch):
    _smtp_env(monkeypatch)
    _FakeSMTP.fail = True
    try:
        with pytest.raises(mailer_mod.MailError) as exc:
            mailer_mod.send_mail("s", "b", "a@b.cn", smtp_factory=_FakeSMTP)
    finally:
        _FakeSMTP.fail = False
    assert "auth failed" not in str(exc.value), "上游细节不得透传"


def test_send_mail_rejects_bad_address(monkeypatch):
    _smtp_env(monkeypatch)
    with pytest.raises(mailer_mod.MailError):
        mailer_mod.send_mail("s", "b", "不是邮箱", smtp_factory=_FakeSMTP)
    assert mailer_mod.valid_address("1539598158@qq.com")
    assert not mailer_mod.valid_address("a@b")


def test_default_recipient_prefers_env(monkeypatch):
    monkeypatch.delenv("JARVIS_MEETING_MAIL_TO", raising=False)
    assert mailer_mod.default_meeting_recipient() == "1539598158@qq.com"
    monkeypatch.setenv("JARVIS_MEETING_MAIL_TO", "x@y.cn")
    assert mailer_mod.default_meeting_recipient() == "x@y.cn"


# ---------- WS 网关 + 落库 + 邮件全链路（打桩） ----------

def _client():
    return TestClient(server_mod.app)


def _login(client):
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    session = client.get("/api/session").json()
    return session["csrf_token"], client.cookies[server_mod._COOKIE]


def _connect(client, token):
    return client.websocket_connect(
        "/api/meeting/stream", headers={"Cookie": f"{server_mod._COOKIE}={token}"})


@pytest.fixture(autouse=True)
def _clean_meeting_state():
    meeting_mod.active_meetings._active.clear()
    meeting_mod.desktop_commands._items.clear()
    _FakeASR.instances.clear()
    yield
    meeting_mod.active_meetings._active.clear()
    meeting_mod.desktop_commands._items.clear()


def _start_meeting(monkeypatch, asr_factory=_FakeASR, mail_calls=None):
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _FakeAgent())
    monkeypatch.setattr(gateway_mod, "create_asr_session", asr_factory)
    if mail_calls is not None:
        def fake_send(subject, body, to, **kwargs):
            mail_calls.append({"subject": subject, "body": body, "to": to})
        monkeypatch.setattr(mailer_mod, "send_mail", fake_send)
    client = _client()
    csrf, token = _login(client)
    return client, csrf, token


def test_meeting_stream_rejects_unauthenticated():
    with _client().websocket_connect("/api/meeting/stream") as ws:
        first = ws.receive_json()
        assert first["code"] == "unauthorized"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == gateway_mod.CLOSE_UNAUTHORIZED


def test_meeting_stream_rejects_bad_csrf():
    client = _client()
    _csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": "forged"})
        assert ws.receive_json()["code"] == "csrf"
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_meeting_two_channels_transcribe_summarize_store_and_mail(monkeypatch):
    mail_calls = []
    client, csrf, token = _start_meeting(monkeypatch, mail_calls=mail_calls)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf, "title": "产品周会"})
        ready = ws.receive_json()
        assert ready["type"] == "ready" and ready["meeting_id"]
        ws.send_bytes(b"\x00" + "P:这个方案".encode())
        partial = ws.receive_json()
        assert partial == {"type": "partial", "speaker": "我", "text": "这个方案"}
        ws.send_bytes(b"\x00" + "F:这个方案明天上线。".encode())
        seg1 = ws.receive_json()
        assert seg1["type"] == "segment" and seg1["speaker"] == "我"
        ws.send_bytes(b"\x01" + "F:没问题，我这边配合。".encode())
        seg2 = ws.receive_json()
        assert seg2["speaker"] == "对方"
        ws.send_json({"type": "stop"})
        stopped = ws.receive_json()
        assert stopped["type"] == "stopped" and stopped["segments"] == 2 and not stopped["empty"]
        minutes = ws.receive_json()
        assert minutes["type"] == "minutes" and "会议纪要" in minutes["text"]
        mail = ws.receive_json()
        assert mail["type"] == "mail" and mail["ok"] and mail["to"] == "1539598158@qq.com"
    assert len(mail_calls) == 1
    assert "产品周会" in mail_calls[0]["subject"]
    assert "我：这个方案明天上线。" in mail_calls[0]["body"], "邮件必须附原始转写"
    # 双路各自建了独立识别会话，且 stop 时做了冲刷
    assert len(_FakeASR.instances) == 2
    assert all(item.finished for item in _FakeASR.instances)
    # REST 可回看
    listing = client.get("/api/meetings").json()
    assert len(listing["items"]) == 1 and not listing["active"]
    item = listing["items"][0]
    assert item["title"] == "产品周会" and item["mailed_to"] == "1539598158@qq.com"
    detail = client.get(f"/api/meetings/{item['id']}").json()
    assert "对方：没问题，我这边配合。" in detail["transcript"]
    assert "会议纪要" in detail["minutes"]


def test_meeting_conflict_rejected_while_active(monkeypatch):
    client, csrf, token = _start_meeting(monkeypatch, mail_calls=[])
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["type"] == "ready"
        with _connect(client, token) as ws2:
            ws2.send_json({"type": "init", "csrf": csrf})
            first = ws2.receive_json()
            assert first["code"] == "busy"
            with pytest.raises(WebSocketDisconnect) as exc:
                ws2.receive_json()
            assert exc.value.code == gateway_mod.CLOSE_CONFLICT
        ws.send_json({"type": "stop"})
        assert ws.receive_json()["type"] == "stopped"


def test_meeting_without_speech_skips_compose_and_mail(monkeypatch):
    mail_calls = []
    agent = _FakeAgent()
    monkeypatch.setattr(server_mod, "_get_agent", lambda: agent)
    monkeypatch.setattr(gateway_mod, "create_asr_session", _FakeASR)
    monkeypatch.setattr(mailer_mod, "send_mail",
                        lambda *a, **k: mail_calls.append(a))
    client = _client()
    csrf, token = _login(client)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "stop"})
        stopped = ws.receive_json()
        assert stopped["empty"] is True
    assert agent.invocations == [], "没有发言不得烧模型"
    assert mail_calls == []
    assert client.get("/api/meetings").json()["items"] == []


def test_meeting_smtp_unconfigured_still_stores_minutes(monkeypatch):
    for key in ("JARVIS_SMTP_HOST", "JARVIS_SMTP_USER", "JARVIS_SMTP_PASSWORD"):
        monkeypatch.delenv(key, raising=False)
    client, csrf, token = _start_meeting(monkeypatch)  # 真 mailer：未配置路径
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(b"\x00" + "F:只有我一句。".encode())
        assert ws.receive_json()["type"] == "segment"
        ws.send_json({"type": "stop"})
        assert ws.receive_json()["type"] == "stopped"
        assert ws.receive_json()["type"] == "minutes"
        mail = ws.receive_json()
        assert mail["type"] == "mail" and not mail["ok"] and "未配置" in mail["message"]
    items = client.get("/api/meetings").json()["items"]
    assert len(items) == 1 and items[0]["mailed_to"] == "", "没发出去就不标记已发"


def test_meeting_asr_totally_down_notifies_once(monkeypatch):
    client, csrf, token = _start_meeting(monkeypatch, asr_factory=_BrokenASR)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["type"] == "ready"
        seen = []
        for _ in range(gateway_mod._MAX_ASR_RESTARTS + 2):
            ws.send_bytes(b"\x00pcm")
            ws.send_json({"type": "ping"})
            event = ws.receive_json()
            seen.append(event["type"])
            if "asr_unavailable" in seen:
                break
            assert event["type"] in {"pong", "asr_unavailable"}
        assert "asr_unavailable" in seen, "识别彻底坏掉必须下发 asr_unavailable"
        # 通知后连接不崩，还能正常 stop（先把在途 pong 排干净）
        ws.send_json({"type": "stop"})
        while True:
            event = ws.receive_json()
            if event["type"] == "stopped":
                break
            assert event["type"] in {"pong", "asr_unavailable"}


def test_meeting_email_resend_endpoint(monkeypatch):
    mail_calls = []
    client, csrf, token = _start_meeting(monkeypatch, mail_calls=mail_calls)
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf, "title": "复盘"})
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(b"\x01" + "F:大家辛苦。".encode())
        assert ws.receive_json()["type"] == "segment"
        ws.send_json({"type": "stop"})
        for _ in range(3):
            ws.receive_json()
    item_id = client.get("/api/meetings").json()["items"][0]["id"]
    response = client.post(f"/api/meetings/{item_id}/email", headers={"X-JWS-CSRF": csrf})
    assert response.status_code == 200 and response.json()["ok"]
    assert len(mail_calls) == 2, "重发端点要真的再发一封"
    assert client.post("/api/meetings/999/email", headers={"X-JWS-CSRF": csrf}).status_code == 404


# ---------- 会议设置：收件邮箱每用户可覆盖 ----------

def test_meeting_settings_roundtrip_and_validation():
    client = _client()
    csrf, _token = _login(client)
    initial = client.get("/api/meeting/settings").json()
    assert initial["mail_to"] == "" and initial["default"] == "1539598158@qq.com"
    assert client.put("/api/meeting/settings", json={"mail_to": "不是邮箱"},
                      headers={"X-JWS-CSRF": csrf}).status_code == 422
    assert client.put("/api/meeting/settings", json={"mail_to": "boss@corp.cn"},
                      headers={"X-JWS-CSRF": csrf}).status_code == 200
    assert client.get("/api/meeting/settings").json()["mail_to"] == "boss@corp.cn"
    assert client.put("/api/meeting/settings", json={"mail_to": ""},
                      headers={"X-JWS-CSRF": csrf}).status_code == 200
    assert client.get("/api/meeting/settings").json()["mail_to"] == ""
    assert client.put("/api/meeting/settings", json={"mail_to": "x@y.cn"}).status_code == 403, "写偏好必须带 CSRF"


def test_meeting_recipient_pref_overrides_default(monkeypatch):
    mail_calls = []
    client, csrf, token = _start_meeting(monkeypatch, mail_calls=mail_calls)
    assert client.put("/api/meeting/settings", json={"mail_to": "boss@corp.cn"},
                      headers={"X-JWS-CSRF": csrf}).status_code == 200
    with _connect(client, token) as ws:
        ws.send_json({"type": "init", "csrf": csrf})
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(b"\x00" + "F:测试收件人。".encode())
        assert ws.receive_json()["type"] == "segment"
        ws.send_json({"type": "stop"})
        ws.receive_json()  # stopped
        ws.receive_json()  # minutes
        mail = ws.receive_json()
        assert mail["to"] == "boss@corp.cn"
    assert mail_calls[0]["to"] == "boss@corp.cn"
