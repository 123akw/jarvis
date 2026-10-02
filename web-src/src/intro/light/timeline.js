/* 「光幕」时间轴：纯函数，t（秒）+ 版面 → 着色器参数。文字的节奏在 light.css，两边共用下面这张分镜。
 *
 *   0.00  全黑                         0.08–0.60  边缘流光亮起
 *   0.15–1.55  流光从顶部正中顺时针绕视口一周（亮头 + 拖尾，绕完亮头熔进整圈）
 *   0.38–1.86  大字逐字由模糊、散开、偏低 → 锐利、收紧、归位（light.css）
 *   1.45–1.95  整圈流光轻轻一涨（「呼吸」）；1.86–2.15 静止停留
 *   2.15–2.95  流光框收拢：变圆、变小、中心移向登录页光球，越收越亮；大字上移、虚化、淡出
 *   2.93  汇成光点，白闪          2.90–3.34  光点膨胀成光球（约 5% 回弹）；2.80 起暗场渐变成登录页背景
 *   3.40  onDone → IntroGate 淡出 420ms，与真实光球交叉溶解 */

export const DONE_MS = 3400
export const REDUCED_MS = 1400

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x)
export const seg = (t, a, b) => clamp01((t - a) / (b - a))
const inOut = x => (x < 0.5 ? 4 * x * x * x : 1 - (2 - 2 * x) ** 3 / 2)
const out3 = x => 1 - (1 - x) ** 3
const outBack = x => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2   // 约 5% 回弹
const smooth = (a, b, x) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k) }
/** CSS cubic-bezier 的 JS 版（二分求解，每帧只调用一两次） */
export function bezier(x1, y1, x2, y2) {
  const f = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return x => {
    if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1
    let lo = 0, hi = 1, t = x
    for (let i = 0; i < 22; i++) { t = (lo + hi) / 2; if (f(x1, x2, t) < x) lo = t; else hi = t }
    return f(y1, y2, t)
  }
}
// 收拢用 apple.com 位移动画常见的 (.66,0,.1,1)：起步克制、中段加速、长尾轻落
const gather = bezier(0.66, 0, 0.1, 1)

/** 流光宽度：取短边的 5.5%，手机不窄于 22px，大屏不宽于 60px */
export const glowWidth = (w, h) => Math.max(22, Math.min(60, Math.min(w, h) * 0.055))

/** L = { w, h, tx, ty, r }：视口宽高、登录页光球中心与半径（CSS px，y 向下）；r=0 表示没找到光球（已登录 / MOSS 形态）。 */
export function sample(t, L) {
  const { w, h, tx, ty, r } = L
  const w0 = glowWidth(w, h)
  const q = gather(seg(t, 2.15, 2.95))
  const hx = (w / 2) * (1 - q)
  const hy = (h / 2) * (1 - q)
  const swell = Math.sin(Math.PI * seg(t, 1.45, 1.95))
  return {
    a: out3(seg(t, 0.08, 0.6)) * (1 + 0.28 * swell + 1.5 * q) * (1 - seg(t, 2.95, 3.25)),
    q,
    p: inOut(seg(t, 0.15, 1.55)),
    b: 1 - seg(t, 1.45, 2.0),
    cx: w / 2 + (tx - w / 2) * q,
    cy: h / 2 + (ty - h / 2) * q,
    hx,
    hy,
    rad: Math.min(hx, hy) * smooth(0, 0.6, q),
    wd: w0 * (1 - 0.5 * q) * (r ? 1 : 1 + 6 * out3(seg(t, 2.92, 3.4))),
    f: 1.3 * Math.exp(-(((t - 2.93) / 0.08) ** 2)),
    o: Math.max(0, r * outBack(seg(t, 2.9, 3.34))),
  }
}
