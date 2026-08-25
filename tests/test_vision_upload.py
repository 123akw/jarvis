"""视觉理解模块 + /api/upload 图片/视频分支：HTTP 全打桩，不联网。"""
import base64

import pytest
from fastapi.testclient import TestClient

import jarvis.server as server_mod
import jarvis.vision as vision_mod


def _fake_post(record, text="一张测试图片。"):
    def http_post(url, headers=None, json=None):
        record.append({"url": url, "headers": headers, "json": json})
        return {"output": {"choices": [{"message": {"content": [{"text": text}]}}]}}
    return http_post


def test_describe_image_builds_data_uri_request(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    calls = []
    text = vision_mod.describe_image(b"\x89PNG-fake", "png", http_post=_fake_post(calls))
    assert text == "一张测试图片。"
    body = calls[0]["json"]
    assert body["model"] == vision_mod.DEFAULT_VL_MODEL
    content = body["input"]["messages"][0]["content"]
    assert content[0]["image"].startswith("data:image/png;base64,")
    assert base64.b64decode(content[0]["image"].split(",", 1)[1]) == b"\x89PNG-fake"
    assert "描述" in content[1]["text"]
    assert calls[0]["headers"]["Authorization"] == "Bearer sk-test"


def test_describe_video_shape_and_caps(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    calls = []
    vision_mod.describe_video(b"mp4-bytes", "mp4", http_post=_fake_post(calls, "视频内容。"))
    content = calls[0]["json"]["input"]["messages"][0]["content"]
    assert content[0]["video"].startswith("data:video/mp4;base64,")
    assert content[0]["fps"] == 2
    with pytest.raises(vision_mod.VisionError) as exc:
        vision_mod.describe_video(b"x" * (vision_mod.MAX_VIDEO_BYTES + 1), "mp4")
    assert "7MB" in str(exc.value)
    with pytest.raises(vision_mod.VisionError):
        vision_mod.describe_image(b"x" * (vision_mod.MAX_IMAGE_BYTES + 1), "png")


def test_vision_requires_key_and_wraps_failures(monkeypatch):
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    with pytest.raises(vision_mod.VisionError) as exc:
        vision_mod.describe_image(b"img", "png")
    assert "未配置" in str(exc.value)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")

    def broken(url, headers=None, json=None):
        raise RuntimeError("secret upstream detail")
    with pytest.raises(vision_mod.VisionError) as exc:
        vision_mod.describe_image(b"img", "png", http_post=broken)
    assert "secret" not in str(exc.value), "上游细节不得透传"


def test_extension_detection():
    assert vision_mod.image_extension("photo.JPG") == "jpg"
    assert vision_mod.image_extension("截图.png") == "png"
    assert vision_mod.image_extension("report.pdf") is None
    assert vision_mod.video_extension("clip.mp4") == "mp4"
    assert vision_mod.video_extension("demo.avi") is None


def _client_with_login():
    client = TestClient(server_mod.app)
    assert client.post("/api/login", json={"username": "admin", "password": "admin"}).status_code == 200
    csrf = client.get("/api/session").json()["csrf_token"]
    return client, csrf


def _upload(client, csrf, name, data=b"bytes"):
    return client.post("/api/upload", headers={"X-JWS-CSRF": csrf},
                       json={"name": name, "content_b64": base64.b64encode(data).decode()})


def test_upload_routes_images_and_videos_to_vision(monkeypatch):
    monkeypatch.setattr(server_mod.vision if hasattr(server_mod, "vision") else vision_mod,
                        "describe_image", lambda data, ext, **kw: f"图片描述({ext})")
    monkeypatch.setattr(vision_mod, "describe_image", lambda data, ext, **kw: f"图片描述({ext})")
    monkeypatch.setattr(vision_mod, "describe_video", lambda data, ext, **kw: "视频描述")
    client, csrf = _client_with_login()
    image = _upload(client, csrf, "现场照片.jpg").json()
    assert image["kind"] == "image" and image["text"] == "图片描述(jpg)"
    video = _upload(client, csrf, "demo.mp4").json()
    assert video["kind"] == "video" and video["text"] == "视频描述"
    doc = _upload(client, csrf, "笔记.txt", "会议要点".encode()).json()
    assert doc["kind"] == "document" and "会议要点" in doc["text"]


def test_upload_vision_error_returns_human_message(monkeypatch):
    def broken(data, ext, **kw):
        raise vision_mod.VisionError("图像识别未配置（缺 DASHSCOPE_API_KEY）")
    monkeypatch.setattr(vision_mod, "describe_image", broken)
    client, csrf = _client_with_login()
    response = _upload(client, csrf, "a.png")
    assert response.status_code == 422
    assert "未配置" in response.json()["error"]
