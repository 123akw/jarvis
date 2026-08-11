"""贾维斯 · 个人微信网关（iLink Bot API）

参考 Hermes Agent 的接入路子：不走逆向协议，用腾讯 2026 官方开放的个人号 Bot API
（iLink / 微信 ClawBot，纯 HTTP/JSON，无需公网）。本脚本只做「桥」——扫码登录微信、
长轮询收消息、转发给贾维斯（服务器的 OpenAI 兼容接口 /v1/chat/completions）、把回复发回微信。

⚠ 风险：个人号 Bot 属腾讯可随时调整/终止的服务，且第三方接入有封号可能。
   强烈建议用专用小号，别用主号；别群发、别高频。

依赖：httpx（贾维斯 venv 已装）。
配置（环境变量或同目录 .env）：
  JARVIS_URL       贾维斯服务器地址，默认 https://jws.gkgeek-set.cn
  JARVIS_TOKEN     贾维斯会话令牌：用 admin/admin 登录 /api/login 拿 token 字段
  WX_ALLOW         允许对话的微信 from_user_id 白名单（逗号分隔）；留空=仅私聊全放行
  WX_GROUP         是否响应群聊，默认 false（个人助理默认只私聊）
运行：python wechat/ilink_gateway.py  → 终端出二维码 → 微信扫码确认
"""
import base64
import os
import random
import sys
import time
from pathlib import Path

import httpx

ILINK = "https://ilinkai.weixin.qq.com/ilink/bot"
ROOT = Path(__file__).resolve().parent
CRED = ROOT / ".ilink_token"


def _load_env():
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def _headers(token: str) -> dict:
    return {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": base64.b64encode(str(random.randint(1, 2**32 - 1)).encode()).decode(),
        "Authorization": f"Bearer {token}",
    }


def login(client: httpx.Client) -> str:
    """扫码登录，返回 bot_token；已有缓存则直接复用。"""
    if CRED.exists():
        tok = CRED.read_text(encoding="utf-8").strip()
        if tok:
            print("已复用上次登录凭据（失效会自动重新扫码）。")
            return tok
    r = client.get(f"{ILINK}/get_bot_qrcode", params={"bot_type": 3}, timeout=15)
    r.raise_for_status()
    data = r.json()
    qrcode = data["qrcode"]
    img = data.get("qrcode_img_content")
    if img:
        png = ROOT / "wx_login_qr.png"
        png.write_bytes(base64.b64decode(img))
        print(f"二维码已保存到 {png}，用微信扫码并在手机上确认登录。")
    print("等待扫码…")
    while True:
        s = client.get(f"{ILINK}/get_qrcode_status", params={"qrcode": qrcode}, timeout=15).json()
        if s.get("status") == "confirmed":
            tok = s["bot_token"]
            CRED.write_text(tok, encoding="utf-8")
            CRED.chmod(0o600)
            print("登录成功，微信桥已就绪。")
            return tok
        time.sleep(1)


def ask_jarvis(text: str, thread_id: str) -> str:
    url = os.getenv("JARVIS_URL", "https://jws.gkgeek-set.cn").rstrip("/")
    token = os.environ["JARVIS_TOKEN"]
    r = httpx.post(f"{url}/v1/chat/completions", timeout=120,
                   headers={"Authorization": f"Bearer {token}",
                            "X-Thread-Id": f"wx-{thread_id}"},
                   json={"model": "jarvis", "stream": False,
                         "messages": [{"role": "user", "content": text}]})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _text_of(msg: dict) -> str:
    for it in msg.get("item_list", []):
        if it.get("type") == 1:
            return it.get("text_item", {}).get("text", "")
    return ""


def _allowed(from_id: str) -> bool:
    allow = [x.strip() for x in os.getenv("WX_ALLOW", "").split(",") if x.strip()]
    is_group = "@im.chatroom" in from_id or "group" in from_id.lower()
    if is_group and os.getenv("WX_GROUP", "false").lower() != "true":
        return False
    return not allow or from_id in allow


def send(client: httpx.Client, token: str, to_id: str, ctx: str, text: str):
    client.post(f"{ILINK}/sendmessage", headers=_headers(token), timeout=20, json={
        "msg": {"to_user_id": to_id, "message_type": 2, "message_state": 2,
                "context_token": ctx,
                "item_list": [{"type": 1, "text_item": {"text": text}}]},
    })


def main():
    _load_env()
    if not os.getenv("JARVIS_TOKEN"):
        sys.exit("缺 JARVIS_TOKEN。先登录拿令牌：\n"
                 "  curl -s -X POST $JARVIS_URL/api/login -H 'Content-Type: application/json' "
                 "-d '{\"username\":\"admin\",\"password\":\"admin\"}'\n"
                 "把返回的 token 写进 wechat/.env 的 JARVIS_TOKEN。")
    client = httpx.Client(trust_env=False)
    token = login(client)
    buf = ""
    print("开始收消息（Ctrl+C 退出）…")
    while True:
        try:
            r = client.post(f"{ILINK}/getupdates", headers=_headers(token), timeout=45,
                            json={"get_updates_buf": buf, "base_info": {"channel_version": "1.0.2"}})
            if r.status_code == 401:
                print("登录态失效，重新扫码…")
                CRED.unlink(missing_ok=True)
                token = login(client)
                continue
            data = r.json()
            buf = data.get("get_updates_buf", buf)
            for m in data.get("msgs", []):
                if m.get("message_type") != 1:
                    continue
                from_id = m.get("from_user_id", "")
                text = _text_of(m).strip()
                if not text or not _allowed(from_id):
                    continue
                print(f"← {from_id[:16]}: {text}")
                try:
                    reply = ask_jarvis(text, from_id.split("@")[0][-12:])
                except Exception as e:
                    reply = f"（贾维斯暂时无法应答：{type(e).__name__}）"
                send(client, token, from_id, m.get("context_token", ""), reply)
                print(f"→ {reply[:40]}")
        except httpx.HTTPError as e:
            print(f"网络波动（{type(e).__name__}），2 秒后重试…")
            time.sleep(2)
        except KeyboardInterrupt:
            print("\n已退出微信桥。")
            break


if __name__ == "__main__":
    main()
