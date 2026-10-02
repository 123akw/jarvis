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
   * 已有 MediaStream → PCM16/16kHz 帧流（麦克风与系统回环共用的采集管线）。
   * 返回 { stop() }；stop 会停掉 stream 里的全部 track。
   */
  async function startStreamCapture(stream, { onFrame, onLevel }, scope = globalThis) {
    const Ctx = scope.AudioContext || scope.webkitAudioContext
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
   * 麦克风采集。onFrame(ArrayBuffer) 每 100ms 一帧 PCM16/16kHz；onLevel(rms) 同步回调。
   * 返回 { stop() }。麦克风问题原样抛出（isMicError 可判），其余异常代表推流组件不可用。
   */
  async function startMicStream({ onFrame, onLevel }, scope = globalThis) {
    const stream = await scope.navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    return startStreamCapture(stream, { onFrame, onLevel }, scope)
  }

  /**
   * 系统回环音频采集（会议里「对方」的声音）。走 getDisplayMedia：主进程的
   * setDisplayMediaRequestHandler 会把音频源指到系统 loopback；视频轨只是门票，
   * 拿到即停。没有音频轨说明平台/权限拿不到系统声音，抛 NoSystemAudioError。
   */
  async function startSystemAudioStream({ onFrame, onLevel }, scope = globalThis) {
    const stream = await scope.navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    stream.getVideoTracks().forEach(t => t.stop())
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop())
      const err = new Error('system loopback audio is unavailable')
      err.name = 'NoSystemAudioError'
      throw err
    }
    return startStreamCapture(stream, { onFrame, onLevel }, scope)
  }

  /** PCM16 → Float32：普通循环（比 Float32Array.from 逐样本回调快数倍，少占渲染主线程）。 */
  function pcm16ToFloat32(pcm) {
    const out = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
    return out
  }

  const ENVELOPE_STEP = 0.05 // 播放音量包络的窗长（秒）：悬浮球「说话」态按它随音量起伏

  /** 一块 PCM 的音量包络：每 ENVELOPE_STEP 秒一个 RMS（隔点取样，够看又省） */
  function envelopeOf(f32, sampleRate, step = ENVELOPE_STEP) {
    const per = Math.max(1, Math.round(sampleRate * step))
    const out = new Float32Array(Math.ceil(f32.length / per))
    for (let w = 0; w < out.length; w++) {
      const end = Math.min(f32.length, (w + 1) * per)
      let sum = 0
      let n = 0
      for (let i = w * per; i < end; i += 2) { sum += f32[i] * f32[i]; n++ }
      out[w] = n ? Math.sqrt(sum / n) : 0
    }
    return out
  }

  /**
   * PCM16 小端单声道排队播放器（TTS 下行）。createContext 可注入，测试给 fake AudioContext。
   * enqueue 按块顺播；stop 全停清队；onIdle 在队列放空时回调（回合结束回到「听」态用）。
   * warm 在接通时预建并 resume 上下文：首句音频到达时输出设备已在运行，不算进首音频延迟。
   * level() 返回此刻正在播的那一小段的 RMS（入队时预算包络，不往音频图里插分析节点）。
   */
  function createPcmPlayer({ createContext } = {}) {
    // turnSec：本回合已排播的音频总时长（秒），打断时据此回报「实际播到哪」
    const state = { ctx: null, nextTime: 0, sources: new Set(), sampleRate: 24000, idle: null, env: [], turnSec: 0 }
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
      warm() { ensureCtx() },
      enqueue(buf) {
        const ctx = ensureCtx()
        if (!ctx) return
        const usable = buf.byteLength - (buf.byteLength % 2)
        if (!usable) return
        const f32 = pcm16ToFloat32(new Int16Array(buf, 0, usable / 2))
        const buffer = ctx.createBuffer(1, f32.length, state.sampleRate)
        buffer.getChannelData(0).set(f32)
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.connect(ctx.destination)
        const at = Math.max(ctx.currentTime + 0.02, state.nextTime || 0)
        src.start(at)
        state.nextTime = at + buffer.duration
        state.turnSec += buffer.duration
        // 包络按播放时间排队：先丢已播完的，再挂这一块（整句一次性下发也只是几百个小数组）
        while (state.env.length && state.env[0].end <= ctx.currentTime) state.env.shift()
        state.env.push({ at, end: at + buffer.duration, vals: envelopeOf(f32, state.sampleRate) })
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
        state.env = []
      },
      playing() { return state.sources.size > 0 },
      /** 本回合音频实际已播放的毫秒数：已排播总时长 − 还没播完的部分（须在 stop 之前取）。 */
      playedMs() {
        const ctx = state.ctx
        if (!ctx) return 0
        const left = state.sources.size ? Math.max(0, (state.nextTime || 0) - ctx.currentTime) : 0
        return Math.max(0, Math.round((state.turnSec - left) * 1000))
      },
      resetTurn() { state.turnSec = 0 },
      level() {
        const ctx = state.ctx
        if (!ctx) return 0
        const t = ctx.currentTime
        while (state.env.length && state.env[0].end <= t) state.env.shift()
        const seg = state.env[0]
        if (!seg || t < seg.at) return 0
        const idx = Math.min(seg.vals.length - 1, Math.floor((t - seg.at) / ENVELOPE_STEP))
        return seg.vals[idx] || 0
      },
      onIdle(cb) { state.idle = cb },
      close() { try { if (state.ctx && state.ctx.close) state.ctx.close() } catch { /* 已关 */ } },
    }
  }

  return { TARGET_SAMPLE_RATE, FRAME_SAMPLES, ENVELOPE_STEP, pcmStreamSupported, isMicError,
    startStreamCapture, startMicStream, startSystemAudioStream, createPcmPlayer, pcm16ToFloat32,
    envelopeOf, WORKLET_SOURCE }
})
