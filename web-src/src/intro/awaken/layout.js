/* 版面：进场末帧要落在登录页光球上（位置、直径），粒子数按屏幕大小定。 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 登录页光球的几何，和 Login.jsx（orbSizeFor）/ Login.css（.jvl-main 布局）同一套公式，量不到真实 DOM 时用。
 *  Playwright 实测：1440×900 光球中心 (720, 249.95) 直径 210；390×844 中心 (195, 229.81) 直径 164。 */
export function loginLayout(w, h) {
  const size = Math.round(Math.max(120, Math.min(210, w * 0.42, h * 0.24)))
  const v = 0.022 * h
  const margin = clamp(v, 4, 26)               // .jvl-orb 下边距
  const gap = clamp(v, 12, 22)                 // .jvl-main 行距
  const h1 = clamp(0.03 * w, 26, 36) * 1.2     // 问候语行高
  const content = size + margin + gap + (h1 + 25.5) + gap + 304   // 光球 + 问候/日期 + 登录卡
  const top = h < 640 ? 64 : 64 + (h - 96 - content) / 2
  return { cx: w / 2, cy: top + size / 2, size }
}

/** 优先量登录页上真实的光球：.jvl-orb 入场是绕中心缩放，中心不受影响，直径取未变换的布局宽度。 */
export function measureTarget() {
  const geo = loginLayout(window.innerWidth, window.innerHeight)
  try {
    const orb = document.querySelector('.jvl-orb .jv-presence')
    if (orb && orb.offsetWidth > 0) {
      const r = orb.getBoundingClientRect()
      geo.cx = r.left + r.width / 2
      geo.cy = r.top + r.height / 2
      geo.size = orb.offsetWidth
    }
  } catch { /* 量不到就用公式 */ }
  return geo
}

export const sameGeo = (a, b) => ['cx', 'cy', 'size'].every(k => Math.abs(a[k] - b[k]) < 0.5)

/** 粒子数：桌面按面积 4500–8000，手机 2400，低核数设备再打六折 */
export function particleCount(w, h, cores = 8) {
  let n = Math.min(w, h) < 600 ? 2400 : Math.round(clamp(w * h * 0.0052, 4500, 8000))
  if (cores && cores <= 4) n = Math.round(n * 0.6)
  return n
}

/** 流光宽度：短边的 5.5%，手机不窄于 22px，大屏不宽于 60px */
export const glowWidth = (w, h) => Math.max(22, Math.min(60, Math.min(w, h) * 0.055))
