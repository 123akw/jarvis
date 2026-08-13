"""语音链路冒烟：--live 真连 MiniMax 流式 TTS，打印会话建立、首包延迟与音频字节数。

用法：
    .venv/bin/python scripts/voice_smoke.py --live

判定（--live）：
- 会话建立（wss 握手 + task_start）成功；
- 收到音频字节数 > 0；
- 首包延迟（送出文本 → 收到第一块音频）打印为 ms；
全部满足退出码 0，否则非 0。MINIMAX_API_KEY 只从 .env/环境变量读，绝不打印。

不带 --live 时只做离线自检（切句器），不联网。
"""
import argparse
import asyncio
import sys
import time

from jarvis import config
from jarvis.voice.segment import SentenceSegmenter
from jarvis.voice.tts import TTSError, TTSSession

SMOKE_TEXT = "你好，我是贾维斯。语音链路冒烟测试进行中，请注意收听这一段合成语音。"


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


def main() -> int:
    parser = argparse.ArgumentParser(description="语音链路冒烟")
    parser.add_argument("--live", action="store_true", help="真连 MiniMax TTS")
    args = parser.parse_args()
    config.load_env()
    if not args.live:
        return offline_check()
    return asyncio.run(live_check())


if __name__ == "__main__":
    sys.exit(main())
