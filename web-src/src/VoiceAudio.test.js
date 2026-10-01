import { describe, expect, it } from 'vitest'

import { FRAME_SAMPLES, WORKLET_SOURCE } from './VoiceAudio.js'

/** 在测试里跑 AudioWorklet 源码：注入假 AudioWorkletProcessor / registerProcessor / sampleRate。 */
function loadWorklet(rate) {
  let Ctor = null
  const posted = []
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: m => posted.push(m) } } }
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET_SOURCE)(
    AudioWorkletProcessor, (_name, C) => { Ctor = C }, rate)
  return { proc: new Ctor(), posted }
}

function ramp(n) {
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = ((i % 2000) - 1000) / 2000
  return s
}

function feed(proc, signal, block = 128) {
  for (let i = 0; i < signal.length; i += block) proc.process([[signal.subarray(i, i + block)]])
}

const toInt16 = v => Math.trunc(v < 0 ? v * 0x8000 : v * 0x7fff)

describe('麦克风采集 AudioWorklet', () => {
  it('源缓冲预分配复用：375 次 process 不再每块新建数组', () => {
    const { proc } = loadWorklet(48000)
    const buf = proc.src
    feed(proc, ramp(48000))
    expect(proc.src).toBe(buf)
    expect(proc.srcLen).toBeLessThan(4)
  })

  it('48kHz→16kHz 逐样本对齐，1 秒恰好 16000 个样本（旧实现多出 125 个、时间轴被拉长）', () => {
    const { proc, posted } = loadWorklet(48000)
    const signal = ramp(48000)
    feed(proc, signal)
    expect(posted).toHaveLength(10)
    expect(proc.frameLen).toBe(0)
    const out = posted.flatMap(m => Array.from(new Int16Array(m.pcm)))
    expect(out).toHaveLength(10 * FRAME_SAMPLES)
    const misaligned = out.findIndex((v, k) => Math.abs(v - toInt16(signal[3 * k])) > 1)
    expect(misaligned).toBe(-1)
  })

  it('44.1kHz 输入 1 秒产出 16000±1 个样本；超大渲染块自动扩容', () => {
    const { proc, posted } = loadWorklet(44100)
    feed(proc, ramp(44100))
    expect(Math.abs(posted.length * FRAME_SAMPLES + proc.frameLen - 16000)).toBeLessThanOrEqual(1)
    const big = loadWorklet(48000)
    feed(big.proc, ramp(48000), 4096)
    expect(big.posted).toHaveLength(10)
    expect(big.proc.frameLen).toBe(0)
  })
})
