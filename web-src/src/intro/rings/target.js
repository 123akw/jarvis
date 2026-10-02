/* 落点：进场最后一帧的光球要与登录页的 Presence 光球重合（中心与直径）。
 * 登录页就渲染在 IntroGate 下面，直接量它；量不到（还在拉 session、已登录进 HUD、MOSS 形态）时
 * 按 Login.jsx 的同一套尺寸公式估算——实测 1440×900 落在 (720, 250) 直径 210，390×844 落在 (195, 230) 直径 164。 */

export const LOGIN_ORB_SELECTOR = '.jvl-orb .jv-presence'
const FALLBACK_Y = 0.276   // 登录页光球中心 / 视口高（实测 0.272–0.278）

/** 与 Login.jsx 的 orbSizeFor 同一公式 */
export function estimateOrbSize(w, h) {
  return Math.round(Math.max(120, Math.min(210, w * 0.42, h * 0.24)))
}

export function estimateTarget(w, h) {
  return { x: w / 2, y: h * FALLBACK_Y, size: estimateOrbSize(w, h), measured: false }
}

/** 量登录页光球。入场动画（.jvl-orb 的 scale）不影响中心；直径取 offsetWidth（不受 transform 影响）。 */
export function measureTarget(doc = typeof document !== 'undefined' ? document : null,
  w = typeof window !== 'undefined' ? window.innerWidth : 1440,
  h = typeof window !== 'undefined' ? window.innerHeight : 900) {
  try {
    const el = doc?.querySelector(LOGIN_ORB_SELECTOR)
    if (el) {
      const r = el.getBoundingClientRect()
      const size = el.offsetWidth || r.width
      if (size > 0 && r.width > 0) {
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, size, measured: true }
      }
    }
  } catch { /* 量不到就估算 */ }
  return estimateTarget(w, h)
}
