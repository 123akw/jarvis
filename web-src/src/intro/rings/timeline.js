/* 「核心启动」时间轴：3D 版与 CSS 简化版共用同一套节拍（单位：秒）。全部是纯函数，便于测试。
 *
 * 分镜（场景时间 s，3D 版从首帧起算；整段进场 = 预备画面 ≤0.7s + 场景 2.75s ≤ 3.45s）：
 *   0.00–0.50  深空：远处一点白热能量核，微尘缓慢掠过，镜头开始缓推
 *   0.06–1.68  三道玻璃环依次从 Y / X / 斜轴旋入，带一点弹簧余量减速对齐到同一平面
 *   1.38–1.85  对齐的瞬间核心点火：白热 → AI 四色流体光球，一圈光脉冲向外扩散
 *   1.74–2.48  圆环沿各自平面向外扩散并消散；镜头平移，把光球送到登录页光球的位置
 *   2.50–2.75  定格：只剩光球与登录页同款背景光，交给 IntroGate 淡出 */

export const READY_DEADLINE_MS = 700  // three 就绪（首帧画出）的最后期限，超时走 CSS 版
export const SCENE_S = 2.75           // 3D 版时长
export const CSS_S = 2.75             // CSS 版时长（最晚 700ms 起播，3.45s 结束）
export const REDUCED_MS = 600         // 减弱动态：只做一次淡入
export const MAX_TOTAL_MS = 3500

export const clamp01 = v => (v <= 0 ? 0 : v >= 1 ? 1 : v)
export const lerp = (a, b, t) => a + (b - a) * t
/** s 在 [a, b] 区间里的进度 0..1 */
export const seg = (s, a, b) => clamp01((s - a) / (b - a))

export const easeOutCubic = t => 1 - (1 - t) ** 3
export const easeInCubic = t => t * t * t
export const easeInQuad = t => t * t
export const easeOutQuart = t => 1 - (1 - t) ** 4
export const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
/** 轻欠阻尼弹簧（阻尼比≈0.72，过冲≈4%，在 t≈0.8 处）：从静止起步、长尾减速，最后「咔嗒」一下到位；
 *  t=1 时残差 ≈1.5%，直接收到 1 */
export const springSettle = t => {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return 1 - Math.exp(-4.2 * t) * (Math.cos(4 * t) + (4.2 / 4) * Math.sin(4 * t)) * (1 - t ** 8)
}

export const BEATS = {
  // 三道环的入场：起始时刻、时长、旋入轴、起始偏转角（弧度）、起始缩放（从镜头外飞入）
  rings: [
    { start: 0.06, dur: 1.34, axis: [0, 1, 0], angle: 2.3, scale: 2.3 },
    { start: 0.20, dur: 1.34, axis: [1, 0, 0], angle: -2.6, scale: 2.7 },
    { start: 0.34, dur: 1.34, axis: [0.7071, 0, 0.7071], angle: 2.9, scale: 3.1 },
  ],
  ignite: [1.38, 1.85],
  flashPeak: 1.52,
  pulse: [1.42, 2.3],
  ringsOut: [1.74, 2.48],
  dolly: [0, 2.52],
  pan: [1.4, 2.52],
  bloomOut: [2.0, 2.55],
  dustIn: [0, 0.5],
  dustOut: [1.8, 2.45],
  ambientIn: [1.95, 2.7],
}

/** 每个时刻的全部动画量。3D 场景每帧取一次；CSS 版用同一组 BEATS 写关键帧。 */
export function sceneState(s) {
  const B = BEATS
  const rings = B.rings.map(r => {
    const t = seg(s, r.start, r.start + r.dur)
    const align = springSettle(t)                       // 旋转对齐（带一点过冲）
    const fly = easeOutQuart(t)                         // 缩放：从镜头外收拢，不过冲
    const appear = easeOutCubic(seg(s, r.start, r.start + 0.42))
    const out = seg(s, B.ringsOut[0], B.ringsOut[1])
    return {
      angle: r.angle * (1 - align),
      scale: lerp(r.scale, 1, fly) * (1 + 1.25 * easeInCubic(out)),
      appear: appear * (1 - easeInQuad(out)),
      out,
    }
  })

  const ig = seg(s, B.ignite[0], B.ignite[1])
  const ignite = easeOutCubic(ig)
  const rise = seg(s, B.ignite[0], B.flashPeak)
  // 点火闪光：快速升到峰值，再按 0.2s 时间常数指数衰减
  const flash = s < B.flashPeak ? easeOutCubic(rise) : Math.exp(-(s - B.flashPeak) / 0.2)
  const energy = 0.05 + 0.95 * easeOutCubic(seg(s, B.ignite[0], 1.6)) - 0.72 * easeInOutCubic(seg(s, 1.62, 2.45))
  const halo = lerp(0.35, 1.0, easeOutCubic(seg(s, B.ignite[0], 1.62))) - 0.5 * easeInOutCubic(seg(s, 1.7, 2.45))
  const speed = 0.28 + 1.3 * flash

  const dolly = easeInOutCubic(seg(s, B.dolly[0], B.dolly[1]))
  const pan = easeInOutCubic(seg(s, B.pan[0], B.pan[1]))
  const pulseT = seg(s, B.pulse[0], B.pulse[1])
  const pulse = {
    radius: lerp(1.05, 7.5, easeOutCubic(pulseT)),
    alpha: s < B.pulse[0] ? 0 : (1 - pulseT) ** 2 * 0.45,
  }
  const bloom = (0.35 + 1.25 * flash) * (1 - easeInOutCubic(seg(s, B.bloomOut[0], B.bloomOut[1])))
  const dust = easeOutCubic(seg(s, B.dustIn[0], B.dustIn[1])) * (1 - seg(s, B.dustOut[0], B.dustOut[1]))
  const ambient = easeInOutCubic(seg(s, B.ambientIn[0], B.ambientIn[1]))

  return {
    rings, ignite, flash, energy, halo, speed,
    coreScale: lerp(0.3, 1, ignite),
    dolly, pan, orbit: 1 - dolly, pulse, bloom, dust, ambient,
    envTurn: lerp(0.9, -0.35, easeOutCubic(seg(s, 0, 2.5))),
  }
}

/**
 * 镜头距离：让半径为 1 的核心球在画面上正好是 sizePx 直径（透视下球的轮廓半角 = asin(r/d)）。
 * fovDeg 是竖直视场角，viewH 是画布 CSS 高度。
 */
export function distanceForSize(sizePx, viewH, fovDeg) {
  const k = (sizePx / viewH) * Math.tan((fovDeg * Math.PI) / 360)
  return 1 / Math.sin(Math.atan(Math.max(1e-4, k)))
}

/** 环组缩放：对齐时最外环（半径 outerR）在屏幕上约占短边的 40%，限制在 [0.9, 1.5] */
export function ringFit(viewW, viewH, distAtAlign, fovDeg, outerR) {
  const want = 0.4 * Math.min(viewW, viewH)
  const pxPerUnit = viewH / 2 / (distAtAlign * Math.tan((fovDeg * Math.PI) / 360))
  return Math.min(1.5, Math.max(0.9, want / (outerR * pxPerUnit)))
}
