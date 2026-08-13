/**
 * 麦克风推流采集：AudioWorklet 采样 → 线性插值重采样 16kHz → PCM16 小端单声道，
 * 每 100ms（1600 样本）回调一帧 ArrayBuffer，并附带帧级 RMS（0~1）供本地 VAD。
 * 与后端 jarvis/voice/gateway.py 的二进制上行格式对齐：PCM16/16kHz/mono。
 */

export const TARGET_SAMPLE_RATE = 16000
export const FRAME_SAMPLES = 1600 // 100ms @16kHz

const WORKLET_NAME = 'jws-pcm-capture'

const WORKLET_SOURCE = `
class JwsPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(0)   // 源采样缓冲（原始采样率）
    this.pos = 0                     // 缓冲内的浮点读取位置
    this.frame = new Float32Array(${FRAME_SAMPLES})
    this.frameLen = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch || !ch.length) return true
    const merged = new Float32Array(this.buf.length + ch.length)
    merged.set(this.buf); merged.set(ch, this.buf.length)
    this.buf = merged
    const ratio = sampleRate / ${TARGET_SAMPLE_RATE}
    while (this.pos + 1 < this.buf.length) {
      const j = Math.floor(this.pos)
      const frac = this.pos - j
      this.frame[this.frameLen++] = this.buf[j] + (this.buf[j + 1] - this.buf[j]) * frac
      this.pos += ratio
      if (this.frameLen === ${FRAME_SAMPLES}) this.flush()
    }
    const keep = Math.floor(this.pos)
    if (keep > 0) { this.buf = this.buf.slice(keep); this.pos -= keep }
    return true
  }
  flush() {
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
