#!/usr/bin/env python3
"""百炼实时识别冒烟：--live 真连 paraformer-realtime-v2 识别一段中文语音并贴出文字。

用法：
    .venv/bin/python scripts/asr_smoke.py            # 离线自检（协议解析，不联网）
    .venv/bin/python scripts/asr_smoke.py --live     # 真连百炼；无 --wav 时先用
                                                     # MiniMax TTS 合成一句话再识别（回环验证）
    .venv/bin/python scripts/asr_smoke.py --live --wav path/to/16k_mono.wav

判定（--live）：
- 无 DASHSCOPE_API_KEY → 直接失败并提示（待 key）；
- 识别出的定稿文字非空；合成回环模式下还要与原句字符重合率 ≥50%（防假绿）；
全部满足退出码 0。key 只从 .env/环境变量读，绝不打印。
"""
import argparse
import asyncio
import json
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jarvis import config  # noqa: E402
from jarvis.voice.asr import ASRError, ASRResult, ASRSession, SAMPLE_RATE  # noqa: E402

LOOP_TEXT = "明天上午九点提醒我参加项目周会。"
CHUNK_BYTES = 3200  # 100ms @16kHz PCM16 单声道


def resample_pcm16(data: bytes, src_rate: int, dst_rate: int = SAMPLE_RATE) -> bytes:
    """线性插值重采样，纯标准库（audioop 已从 3.13 移除）。"""
    if src_rate == dst_rate:
        return data
    import array
    src = array.array("h")
    src.frombytes(data[: len(data) - (len(data) % 2)])
    if not src:
        return b""
    n_out = int(len(src) * dst_rate / src_rate)
    out = array.array("h", bytes(2 * n_out))
    for i in range(n_out):
        pos = i * src_rate / dst_rate
        j = int(pos)
        frac = pos - j
        a = src[j]
        b = src[j + 1] if j + 1 < len(src) else a
        out[i] = int(a + (b - a) * frac)
    return out.tobytes()


def load_wav_16k(path: str) -> bytes:
    with wave.open(path, "rb") as wf:
        if wf.getsampwidth() != 2 or wf.getnchannels() != 1:
            raise SystemExit(f"只支持 16-bit 单声道 wav：{path}")
        frames = wf.readframes(wf.getnframes())
        return resample_pcm16(frames, wf.getframerate())


async def synthesize_loop_audio() -> bytes:
    """用 MiniMax TTS 合成 LOOP_TEXT（24kHz PCM16）→ 重采样 16kHz。"""
    from jarvis.voice.tts import TTSSession

    session = TTSSession()
    await session.connect()
    try:
        await session.speak(LOOP_TEXT)
        await session.finish()
        audio = b"".join([chunk async for chunk in session.audio_chunks()])
    finally:
        await session.close()
    print(f"[smoke] 合成回环音频：{len(audio)} 字节 @24kHz（原句：{LOOP_TEXT}）")
    return resample_pcm16(audio, 24000)


async def recognize(pcm16k: bytes) -> tuple[str, float]:
    session = ASRSession()
    t0 = time.monotonic()
    await session.connect()
    print(f"[smoke] 识别会话建立：{(time.monotonic() - t0) * 1000:.0f}ms（握手 + task-started）")

    async def pump():
        for i in range(0, len(pcm16k), CHUNK_BYTES):
            await session.send_audio(pcm16k[i:i + CHUNK_BYTES])
            await asyncio.sleep(0.03)  # 略快于实时，贴近真实推流节奏
        await session.finish()

    finals: list[str] = []
    first_result_ms = None
    pump_task = asyncio.create_task(pump())
    try:
        t_send = time.monotonic()
        async for result in session.results():
            if first_result_ms is None:
                first_result_ms = (time.monotonic() - t_send) * 1000
            if result.is_final:
                finals.append(result.text)
                print(f"[smoke] 定稿：{result.text}")
            else:
                print(f"[smoke] 识别中：{result.text}")
    finally:
        pump_task.cancel()
        await session.close()
    return "".join(finals), first_result_ms or -1.0


def offline_check() -> int:
    """不联网：走 ASRSession 的协议解析路径自检（假 ws 注入）。"""
    class _FakeWS:
        def __init__(self, incoming):
            self._incoming = list(incoming)

        async def recv(self):
            if not self._incoming:
                await asyncio.sleep(3600)
            return json.dumps(self._incoming.pop(0))

        async def send(self, data):
            pass

        async def close(self):
            pass

    def event(name, sentence=None):
        msg = {"header": {"event": name}, "payload": {}}
        if sentence is not None:
            msg["payload"] = {"output": {"sentence": sentence}}
        return msg

    async def scenario():
        session = ASRSession()
        session._ws = _FakeWS([
            event("result-generated", {"text": "你好", "sentence_end": False}),
            event("result-generated", {"text": "占位", "heartbeat": True}),
            event("result-generated", {"text": "你好，贾维斯。", "sentence_end": True}),
            event("task-finished"),
        ])
        session._receiver = asyncio.create_task(session._recv_loop())
        results = [r async for r in session.results()]
        await session.close()
        return results

    results = asyncio.run(scenario())
    ok = results == [ASRResult("你好", False), ASRResult("你好，贾维斯。", True)]
    print(f"离线自检（协议解析：增量/心跳丢弃/定稿）：{'PASS' if ok else 'FAIL'} {results}")
    print("提示：真连百炼请加 --live（需 .env 配置 DASHSCOPE_API_KEY）")
    return 0 if ok else 1


async def live_check(wav: str | None) -> int:
    import os
    if not os.getenv("DASHSCOPE_API_KEY", "").strip():
        print("FAIL：.env 未配置 DASHSCOPE_API_KEY，服务端识别待 key（见 BLOCKED.md）")
        return 1
    expected = None
    if wav:
        pcm = load_wav_16k(wav)
        print(f"[smoke] 读入 wav：{wav} → {len(pcm)} 字节 @16kHz")
    else:
        expected = LOOP_TEXT
        pcm = await synthesize_loop_audio()
    if not pcm:
        print("FAIL：没有可识别的音频")
        return 1
    try:
        text, first_ms = await recognize(pcm)
    except ASRError as exc:
        print(f"FAIL：{exc}")
        return 1
    print(f"[smoke] 首个识别结果延迟：{first_ms:.0f}ms")
    print(f"识别文字：{text or '（空）'}")
    if not text.strip():
        print("FAIL：识别结果为空")
        return 1
    if expected:
        strip = str.maketrans("", "", "，。！？、 ")
        want = expected.translate(strip)
        got = text.translate(strip)
        overlap = sum(1 for ch in want if ch in got) / max(1, len(want))
        print(f"回环字符重合率：{overlap:.0%}（原句：{expected}）")
        if overlap < 0.5:
            print("FAIL：识别文字与原句重合率不足 50%")
            return 1
    print("PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="百炼实时识别冒烟")
    parser.add_argument("--live", action="store_true", help="真连百炼识别")
    parser.add_argument("--wav", help="16kHz/16-bit/单声道 wav 路径（缺省用 TTS 合成回环）")
    args = parser.parse_args()
    config.load_env()
    if not args.live:
        return offline_check()
    return asyncio.run(live_check(args.wav))


if __name__ == "__main__":
    sys.exit(main())
