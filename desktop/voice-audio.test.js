const assert = require('node:assert/strict')
const { test } = require('node:test')

const { WORKLET_SOURCE, FRAME_SAMPLES } = require('./voice-audio.js')

/** 在 Node 里跑 AudioWorklet 源码：注入假 AudioWorkletProcessor / registerProcessor / sampleRate。 */
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

function toInt16(v) {
  return Math.trunc(v < 0 ? v * 0x8000 : v * 0x7fff)
}

test('采集 worklet：源缓冲预分配复用，375 次 process 不再新建数组', () => {
  const { proc } = loadWorklet(48000)
  const buf = proc.src
  feed(proc, ramp(48000))
  assert.equal(proc.src, buf, '常态下源缓冲必须是同一块内存（不再每块 new + slice）')
  assert.ok(proc.srcLen < 4, `只留重采样所需的尾巴，实际 ${proc.srcLen}`)
})

test('采集 worklet：48kHz→16kHz 逐样本对齐，1 秒恰好 16000 个样本（旧实现会多出 125 个）', () => {
  const { proc, posted } = loadWorklet(48000)
  const signal = ramp(48000)
  feed(proc, signal)
  assert.equal(posted.length, 10)
  assert.equal(proc.frameLen, 0, '1 秒输入不该有多余样本残留在帧里')
  const out = posted.flatMap(m => Array.from(new Int16Array(m.pcm)))
  assert.equal(out.length, 10 * FRAME_SAMPLES)
  for (let k = 0; k < out.length; k++) {
    const want = toInt16(signal[3 * k])
    if (Math.abs(out[k] - want) > 1) assert.fail(`第 ${k} 个样本错位：${out[k]} ≠ ${want}`)
  }
})

test('采集 worklet：44.1kHz 输入 1 秒产出 16000±1 个样本，渲染块变大时自动扩容', () => {
  const { proc, posted } = loadWorklet(44100)
  feed(proc, ramp(44100))
  const produced = posted.length * FRAME_SAMPLES + proc.frameLen
  assert.ok(Math.abs(produced - 16000) <= 1, `实际 ${produced}`)
  const big = loadWorklet(48000)
  feed(big.proc, ramp(48000), 4096)       // 超过预分配容量的大块
  assert.equal(big.posted.length, 10)
  assert.equal(big.proc.frameLen, 0)
})
