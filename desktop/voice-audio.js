/* 桌面语音音频层：麦克风推流采集 + TTS PCM 排队播放。
 * 改写来源：web-src/src/VoiceAudio.js（AudioWorklet 采集、16kHz 重采样、帧级 RMS）
 * 与 web-src/src/VoiceCall.jsx 的 playChunk/stopPlayback（PCM16 播放排队）。
 * 桌面端无打包器，按仓库 UMD 约定同时暴露 window.JWSVoiceAudio 与 module.exports。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSVoiceAudio = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  const TARGET_SAMPLE_RATE = 16000
  const FRAME_SAMPLES = 1600 // 100ms @16kHz，与 jarvis/voice/gateway.py 的上行格式对齐
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

  /** 渲染进程能不能走「麦克风推流 + 服务端识别」这条首选链路。 */
  function pcmStreamSupported(scope = globalThis) {
    const Ctx = scope.AudioContext || scope.webkitAudioContext
    const media = scope.navigator && scope.navigator.mediaDevices
    return Boolean(media && media.getUserMedia && Ctx && scope.AudioWorkletNode)
  }

  /** getUserMedia 抛出的错误名：麦克风本身的问题（权限/没设备），换识别方案也救不了。 */
  function isMicError(err) {
    return ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError',
      'OverconstrainedError'].includes(err && err.name)
  }

  /**
   * 开始采集。onFrame(ArrayBuffer) 每 100ms 一帧 PCM16/16kHz；onLevel(rms) 同步回调。
   * 返回 { stop() }。麦克风问题原样抛出（isMicError 可判），其余异常代表推流组件不可用。
   */
  async function startMicStream({ onFrame, onLevel }, scope = globalThis) {
    const Ctx = scope.AudioContext || scope.webkitAudioContext
    const stream = await scope.navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    let ctx
    try {
      ctx = new Ctx()
      if (ctx.state === 'suspended' && ctx.resume) await ctx.resume()
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const source = ctx.createMediaStreamSource(stream)
      const node = new scope.AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 0 })
      node.port.onmessage = e => {
        if (onLevel) onLevel(e.data.rms)
        if (onFrame) onFrame(e.data.pcm)
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
      try { if (ctx) ctx.close() } catch { /* 已关 */ }
      throw err
    }
  }

  /**
   * PCM16 小端单声道排队播放器（TTS 下行）。createContext 可注入，测试给 fake AudioContext。
   * enqueue 按块顺播；stop 全停清队；onIdle 在队列放空时回调（回合结束回到「听」态用）。
   */
  function createPcmPlayer({ createContext } = {}) {
    const state = { ctx: null, nextTime: 0, sources: new Set(), sampleRate: 24000, idle: null }
    function ensureCtx() {
      if (!state.ctx) {
        const make = createContext || (() => {
          const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext
          return Ctx ? new Ctx() : null
        })
        state.ctx = make()
      }
      if (state.ctx && state.ctx.state === 'suspended' && state.ctx.resume) state.ctx.resume()
      return state.ctx
    }
    return {
      start(sampleRate) { state.sampleRate = sampleRate || 24000 },
      enqueue(buf) {
        const ctx = ensureCtx()
        if (!ctx) return
        const usable = buf.byteLength - (buf.byteLength % 2)
        if (!usable) return
        const pcm = new Int16Array(buf, 0, usable / 2)
        const f32 = Float32Array.from(pcm, v => v / 32768)
        const buffer = ctx.createBuffer(1, f32.length, state.sampleRate)
        buffer.getChannelData(0).set(f32)
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.connect(ctx.destination)
        const at = Math.max(ctx.currentTime + 0.02, state.nextTime || 0)
        src.start(at)
        state.nextTime = at + buffer.duration
        state.sources.add(src)
        src.onended = () => {
          state.sources.delete(src)
          if (!state.sources.size) {
            state.nextTime = 0
            if (state.idle) state.idle()
          }
        }
      },
      stop() {
        for (const s of state.sources) { try { s.stop() } catch { /* 已停 */ } }
        state.sources.clear()
        state.nextTime = 0
      },
      playing() { return state.sources.size > 0 },
      onIdle(cb) { state.idle = cb },
      close() { try { if (state.ctx && state.ctx.close) state.ctx.close() } catch { /* 已关 */ } },
    }
  }

  return { TARGET_SAMPLE_RATE, FRAME_SAMPLES, pcmStreamSupported, isMicError, startMicStream, createPcmPlayer }
})
