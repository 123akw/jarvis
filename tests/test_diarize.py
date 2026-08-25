"""说话人分离：三段式 HTTP 打桩 + 会议段落重标注 + finalize 集成。"""
import datetime
import os

import pytest

import jarvis.meeting as meeting_mod
import jarvis.server as server_mod
import jarvis.voice.diarize as diarize_mod
from jarvis import mailer as mailer_mod


class _Resp:
    def __init__(self, payload=None, status=200):
        self._payload = payload or {}
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self):
        return self._payload


class _FakeHttp:
    """按 URL 分发的假 httpx：getPolicy → 表单上传 → 提交任务 → 轮询 → 下载结果。"""

    def __init__(self):
        self.calls = []
        self.poll_times = 0

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        if "uploads" in url:
            return _Resp({"data": {
                "policy": "p", "signature": "s", "upload_dir": "dir/123",
                "upload_host": "https://oss.example.com", "oss_access_key_id": "ak",
            }})
        if "/tasks/" in url:
            self.poll_times += 1
            if self.poll_times < 2:
                return _Resp({"output": {"task_status": "RUNNING"}})
            return _Resp({"output": {"task_status": "SUCCEEDED", "results": [
                {"transcription_url": "https://result.example.com/r.json"}]}})
        if "result.example.com" in url:
            return _Resp({"transcripts": [{"sentences": [
                {"begin_time": 0, "end_time": 4000, "speaker_id": 0, "text": "方案没问题。"},
                {"begin_time": 5000, "end_time": 9000, "speaker_id": 1, "text": "预算我来批。"},
            ]}]})
        raise AssertionError(f"unexpected GET {url}")

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        if "oss.example.com" in url:
            form = kwargs["data"]
            assert form["key"].startswith("dir/123/")
            return _Resp(status=200)
        if "transcription" in url:
            headers = kwargs["headers"]
            assert headers["X-DashScope-Async"] == "enable"
            assert headers["X-DashScope-OssResourceResolve"] == "enable"
            body = kwargs["json"]
            assert body["model"] == "paraformer-v2"
            assert body["parameters"]["diarization_enabled"] is True
            assert body["input"]["file_urls"][0].startswith("oss://dir/123/")
            return _Resp({"output": {"task_id": "task-1"}})
        raise AssertionError(f"unexpected POST {url}")


def _wav(tmp_path, size=diarize_mod._MIN_WAV_BYTES + 10):
    path = tmp_path / "meeting.wav"
    path.write_bytes(b"\x00" * size)
    return str(path)


def test_diarize_wav_full_pipeline(tmp_path, monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    http = _FakeHttp()
    sentences = diarize_mod.diarize_wav(_wav(tmp_path), http=http, sleep=lambda _s: None)
    assert sentences == [
        {"start_ms": 0, "end_ms": 4000, "speaker": 0, "text": "方案没问题。"},
        {"start_ms": 5000, "end_ms": 9000, "speaker": 1, "text": "预算我来批。"},
    ]


def test_diarize_guards(tmp_path, monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    with pytest.raises(diarize_mod.DiarizeError):
        diarize_mod.diarize_wav(_wav(tmp_path, size=100))   # 太短不烧任务
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    with pytest.raises(diarize_mod.DiarizeError):
        diarize_mod.diarize_wav(_wav(tmp_path))


def _session_with_two_speakers():
    clock = {"now": datetime.datetime(2026, 8, 25, 10, 0, 0)}
    session = meeting_mod.MeetingSession("u1", "评审会", now_fn=lambda: clock["now"])
    session.record_others(b"\x00\x00" * 800)  # 打开录音：audio_started_at = 10:00:00
    clock["now"] = datetime.datetime(2026, 8, 25, 10, 0, 3)
    session.add_segment(meeting_mod.SPEAKER_OTHERS, "方案没问题。")
    clock["now"] = datetime.datetime(2026, 8, 25, 10, 0, 5)
    session.add_segment(meeting_mod.SPEAKER_ME, "那预算呢？")
    clock["now"] = datetime.datetime(2026, 8, 25, 10, 0, 8)
    session.add_segment(meeting_mod.SPEAKER_OTHERS, "预算我来批。")
    return session


SENTENCES = [
    {"start_ms": 0, "end_ms": 4000, "speaker": 0, "text": "方案没问题。"},
    {"start_ms": 5000, "end_ms": 9000, "speaker": 1, "text": "预算我来批。"},
]


def test_relabel_others_assigns_speaker_numbers():
    session = _session_with_two_speakers()
    assert session.relabel_others(SENTENCES) == 2
    transcript = session.transcript_text()
    assert "对方1：方案没问题。" in transcript
    assert "对方2：预算我来批。" in transcript
    assert "我：那预算呢？" in transcript, "「我」的段落不动"


def test_relabel_skips_single_speaker():
    session = _session_with_two_speakers()
    single = [dict(SENTENCES[0])]
    assert session.relabel_others(single) == 1
    assert "对方：方案没问题。" in session.transcript_text(), "单说话人保持「对方」"


def test_finalize_runs_diarization_and_cleans_audio(monkeypatch):
    class _Agent:
        def invoke(self, state, config=None):
            return {"messages": [type("M", (), {"content": "# 会议纪要\n- ok"})()]}
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _Agent())
    monkeypatch.setattr(mailer_mod, "send_mail", lambda *a, **k: None)
    monkeypatch.setattr(diarize_mod, "diarize_wav", lambda path, **kw: SENTENCES)

    from fastapi.testclient import TestClient
    client = TestClient(server_mod.app)
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    from jarvis.accounts import AccountStore
    owner = AccountStore().unique_active_owner()

    session = _session_with_two_speakers()
    audio_path = session.audio_path
    assert audio_path and os.path.exists(audio_path)
    result = server_mod._meeting_finalize(owner.user_id, session)
    assert result["ok"]
    assert "2 位对方说话人" in result["message"]
    assert not os.path.exists(audio_path), "会议音频用完即删"
    with __import__("jarvis.tenancy", fromlist=["tenant_scope"]).tenant_scope(owner.user_id):
        from jarvis.tenancy import TenantStore
        detail = TenantStore().get_meeting(result["meeting_id"])
    assert "对方1：方案没问题。" in detail["transcript"]
    assert "对方2：预算我来批。" in detail["transcript"]


def test_finalize_survives_diarize_failure(monkeypatch):
    class _Agent:
        def invoke(self, state, config=None):
            return {"messages": [type("M", (), {"content": "# 会议纪要"})()]}
    monkeypatch.setattr(server_mod, "_get_agent", lambda: _Agent())
    monkeypatch.setattr(mailer_mod, "send_mail", lambda *a, **k: None)
    monkeypatch.setattr(diarize_mod, "diarize_wav",
                        lambda path, **kw: (_ for _ in ()).throw(diarize_mod.DiarizeError("跳过")))
    from fastapi.testclient import TestClient
    client = TestClient(server_mod.app)
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    from jarvis.accounts import AccountStore
    owner = AccountStore().unique_active_owner()
    session = _session_with_two_speakers()
    result = server_mod._meeting_finalize(owner.user_id, session)
    assert result["ok"], "分离失败必须降级为不分说话人，不影响纪要"
    from jarvis.tenancy import TenantStore, tenant_scope
    with tenant_scope(owner.user_id):
        detail = TenantStore().get_meeting(result["meeting_id"])
    assert "对方：方案没问题。" in detail["transcript"], "降级后保持不分说话人的原样转写"
