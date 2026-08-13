"""微信语音发送侧冒烟：文字 → speakable 净化 → MiniMax TTS → silk 编码。

用法：
    .venv/bin/python scripts/wechat_voice_smoke.py [--text 一段话] [--out-dir 目录]

产物（默认写当前目录）：
- wechat_voice_smoke.wav  可直接播放的 wav（24kHz/16bit/单声道），人耳验听；
- wechat_voice_smoke.silk 微信系 silk v3（tencent 变体），即 sendmessage 要发的字节。

判定：wav 与 silk 字节数都 > 0 且时长 > 0ms → PASS 退出 0；任何一环失败退出 1。
MINIMAX_API_KEY 只从 .env/环境变量读，绝不打印。
"""
import argparse
import os
import sys
import time

from jarvis import config
from jarvis.voice.tts import SAMPLE_RATE as TTS_SAMPLE_RATE
from jarvis.wechat_voice import (
    VoiceError,
    build_voice_items,
    encode_silk,
    pcm_to_wav,
    synthesize_pcm,
)

SMOKE_TEXT = "你好，我是贾维斯。这是微信语音回复链路的冒烟测试，请注意收听。"


def main() -> int:
    parser = argparse.ArgumentParser(description="微信语音发送侧冒烟")
    parser.add_argument("--text", default=SMOKE_TEXT, help="要合成的文字")
    parser.add_argument("--out-dir", default=".", help="产物输出目录")
    args = parser.parse_args()
    config.load_env()

    t0 = time.monotonic()
    try:
        pcm = synthesize_pcm(args.text)
    except VoiceError as exc:
        print(f"TTS 合成：失败（{exc}）")
        print("硬指标（wav>0 且 silk>0 且时长>0）：FAIL")
        return 1
    tts_ms = (time.monotonic() - t0) * 1000
    print(f"TTS 合成：成功 {tts_ms:.0f}ms，PCM {len(pcm)} 字节"
          f"（{TTS_SAMPLE_RATE}Hz/16bit/单声道）")

    try:
        wav = pcm_to_wav(pcm, TTS_SAMPLE_RATE)
        silk, duration_ms = encode_silk(pcm, TTS_SAMPLE_RATE)
        items = build_voice_items(silk, duration_ms)
    except VoiceError as exc:
        print(f"编码：失败（{exc}）")
        print("硬指标（wav>0 且 silk>0 且时长>0）：FAIL")
        return 1

    os.makedirs(args.out_dir, exist_ok=True)
    wav_path = os.path.join(args.out_dir, "wechat_voice_smoke.wav")
    silk_path = os.path.join(args.out_dir, "wechat_voice_smoke.silk")
    with open(wav_path, "wb") as handle:
        handle.write(wav)
    with open(silk_path, "wb") as handle:
        handle.write(silk)

    item = items[0]
    item_key = next(k for k in item if k != "type")
    print(f"可播放 wav：{wav_path}（{len(wav)} 字节）")
    print(f"微信 silk ：{silk_path}（{len(silk)} 字节，头 {silk[:10]!r}）")
    print(f"语音时长：{duration_ms}ms")
    print(f"sendmessage item：type={item['type']}，key={item_key}，"
          f"字段={sorted(item[item_key])}")

    ok = len(wav) > 0 and len(silk) > 0 and duration_ms > 0
    print(f"硬指标（wav>0 且 silk>0 且时长>0）：{'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
