"""语音链路冒烟：--live 分两步——1) 真连 MiniMax 流式 TTS 测首包；
2) 拉起真实本地服务走完整通话回合（真 agent + 真 TTS），打印全链路
「说完→首音频」毫秒数，硬指标 ≤3500ms。

用法：
    .venv/bin/python scripts/voice_smoke.py --live

判定（--live）：
- TTS：会话建立成功、音频字节 >0、首包 ≤2500ms；
- 全链路：user_text 送出 → 收到第一帧二进制音频 ≤3500ms，且回合真实走完（turn_end）；
全部满足退出码 0，否则非 0。密钥只从 .env/环境变量读，绝不打印。

不带 --live 时只做离线自检（切句器），不联网。
"""
import argparse
import asyncio
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from jarvis import config
from jarvis.voice.segment import SentenceSegmenter
from jarvis.voice.tts import TTSError, TTSSession

ROOT = Path(__file__).resolve().parent.parent
SMOKE_TEXT = "你好，我是贾维斯。语音链路冒烟测试进行中，请注意收听这一段合成语音。"
TURN_TEXT = "给我讲一句话的冷知识。"
E2E_BUDGET_MS = 3500.0


def offline_check() -> int:
    seg = SentenceSegmenter()
    sentences = seg.push("第一句话在这里。第二句也到了！")
    tail = seg.flush()
    ok = sentences == ["第一句话在这里。", "第二句也到了！"] and tail is None
    print(f"离线自检（切句器）：{'PASS' if ok else 'FAIL'} {sentences}")
    print("提示：真连 MiniMax 请加 --live")
    return 0 if ok else 1


async def live_check() -> int:
    session = TTSSession()
    t0 = time.monotonic()
    try:
        await session.connect()
    except TTSError as exc:
        print(f"会话建立：失败（{exc}）")
        return 1
    established_ms = (time.monotonic() - t0) * 1000
    print(f"会话建立：成功 {established_ms:.0f}ms（wss 握手 + task_start）")

    t_send = time.monotonic()
    audio_bytes = 0
    first_packet_ms = None
    try:
        await session.speak(SMOKE_TEXT)
        await session.finish()
        async for chunk in session.audio_chunks():
            if first_packet_ms is None:
                first_packet_ms = (time.monotonic() - t_send) * 1000
            audio_bytes += len(chunk)
    except TTSError as exc:
        print(f"合成失败：{exc}")
        return 1
    finally:
        await session.close()

    if first_packet_ms is None or audio_bytes <= 0:
        print("收到音频字节数：0 —— FAIL")
        return 1
    print(f"收到音频字节数：{audio_bytes}（>0 ✓）")
    print(f"首包延迟：{first_packet_ms:.0f}ms（文本送出 → 第一块音频）")
    verdict = first_packet_ms <= 2500
    print(f"硬指标（首包 ≤2500ms 且音频 >0）：{'PASS' if verdict else 'FAIL'}")
    return 0 if verdict else 1


async def full_chain_check() -> int:
    """拉起真实服务，走一个完整语音回合，测「说完→首音频」全链路延迟。"""
    import httpx
    import websockets

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    data_dir = tempfile.mkdtemp(prefix="jarvis-voice-smoke-")
    user, password = "voice-smoke-owner", secrets.token_hex(12)
    env = dict(os.environ)
    env.update(
        JARVIS_PORT=str(port), JARVIS_DATA_DIR=data_dir,
        JARVIS_ADMIN_USERNAME=user, JARVIS_ADMIN_PASSWORD=password,
        JARVIS_SESSION_SECRET=secrets.token_hex(32),
        JARVIS_ENV="development", JARVIS_ALLOW_INSECURE_COOKIE="1",
    )
    log_path = Path(data_dir) / "server.log"
    with log_path.open("wb") as log_file:
        server = subprocess.Popen(
            [sys.executable, "-c", "from jarvis.server import run; run()"],
            cwd=ROOT, env=env, stdout=log_file, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 90
        async with httpx.AsyncClient(base_url=base) as client:
            while True:
                try:
                    if (await client.get("/api/session", timeout=5)).status_code == 200:
                        break
                except Exception:
                    pass
                if time.monotonic() > deadline:
                    print("全链路：服务未就绪 —— FAIL")
                    return 1
                await asyncio.sleep(0.5)
            login = await client.post("/api/login", json={"username": user, "password": password})
            if login.status_code != 200:
                print(f"全链路：登录失败 HTTP {login.status_code} —— FAIL")
                return 1
            csrf = (await client.get("/api/session")).json().get("csrf_token", "")
            cookie = "; ".join(f"{k}={v}" for k, v in client.cookies.items())

        async with websockets.connect(
                f"ws://127.0.0.1:{port}/api/voice/call",
                additional_headers={"Cookie": cookie}, max_size=None) as ws:
            await ws.send(json.dumps({"type": "init", "csrf": csrf, "thread_id": "voice-smoke"}))
            ready = json.loads(await asyncio.wait_for(ws.recv(), 15))
            if ready.get("type") != "ready":
                print(f"全链路：握手失败 {ready} —— FAIL")
                return 1
            print(f"[全链路] 我说：{TURN_TEXT}")
            t0 = time.monotonic()
            await ws.send(json.dumps({"type": "user_text", "text": TURN_TEXT}))
            first_audio_ms = None
            audio_bytes = 0
            reply = []
            finished = False
            while True:
                frame = await asyncio.wait_for(ws.recv(), 120)
                if isinstance(frame, (bytes, bytearray)):
                    if first_audio_ms is None:
                        first_audio_ms = (time.monotonic() - t0) * 1000
                    audio_bytes += len(frame)
                    continue
                event = json.loads(frame)
                if event["type"] == "token":
                    reply.append(event["text"])
                elif event["type"] == "tts_error":
                    print(f"全链路：TTS 降级（{event.get('message')}）—— FAIL")
                    return 1
                elif event["type"] == "turn_end":
                    finished = not event.get("interrupted")
                    break
                elif event["type"] == "error":
                    print(f"全链路：回合出错（{event.get('message')}）—— FAIL")
                    return 1
        print(f"[全链路] 贾维斯答：{''.join(reply)}")
        if first_audio_ms is None or not finished:
            print("全链路：没收到音频或回合未走完 —— FAIL")
            return 1
        print(f"[全链路] 音频共 {audio_bytes} 字节")
        print(f"全链路延迟「说完→首音频」：{first_audio_ms:.0f}ms（预算 {E2E_BUDGET_MS:.0f}ms）"
              f" —— {'PASS' if first_audio_ms <= E2E_BUDGET_MS else 'FAIL'}")
        return 0 if first_audio_ms <= E2E_BUDGET_MS else 1
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except Exception:
            server.kill()


def main() -> int:
    parser = argparse.ArgumentParser(description="语音链路冒烟")
    parser.add_argument("--live", action="store_true", help="真连 MiniMax TTS + 全链路回合")
    args = parser.parse_args()
    config.load_env()
    if not args.live:
        return offline_check()
    tts_rc = asyncio.run(live_check())
    if tts_rc != 0:
        return tts_rc
    return asyncio.run(full_chain_check())


if __name__ == "__main__":
    sys.exit(main())
