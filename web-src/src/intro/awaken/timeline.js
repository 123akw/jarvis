/* 「唤醒」分镜（秒，以首帧为 0）：纯函数，t → 着色器参数。文字节奏在 awaken.css，两边共用这张表。
 *
 *   0.00–0.60  边缘流光亮起；0.12–1.35 亮头从顶部正中顺时针绕视口一周（取自「光幕」）
 *   0.20–1.40  「你好，我是贾维斯。」逐字由模糊到锐利，「贾维斯」走 AI 渐变；远景粒子在景深里若隐若现
 *   1.20–1.60  整圈流光轻轻一涨
 *   1.42–1.92  流光按噪声一段段碎裂：每一段熄灭的同一刻，粒子在原处带着同样的颜色出生、一闪，
 *              沿漩涡弧线从四边涌向光球；远景粒子随后被唤醒跟上
 *   1.62–2.12  大字上移、虚化、淡出
 *   2.30       粒子凝聚处点亮 Presence 流体光球（与登录页同一着色器、同一花纹时钟），粒子一闪后被吸收；
 *              2.38 起光晕扩散（取自「唤醒」）
 *   2.60–3.30  登录页背景光淡入；光球能量、流速回落到待命值，花纹相位收敛到全局时钟
 *   3.30       onDone → IntroGate 淡出 420ms（与登录页光球逐像素重合），问候语和登录卡此时才入场 */
export const TL = {
  end: 3.3,
  reducedEnd: 0.9,       // 减弱动态：600ms 淡入 + 300ms 停留
  shatter: [1.42, 0.5],  // 碎裂起点、持续（GLSL detach() 的 uS0 / uSd）
  glowOff: 2.1,          // 流光全部熄灭，之后不再画
  ignite: 2.3,
  dustOff: 3.25,         // 粒子全部被吸收
  orbAt: 0.5,            // 这时才建光球的 WebGL 上下文（后台编译，2.3s 前早已就绪）
}

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x)
export const seg = (t, a, b) => clamp01((t - a) / (b - a))
const inOut = x => (x < 0.5 ? 4 * x * x * x : 1 - (2 - 2 * x) ** 3 / 2)
const out3 = x => 1 - (1 - x) ** 3

/** 流光：a 整体亮度（淡入 + 碎裂前一涨），p 亮头绕行进度，b 亮头额外亮度 */
export function glowParams(t) {
  const swell = Math.sin(Math.PI * seg(t, 1.2, 1.6))
  return { a: out3(seg(t, 0.08, 0.6)) * (1 + 0.28 * swell), p: inOut(seg(t, 0.12, 1.35)), b: 1 - seg(t, 1.3, 1.8) }
}

/** 光球：点亮时能量 / 光晕偏高、流动更快，1s 内回落到 Presence 待命值；
 *  相位 = 全局时钟 − 收敛中的滞后量，末帧与登录页光球（同一时钟）完全一致。clk 来自 presenceClock()。 */
export function orbParams(t, clk) {
  const settle = out3(seg(t, TL.ignite, TL.end))
  const grow = out3(seg(t, TL.ignite, TL.ignite + 0.6))
  const lag = (1 - settle) ** 2
  return {
    phase: clk.phase - 0.55 * lag,
    spin: clk.spin - 0.45 * lag,
    energy: 0.72 - 0.44 * settle,
    scale: (0.84 + 0.16 * grow) * clk.breath,
    halo: 0.9 - 0.4 * settle,
    sweep: 0,
  }
}
