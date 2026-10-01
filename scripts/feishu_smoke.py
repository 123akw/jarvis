#!/usr/bin/env python3
"""飞书机器人冒烟：默认离线自检；--live 真连飞书验证凭据、机器人能力、长连接与回复链路。

用法：
    .venv/bin/python scripts/feishu_smoke.py                 # 离线自检（帧编解码黄金向量 + ack，不联网）
    .venv/bin/python scripts/feishu_smoke.py --live          # 真连飞书，等你在飞书里给机器人发一条消息
    .venv/bin/python scripts/feishu_smoke.py --live --wait 300 --send-to ou_xxx   # 另外主动发一条测试消息

--live 判定（逐项打印 PASS/FAIL，全部通过退出码 0）：
  1. .env/环境变量里有 FEISHU_APP_ID / FEISHU_APP_SECRET（缺则退出码 2：待凭证）
  2. 能取到 tenant_access_token（凭据正确、应用已启用）
  3. GET /bot/v3/info 成功（已开启机器人能力并发布版本）
  4. 长连接握手成功——此时可去开发者后台「事件与回调」保存「使用长连接接收事件」
     （后台要求保存时有在线长连接，所以先跑本脚本、保持运行、再去点保存）
  5. --wait 秒内收到一条 im.message.receive_v1（单聊直接发 / 群里 @机器人），
     并以流式卡片回声回复（不调大模型、不需要绑定）；卡片不可用时降级文本并给出缺权限提示
凭据只从 .env/环境变量读取，绝不打印；open_id 只打印前 8 位。

注意：长连接是「集群模式」，同一应用若有别的进程（比如线上贾维斯服务）也连着，
事件只会随机推给其中一个——冒烟前请先停掉其他连接，或换一个测试应用。
"""
from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jarvis import config  # noqa: E402
from jarvis.channels.feishu.api import FeishuAPI, FeishuAPIError  # noqa: E402
from jarvis.channels.feishu.bridge import CardStream, FeishuSettings, parse_event  # noqa: E402
from jarvis.channels.feishu.frame import METHOD_DATA, Frame, ping_frame  # noqa: E402
from jarvis.channels.feishu.ws import LongConnection  # noqa: E402

GOLDEN_PING = "0800100018b96020002a0c0a0474797065120470696e67"
_results: list[bool] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    _results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('：' + detail) if detail else ''}")
    return ok


def offline() -> int:
    check("心跳帧与官方 SDK 字节一致", ping_frame(12345).encode().hex() == GOLDEN_PING)

    class MemoryWS:
        sent: list[Frame] = []

        def send(self, data):
            self.sent.append(Frame.decode(data))

    got = []
    conn = LongConnection("cli_offline", "x", on_event=got.append)
    event = {"schema": "2.0", "header": {"event_id": "e", "event_type": "im.message.receive_v1"}, "event": {}}
    raw = Frame(seq_id=3, method=METHOD_DATA, headers=[("type", "event"), ("sum", "1"), ("seq", "0")],
                payload=json.dumps(event).encode()).encode()
    ws = MemoryWS()
    conn.handle_frame(ws, raw)
    ack = ws.sent[0] if ws.sent else None
    check("事件帧回调并立即 ack {code:200}",
          bool(got) and ack is not None and ack.seq_id == 3 and json.loads(ack.payload) == {"code": 200})
    print("离线自检完成；凭据到位后用 --live 真连。")
    return 0 if all(_results) else 1


