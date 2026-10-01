/**
 * 麦克风推流采集：AudioWorklet 采样 → 线性插值重采样 16kHz → PCM16 小端单声道，
 * 每 100ms（1600 样本）回调一帧 ArrayBuffer，并附带帧级 RMS（0~1）供本地 VAD。
 * 与后端 jarvis/voice/gateway.py 的二进制上行格式对齐：PCM16/16kHz/mono。
 */

export const TARGET_SAMPLE_RATE = 16000
export const FRAME_SAMPLES = 1600 // 100ms @16kHz

const WORKLET_NAME = 'jws-pcm-capture'

export const WORKLET_SOURCE = `
class JwsPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    // 源采样缓冲（原始采样率）预分配、原地复用：process() 每 128 样本就调一次（约 375 次/秒），
    // 唤醒词常驻时一直在跑，每次 new 数组会给音频线程制造持续的 GC 压力。
    this.src = new Float32Array(2048)
    this.srcLen = 0
    this.pos = 0                     // 缓冲内的浮点读取位置（可越过缓冲尾，指向下一块）
    this.frame = new Float32Array(${FRAME_SAMPLES})
    this.frameLen = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch || !ch.length) return true
    if (this.srcLen + ch.length > this.src.length) {  // 渲染块变大才一次性扩容，常态不触发
      const grown = new Float32Array((this.srcLen + ch.length) * 2)
      grown.set(this.src.subarray(0, this.srcLen))
      this.src = grown
    }
    const src = this.src
    src.set(ch, this.srcLen)
    this.srcLen += ch.length
    const ratio = sampleRate / ${TARGET_SAMPLE_RATE}
    while (this.pos + 1 < this.srcLen) {
      const j = Math.floor(this.pos)
      const frac = this.pos - j
      this.frame[this.frameLen++] = src[j] + (src[j + 1] - src[j]) * frac
      this.pos += ratio
      if (this.frameLen === ${FRAME_SAMPLES}) this.flush()
    }
    // 已消费的样本原地前移（不分配）。读取位置可能已越过本块末尾（48kHz 时每块都会），
    // 只能丢掉手里有的样本、保留越过的相位——旧实现在这里多丢一个相位，48kHz 下每秒多出 125 个样本。
    const keep = Math.min(Math.floor(this.pos), this.srcLen)
    if (keep > 0) {
      src.copyWithin(0, keep, this.srcLen)
      this.srcLen -= keep
      this.pos -= keep
    }
    return true
  }
  flush() {
    // 每 100ms 一帧要把所有权转移给主线程（postMessage transfer），这一块只能按帧新建
    const pcm = new Int16Array(${FRAME_SAMPLES})
    let sum = 0
    for (let i = 0; i < ${FRAME_SAMPLES}; i++) {
      const v = Math.max(-1, Math.min(1, this.frame[i]))
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      sum += v * v
    }
    this.frameLen = 0
    this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / ${FRAME_SAMPLES}) }, [pcm.buffer])
  }
}
registerProcessor('${WORKLET_NAME}', JwsPcmCapture)
`

/** 浏览器能不能走「麦克风推流 + 服务端识别」这条新路。 */
export function pcmStreamSupported() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  return !!(navigator.mediaDevices?.getUserMedia && Ctx && window.AudioWorkletNode)
}

/** getUserMedia 抛出的错误名：麦克风本身的问题（权限/没设备），换识别方案也救不了。 */
export function isMicError(err) {
  return ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError',
    'OverconstrainedError'].includes(err?.name)
}

/**
 * 开始采集。onFrame(ArrayBuffer) 每 100ms 一帧 PCM16/16kHz；onLevel(rms) 同步回调。
 * 返回 { stop() }。麦克风问题原样抛出（isMicError 可判），其余异常代表推流组件不可用。
 */
export async function startMicStream({ onFrame, onLevel }) {
  const Ctx = window.AudioContext || window.webkitAudioContext
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  })
  let ctx
  try {
    ctx = new Ctx()
    if (ctx.state === 'suspended') await ctx.resume?.()
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 0 })
    node.port.onmessage = e => {
      onLevel?.(e.data.rms)
      onFrame?.(e.data.pcm)
    }
    source.connect(node)
    return {
      stop() {
        try { node.port.onmessage = null } catch { /* 已停 */ }
        try { source.disconnect(); node.disconnect() } catch { /* 已断 */ }
        try { ctx.close() } catch { /* 已关 */ }
        stream.getTracks().forEach(t => t.stop())
      },
    }
  } catch (err) {
    stream.getTracks().forEach(t => t.stop())
    try { ctx?.close() } catch { /* 已关 */ }
    throw err
  }
}
