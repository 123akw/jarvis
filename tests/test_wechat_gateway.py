"""备用 iLink 网关的二维码渲染回归测试。"""
from pathlib import Path

from wechat import ilink_gateway


def test_write_qr_png_encodes_ilink_url(tmp_path):
    """防回归：qrcode_img_content 是 URL，不能再当 Base64 图片解码。"""
    write_qr_png = getattr(ilink_gateway, "write_qr_png", None)
    assert callable(write_qr_png), "gateway must expose URL-to-PNG rendering"
    output = tmp_path / "wechat-login.png"

    write_qr_png(
        "https://liteapp.weixin.qq.com/q/test?x=1",
        output,
    )

    assert output.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


def test_login_writes_scannable_png_and_persists_token(tmp_path, monkeypatch):
    """防回归：终端登录路径必须显示同一 URL 的二维码并保存确认 Token。"""
    class FakeClient:
        def __init__(self):
            self.responses = [
                {
                    "ret": 0,
                    "qrcode": "qr-id",
                    "qrcode_img_content": "https://liteapp.weixin.qq.com/q/test?x=1",
                },
                {"ret": 0, "status": "confirmed", "bot_token": "saved-token"},
            ]

        def get(self, _url, **_kwargs):
            payload = self.responses.pop(0)
            return type("Response", (), {
                "raise_for_status": lambda self: None,
                "json": lambda self: payload,
            })()

    monkeypatch.setattr(ilink_gateway, "ROOT", Path(tmp_path))
    monkeypatch.setattr(ilink_gateway, "CRED", Path(tmp_path) / ".ilink_token")
    monkeypatch.setattr(ilink_gateway.time, "sleep", lambda _seconds: None)

    token = ilink_gateway.login(FakeClient())

    assert token == "saved-token"
    assert (Path(tmp_path) / ".ilink_token").read_text(encoding="utf-8") == "saved-token"
    assert (Path(tmp_path) / "wx_login_qr.png").read_bytes().startswith(
        b"\x89PNG\r\n\x1a\n"
    )
