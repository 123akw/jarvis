import { useEffect, useMemo, useRef, useState } from 'react'
import Presence from '../../Presence.jsx'
import { createPresenceRenderer } from '../../PresenceGL.js'
import { createParticles } from './particlesGL.js'
import './orb.css'

/**
 * 进场方案「orb · 唤醒」：散落在三维空间里的光粒子（景深 + 视差）醒来，沿漩涡弧线汇聚，
 * 凝聚成登录页上那颗光球；光球亮起时一道轻微光晕扩散，J.A.R.V.I.S. 字标逐字浮现，随后让位给登录卡。
 *
 * 分镜（秒，以首帧为 0；GL 与 CSS 关键帧共用同一个起点）：
 *   0.00–0.40  由近及远逐个醒来，镜头从后方缓慢推近，焦点在远处
 *   0.16–1.70  漩涡弧线汇聚到球壳，拉焦到焦平面，粒子由偏白微光变成光球同位置的色相
 *   1.42–1.90  光球点亮（Presence 同款着色器，0.84→1 放大、能量先高后回落），粒子一闪后被吸收
 *   1.50–2.60  光晕环扩散（只动 transform/opacity）
 *   1.72–2.67  字标逐字浮现（每字 0.72s、间隔 50ms，blur 8px→0、上浮 8px，expo-out）
 *   1.90–3.00  登录页同款背景光淡入，光球回到待命参数
 *   2.72–3.04  字标上浮淡出，把位置让给问候语（不与之交叉叠字）
 *   3.00       onDone()：IntroGate 淡出 420ms，露出问候语和登录卡（共约 3.42s）
 *
 * 降级：无 WebGL（或软件渲染）→ CSS 版（光点螺旋汇聚 + Presence CSS 光球）；
 *       prefers-reduced-motion → 只有 600ms 淡入。
 */
export const TL = { ignite: 1.42, dustOff: 2.7, end: 3.0, reducedFade: 0.6, reducedHold: 0.3 }
const WORD = ['J.', 'A.', 'R.', 'V.', 'I.', 'S.']

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, k) => a + (b - a) * k
const easeOut3 = k => 1 - (1 - k) ** 3

/** 登录页光球与问候语的几何，和 Login.jsx（orbSizeFor）/ Login.css（.jvl-main 布局）同一套公式。
 *  Playwright 实测：1440×900 光球中心 (720, 249.95) 直径 210；390×844 中心 (195, 229.81) 直径 164。 */
export function loginLayout(w, h) {
  const size = Math.round(Math.max(120, Math.min(210, w * 0.42, h * 0.24)))
  const v = 0.022 * h
  const margin = clamp(v, 4, 26)               // .jvl-orb 下边距
  const gap = clamp(v, 12, 22)                 // .jvl-main 行距
  const h1 = clamp(0.03 * w, 26, 36) * 1.2     // 问候语行高
  const content = size + margin + gap + (h1 + 25.5) + gap + 304   // 光球 + 问候/日期 + 登录卡
  const top = h < 640 ? 64 : 64 + (h - 96 - content) / 2
  return { cx: w / 2, cy: top + size / 2, size, wy: top + size + margin + gap + h1 / 2 }
}

/** 优先量登录页上真实的光球（.jvl-orb 入场是绕中心缩放：中心不受影响，直径取布局宽度），量不到用公式。 */
export function measureTarget() {
  const w = window.innerWidth
  const h = window.innerHeight
  const geo = loginLayout(w, h)
  try {
    const orb = document.querySelector('.jvl-orb .jv-presence')
    if (orb && orb.offsetWidth > 0) {
      const r = orb.getBoundingClientRect()
      geo.cx = r.left + r.width / 2
      geo.cy = r.top + r.height / 2
      geo.size = orb.offsetWidth
      const h1 = document.querySelector('.jvl-h1')
      const main = document.querySelector('.jvl-main')
      if (h1 && main && h1.offsetHeight > 0) {
        // 沿 offsetParent 累加到 .jvl-main：offsetTop 不含问候语入场动画的位移（transform 会让 .jvl-greet 成为 offsetParent）
        let y = 0
        let el = h1
        while (el && el !== main) { y += el.offsetTop; el = el.offsetParent }
        if (el === main) geo.wy = main.getBoundingClientRect().top - main.scrollTop + y + h1.offsetHeight / 2
      }
    }
  } catch { /* 量不到就用公式 */ }
  return geo
}