def live(wait_seconds: int, send_to: str) -> int:
    config.load_env()
    settings = FeishuSettings.from_env()
    if not settings.configured:
        check("读取 FEISHU_APP_ID / FEISHU_APP_SECRET", False, "未配置（待凭证，见 BLOCKED.md 飞书小节）")
        return 2
    check("读取 FEISHU_APP_ID / FEISHU_APP_SECRET", True, f"app_id={settings.app_id[:8]}…")
    api = FeishuAPI(settings.app_id, settings.app_secret, domain=settings.domain)
    try:
        token = api.tenant_token()
        check("获取 tenant_access_token", bool(token), f"长度 {len(token)}")
    except FeishuAPIError as exc:
        check("获取 tenant_access_token", False, f"code={exc.code} {exc.msg}（检查 App ID/Secret）")
        return 1
    try:
        bot = api.bot_info()
        bot_open_id = str(bot.get("open_id") or "")
        check("机器人信息 /bot/v3/info", bool(bot_open_id),
              f"{bot.get('app_name', '')} activate_status={bot.get('activate_status')} open_id={bot_open_id[:8]}…")
    except FeishuAPIError as exc:
        check("机器人信息 /bot/v3/info", False, f"code={exc.code} {exc.msg}（是否已开启机器人能力并发布版本？）")
        return 1
    if send_to:
        id_type = "chat_id" if send_to.startswith("oc_") else "open_id"
        try:
            api.send(id_type, send_to, "text", {"text": "贾维斯飞书冒烟：主动发送测试 ✅"})
            check("主动发送测试消息", True, id_type)
        except FeishuAPIError as exc:
            check("主动发送测试消息", False, f"code={exc.code} {exc.msg}（im:message:send_as_bot 权限 / 可用范围？）")

    events: queue.Queue = queue.Queue()
    connected = threading.Event()
    last_error = {"text": ""}

    def on_state(state: str, error: str) -> None:
        print(f"      长连接状态：{state}{(' — ' + error) if error else ''}")
        if state == "connected":
            connected.set()
        if error:
            last_error["text"] = error

    conn = LongConnection(settings.app_id, settings.app_secret, domain=settings.domain,
                          on_event=events.put, on_state=on_state)
    conn.start()
    try:
        if not check("长连接握手", connected.wait(30), last_error["text"]):
            return 1
        print(f"      现在可以去开发者后台保存「使用长连接接收事件」。请在 {wait_seconds} 秒内给机器人发一条文字"
              "（单聊直接发；群聊需 @机器人）…")
        deadline = time.monotonic() + wait_seconds
        inbound = None
        while inbound is None and time.monotonic() < deadline:
            try:
                event = events.get(timeout=1)
            except queue.Empty:
                continue
            inbound = parse_event(event, bot_open_id)
        if not check("收到 im.message.receive_v1", inbound is not None,
                     "" if inbound else "超时：检查事件订阅（接收消息 v2.0）、单聊/群@权限、是否已发布版本"):
            return 1
        print(f"      来自 open_id={inbound.open_id[:8]}… chat_type={inbound.chat_type} 类型={inbound.msg_type}")
        echo = f"贾维斯飞书冒烟：收到「{inbound.text or inbound.msg_type}」✅"
        card = CardStream(api, time.monotonic)
        try:
            card.open(inbound.message_id, in_thread=bool(inbound.topic_id))
            card.progress("正在验证流式卡片…", None)
            time.sleep(0.8)
            check("流式卡片回复（cardkit:card:write）", card.finish(echo, echo))
        except FeishuAPIError as exc:
            check("流式卡片回复（cardkit:card:write）", False, f"code={exc.code} {exc.msg}，降级为文本")
            try:
                api.reply(inbound.message_id, "text", {"text": echo})
                check("文本回复（im:message:send_as_bot）", True)
            except FeishuAPIError as exc2:
                check("文本回复（im:message:send_as_bot）", False, f"code={exc2.code} {exc2.msg}")
    finally:
        conn.stop(timeout=5)
        api.close()
    return 0 if all(_results) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", action="store_true", help="真连飞书（需要 FEISHU_APP_ID/FEISHU_APP_SECRET）")
    parser.add_argument("--wait", type=int, default=120, help="--live 时等待消息的秒数（默认 120）")
    parser.add_argument("--send-to", default="", help="可选：主动发一条测试消息给 open_id(ou_…) 或 chat_id(oc_…)")
    args = parser.parse_args()
    return live(args.wait, args.send_to) if args.live else offline()


if __name__ == "__main__":
    raise SystemExit(main())
