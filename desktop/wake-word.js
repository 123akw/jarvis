/* 语音唤醒（「贾维斯」）：本地 VAD 圈出短语音段 → 服务端一次性识别 → 命中回调。
 * 纯逻辑状态机，采集与识别全部注入，node --test 可直跑。识别只在检测到人声段落
 * 结束时发生一次（静音零请求零费用）；带前置缓冲避免吃掉「贾」字，带冷却防连环误触。
 * 自适应噪声底（最小统计法）：有声门限 = max(固定门限, 近 4 秒帧能量最小值 × 2.5)。
 * 安静环境（底噪 ≤ 门限/2.5）判定与固定门限逐帧一致，唤醒率不变；风扇/电视/音乐这类
 * 持续噪声把底噪抬上去后门限随之升高，不再每隔几秒把噪声段传上云识别。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSWakeWord = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  const SAMPLE_RATE = 16000

  /** PCM16 帧列表 → WAV 文件字节（16k/16bit/单声道），服务端 qwen3-asr-flash 直接可认。 */
  function encodeWav(frames, sampleRate = SAMPLE_RATE) {
    let dataLen = 0
    for (const f of frames) dataLen += f.byteLength
    const buf = new ArrayBuffer(44 + dataLen)
    const view = new DataView(buf)
    const writeStr = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); writeStr(8, 'WAVE')
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    writeStr(36, 'data'); view.setUint32(40, dataLen, true)
    const bytes = new Uint8Array(buf)
    let cursor = 44
    for (const f of frames) { bytes.set(new Uint8Array(f), cursor); cursor += f.byteLength }
    return buf
  }

  /** ArrayBuffer → base64（浏览器 btoa 与 Node Buffer 双兼容，分块避免栈溢出）。 */
  function bufferToBase64(buf) {
    if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(new Uint8Array(buf)).toString('base64')
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }

  /**
   * 唤醒监听器。feed({pcm, rms}) 喂 100ms 帧；说完一段送 recognize(wavArrayBuffer)，
   * 返回 {matched} 为真则 onWake(text)。返回 { feed, reset, state }。
   */
  function createWakeWordListener({
    recognize,                 // async (wav) => ({ matched, text, ok? })
    onWake = () => {},
    onError = () => {},
    threshold = 0.04,          // 与语音通话 VAD 同阈值
    startFrames = 2,           // 连续 2 帧人声（约 200ms）进入采集
    endSilenceFrames = 6,      // 约 600ms 静音判定说完
    maxFrames = 30,            // 最长 3 秒，超长强制截断送检
    minVoicedFrames = 3,       // 有效人声不足约 300ms 当噪声丢弃
    preRollFrames = 3,         // 触发前保留的帧，避免吃掉「贾」字
    cooldownMs = 4000,         // 送检后的冷却窗口
    noiseWindowFrames = 40,    // 噪声底统计窗：最近约 4 秒（人声的字间停顿会落回底噪，最小值就是底噪）
    noiseRatio = 2.5,          // 门限至少高出底噪约 8dB；设 0 关闭自适应（回到纯固定门限）
    noiseMinFrames = 5,        // 统计不足约 0.5 秒先用固定门限：刚开麦就说的第一句不受影响
    now = Date.now,
  }) {
    const st = {
      phase: 'idle',           // idle|capturing|checking
      preRoll: [], frames: [], voiceRun: 0, silenceRun: 0, voicedCount: 0,
      cooldownUntil: 0, checks: 0, wakes: 0, noiseFloor: 0, gate: threshold,
    }
    const hist = new Float32Array(Math.max(1, noiseWindowFrames))  // 预分配环形窗，常驻零分配
    let histLen = 0
    let histPos = 0

    /** 每帧都记（含送检/冷却期，噪声底不因冷却而失真），返回本帧有声门限。 */
    function updateGate(rms) {
      hist[histPos] = rms
      histPos = (histPos + 1) % hist.length
      if (histLen < hist.length) histLen += 1
      if (!(noiseRatio > 0) || histLen < noiseMinFrames) {
        st.gate = threshold
        return st.gate
      }
      let floor = hist[0]
      for (let i = 1; i < histLen; i++) if (hist[i] < floor) floor = hist[i]
      st.noiseFloor = floor
      st.gate = Math.max(threshold, floor * noiseRatio)
      return st.gate
    }

    function reset() {
      st.phase = 'idle'
      st.frames = []
      st.voiceRun = 0
      st.silenceRun = 0
      st.voicedCount = 0
    }

    async function submit() {
      const frames = st.frames
      reset()
      st.phase = 'checking'
      st.checks += 1
      st.cooldownUntil = now() + cooldownMs
      let result = null
      try {
        result = await recognize(encodeWav(frames))
      } catch (err) {
        onError(err)
      }
      st.cooldownUntil = now() + cooldownMs   // 冷却从识别返回时再算，防排队连发
      st.phase = 'idle'
      if (result && result.matched) {
        st.wakes += 1
        onWake(result.text || '')
      }
    }

    function feed(frame) {
      if (!frame || !frame.pcm) return
      const rms = frame.rms || 0
      const gate = updateGate(rms)
      if (st.phase === 'checking' || now() < st.cooldownUntil) return
      const voiced = rms >= gate
      if (st.phase === 'idle') {
        st.preRoll.push(frame.pcm)
        if (st.preRoll.length > preRollFrames) st.preRoll.shift()
        st.voiceRun = voiced ? st.voiceRun + 1 : 0
        if (st.voiceRun >= startFrames) {
          st.phase = 'capturing'
          st.frames = st.preRoll.slice()
          st.preRoll = []
          st.voicedCount = st.voiceRun
          st.silenceRun = 0
        }
        return
      }
      // capturing
      st.frames.push(frame.pcm)
      if (voiced) { st.voicedCount += 1; st.silenceRun = 0 } else { st.silenceRun += 1 }
      if (st.silenceRun >= endSilenceFrames || st.frames.length >= maxFrames) {
        if (st.voicedCount >= minVoicedFrames) void submit()
        else reset()
      }
    }

    return { feed, reset, state: () => ({ ...st, frames: st.frames.length, preRoll: st.preRoll.length }) }
  }

  return { createWakeWordListener, encodeWav, bufferToBase64, SAMPLE_RATE }
})