/** 粒子数：桌面按面积 4500–8000，手机 2400，低核数设备再打六折。 */
export function particleCount(w, h, cores = 8) {
  let n = Math.min(w, h) < 600 ? 2400 : Math.round(clamp(w * h * 0.0052, 4500, 8000))
  if (cores && cores <= 4) n = Math.round(n * 0.6)
  return n
}

function reducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** 只做廉价判断；真正能否建上下文（含软件渲染被拒）在 createParticles 里见分晓，失败再降级。 */
function webglLikely() {
  try {
    return typeof window.WebGLRenderingContext !== 'undefined' && !navigator.connection?.saveData
  } catch {
    return false
  }
}

const sameGeo = (a, b) => ['cx', 'cy', 'size', 'wy'].every(k => Math.abs(a[k] - b[k]) < 0.5)

/** CSS 降级的光点：随机方位、半径、延迟，螺旋收拢到球壳 */
function makeDots(n) {
  const cols = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#C4B5FD', '#93C5FD']
  const big = Math.max(window.innerWidth, window.innerHeight)
  return Array.from({ length: n }, (_, i) => ({
    a: Math.round((i / n) * 360 + Math.random() * 24),
    r: Math.round(big * (0.16 + Math.random() * 0.36)),
    d: (0.12 + Math.random() * 0.4).toFixed(2),
    s: (3 + Math.random() * 4).toFixed(1),
    c: cols[i % cols.length],
  }))
}

