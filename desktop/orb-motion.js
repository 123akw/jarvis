/* 光球「说话」态的音量律动：只在 speaking 时跑一个 rAF，按 TTS 播放包络逐帧写
 * .o-body 的缩放与 .o-halo 的透明度/缩放（只动 transform/opacity，走合成线程）。
 * 其余状态（含空闲）零 JS：律动/流转全是 CSS 关键帧。系统「减少动态效果」时不启动。
 * 状态机仍在 voice-ball.js（body 类）与 voice-call.js（phase），这里只是视觉驱动。
 * UMD：页面里暴露 window.JWSOrbMotion；node --test 直接 require。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSOrbMotion = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  const clamp01 = v => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

  /** 播放 RMS（TTS 人声常见 0.02~0.3）→ 视觉音量 0~1：减底噪、归一、开方压缩让轻声也看得见 */
  function rmsToLevel(rms, floor = 0.015, full = 0.24) {
    return Math.sqrt(clamp01((rms - floor) / (full - floor)))
  }

  /** 音量包络：起音快（一出声球就胀）、释放慢（句间不抖） */
  function smoothLevel(prev, next, dt, attack = 0.05, release = 0.22) {
    const tau = next > prev ? attack : release
    return prev + (next - prev) * (1 - Math.exp(-Math.max(0, Number.isFinite(dt) ? dt : 0) / tau))
  }

  /** 视觉音量 → 本帧要写的参数（与网页端 Presence 的 speaking 曲线同量级） */
  function speakingFrame(level) {
    const l = clamp01(level)
    return { scale: 1 + 0.14 * l, haloOpacity: Math.min(1, 0.62 + 0.38 * l), haloScale: 0.94 + 0.14 * l }
  }

  /**
   * targets(): [{ body, halo }]，各自是带 style 的元素（可缺省）。
   * getRms(): 当前播放 RMS；raf/caf 可注入（测试），reducedMotion(): 是否减少动态效果。
   */
  function createOrbMotion({ targets, getRms, raf, caf, reducedMotion = () => false }) {
    const request = raf || (cb => globalThis.requestAnimationFrame(cb))
    const cancel = caf || (id => globalThis.cancelAnimationFrame(id))
    let phase = ''
    let handle = 0
    let level = 0
    let last = 0

    function write(frame) {
      for (const t of targets() || []) {
        if (!t) continue
        if (t.body) t.body.style.transform = frame ? `scale(${frame.scale.toFixed(4)})` : ''
        if (t.halo) {
          t.halo.style.opacity = frame ? frame.haloOpacity.toFixed(3) : ''
          t.halo.style.transform = frame ? `scale(${frame.haloScale.toFixed(4)})` : ''
        }
      }
    }

    function tick(now) {
      handle = 0
      if (phase !== 'speaking') return
      const dt = last ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 1 / 60
      last = now
      let rms = 0
      try { rms = Number(getRms()) || 0 } catch { rms = 0 }
      level = smoothLevel(level, rmsToLevel(rms), dt)
      write(speakingFrame(level))
      handle = request(tick)
    }

    function stop() {
      if (handle) { cancel(handle); handle = 0 }
      level = 0
      last = 0
      write(null)
    }

    /** 跟随语音状态机：只有 speaking 且未要求减少动态效果时才跑帧 */
    function setPhase(next) {
      phase = String(next || '')
      let reduced = false
      try { reduced = Boolean(reducedMotion()) } catch { reduced = false }
      if (phase === 'speaking' && !reduced) {
        if (!handle) handle = request(tick)
      } else {
        stop()
      }
    }

    return { setPhase, stop, running: () => Boolean(handle), level: () => level }
  }

  return { clamp01, rmsToLevel, smoothLevel, speakingFrame, createOrbMotion }
})