export default function Intro({ onDone, authed = false }) {
  const [mode, setMode] = useState(() => (reducedMotion() ? 'reduced' : webglLikely() ? 'gl' : 'css'))
  const [orbCss, setOrbCss] = useState(false)   // GL 粒子能建、Presence 着色器却失败时，光球退回 CSS 版
  const [geo, setGeo] = useState(measureTarget)
  const rootRef = useRef(null)
  const dustRef = useRef(null)
  const orbRef = useRef(null)
  const geoRef = useRef(geo)
  geoRef.current = geo
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const dots = useMemo(() => (mode === 'css' ? makeDots(window.innerWidth < 600 ? 28 : 48) : []), [mode])

  // 对准光球：窗口变化、登录页晚于进场挂载（会话检查未返回）时重新测量
  useEffect(() => {
    const re = () => setGeo(g => {
      const n = measureTarget()
      return sameGeo(g, n) ? g : n
    })
    const iv = setInterval(re, 300)
    window.addEventListener('resize', re)
    return () => { clearInterval(iv); window.removeEventListener('resize', re) }
  }, [])

  // 时间线：GL 着色器就绪后才起表，CSS 关键帧在同一刻挂上 is-run，两边共用一个零点
  useEffect(() => {
    const root = rootRef.current
    let stopped = false
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      root?.classList.add('is-leaving')
      doneRef.current?.()
    }
    const timers = []
    let raf = 0
    let dust = null
    let orb = null
    let onMove = null
    const caf = typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame.bind(window) : clearTimeout
    const rafFn = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : cb => setTimeout(() => cb(performance.now()), 16)

    if (mode === 'gl') {
      const w = window.innerWidth
      const h = window.innerHeight
      dust = createParticles(dustRef.current, {
        count: particleCount(w, h, navigator.hardwareConcurrency),
        onLost: finish,
      })
      if (!dust) {
        setMode('css')
        return undefined
      }
    }

    const t0 = performance.now()
    if (mode !== 'reduced') root?.classList.add('is-run')
    timers.push(setTimeout(finish, (mode === 'reduced' ? TL.reducedFade + TL.reducedHold : TL.end) * 1000))

    if (mode === 'gl') {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      let vw = 0
      let vh = 0
      let osz = 0
      let dustOn = true
      let last = t0
      let phase = Math.random() * 10
      let spin = Math.random() * 6.28
      const cam = [0, 0]
      const aim = [0, 0]
      onMove = e => {
        aim[0] = (e.clientX / window.innerWidth - 0.5) * 40
        aim[1] = (e.clientY / window.innerHeight - 0.5) * 28
      }
      window.addEventListener('pointermove', onMove, { passive: true })

      // 光球着色器晚一点再编译：把首帧前的同步编译拆成两段，避免一个长任务
      timers.push(setTimeout(() => {
        if (stopped) return
        orb = createPresenceRenderer(orbRef.current, { onLost: () => { orb = null; finish() } })
        if (!orb) setOrbCss(true)
      }, 450))

      const frame = () => {
        if (stopped) return
        raf = rafFn(frame)
        const now = performance.now()
        const t = Math.max(0, (now - t0) / 1000)
        const dt = clamp((now - last) / 1000, 0, 0.1)
        last = now
        const g = geoRef.current
        const light = document.body.classList.contains('light') ? 1 : 0
        if (window.innerWidth !== vw || window.innerHeight !== vh) {
          vw = window.innerWidth
          vh = window.innerHeight
          dust?.resize(vw, vh, dpr)
        }
        const kc = 1 - Math.exp(-dt / 0.35)
        cam[0] += (aim[0] - cam[0]) * kc
        cam[1] += (aim[1] - cam[1]) * kc
        if (dust && dustOn) {
          const vis = t < TL.dustOff
          if (!dust.render({ t, ign: TL.ignite, orb: [g.cx, g.cy, g.size / 2], cam, light }, vis)) dustOn = false
          if (!vis) dustOn = false
        }
        if (orb && t > TL.ignite - 0.1) {
          if (g.size !== osz) {
            osz = g.size
            orb.resize(Math.round(osz * 1.8), Math.min(window.devicePixelRatio || 1, osz > 200 ? 1.5 : 2))
          }
          // 点亮：能量/流速/光晕先高后回落到 Presence 待命值（energy .28 / speed .28 / halo .5）
          const settle = easeOut3(clamp((t - TL.ignite) / 1.4, 0, 1))
          const grow = easeOut3(clamp((t - TL.ignite) / 0.7, 0, 1))
          phase += lerp(1.5, 0.28, settle) * dt
          spin += lerp(0.9, 0.05, settle) * dt * 1.6
          orb.render({
            phase, spin, energy: lerp(0.72, 0.28, settle), scale: lerp(0.84, 1, grow),
            halo: lerp(0.9, 0.5, settle), sweep: 0, light,
          })
        }
      }
      raf = rafFn(frame)
    }

    return () => {
      stopped = true
      caf(raf)
      timers.forEach(clearTimeout)
      if (onMove) window.removeEventListener('pointermove', onMove)
      dust?.destroy()
      orb?.destroy()
      dust = null
      orb = null
    }
  }, [mode])

  const style = {
    '--cx': `${geo.cx}px`, '--cy': `${geo.cy}px`, '--sz': `${geo.size}px`, '--wy': `${geo.wy}px`,
  }
  const gl = mode === 'gl'
  return (
    <div ref={rootRef} className={`jvo is-${mode}`} style={style} data-mode={mode} aria-hidden="true">
      {!authed && (
        <div className="jvo-amb">
          {/* 直接复用登录页的背景光类名：淡出交接时两层背景完全一致 */}
          <div className="jvl-ambient"><i className="jvl-key-light" /><i className="jvl-grain" /></div>
        </div>
      )}
      {gl && !orbCss
        ? <canvas ref={orbRef} className="jvo-orb" />
        : <div className="jvo-orbcss"><Presence size={geo.size} quality="css" decorative /></div>}
      {mode !== 'reduced' && <i className="jvo-ring" />}
      {gl && <canvas ref={dustRef} className="jvo-dust" />}
      {mode === 'css' && (
        <div className="jvo-dots">
          {dots.map((d, i) => (
            <i key={i} style={{ '--a': `${d.a}deg`, '--r': `${d.r}px`, '--d': `${d.d}s`, '--s': `${d.s}px`, '--c': d.c }}><b /></i>
          ))}
        </div>
      )}
      <div className="jvo-word">
        {WORD.map((ch, i) => <span key={ch} style={{ '--i': i }}>{ch}</span>)}
      </div>
    </div>
  )
}
