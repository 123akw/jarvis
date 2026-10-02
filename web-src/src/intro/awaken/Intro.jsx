import { useEffect, useMemo, useRef, useState } from 'react'
import Presence, { presenceClock } from '../../Presence.jsx'
import { createPresenceRenderer } from '../../PresenceGL.js'
import { glowWidth, measureTarget, particleCount, sameGeo } from './layout.js'
import { createScene } from './scene.js'
import { glowParams, orbParams, seg, TL } from './timeline.js'
import './awaken.css'

/**
 * 进场动画「唤醒」（最终版）：「光幕」的边缘流光与大字 → 流光碎裂成粒子涌向中心 → 粒子凝聚成登录页光球。
 * 分镜见 ./timeline.js。契约见 ../registry.js。
 *
 * 渲染：流光 + 粒子共用一个 WebGL 上下文（./scene.js）；光球用登录页同一个 PresenceGL 着色器、同一个
 * 全局花纹时钟（presenceClock），IntroGate 淡出时与登录页光球逐像素重合；大字、光晕环、背景光是 CSS 合成动画。
 * 降级：无 WebGL（或软件渲染）→ CSS 版（内发光 + 光点螺旋汇聚 + Presence CSS 光球）；
 *       prefers-reduced-motion → 静态终帧 600ms 淡入。
 */

const TEXT = '你好，我是贾维斯。'
const NAME_FROM = 5   // 「贾维斯」三个字走 AI 渐变

function reducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** 只做廉价判断；真正能否建上下文（含软件渲染被拒）在 createScene 里见分晓，失败再降级 */
function webglLikely() {
  try {
    return typeof window.WebGLRenderingContext !== 'undefined' && !navigator.connection?.saveData
  } catch {
    return false
  }
}

/** CSS 降级的光点：随机方位、半径、延迟，螺旋收拢到球壳 */
function makeDots(n) {
  const cols = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#C4B5FD', '#93C5FD']
  const big = Math.max(window.innerWidth, window.innerHeight)
  return Array.from({ length: n }, (_, i) => ({
    a: Math.round((i / n) * 360 + Math.random() * 24),
    r: Math.round(big * (0.3 + Math.random() * 0.3)),
    d: (1.42 + Math.random() * 0.45).toFixed(2),
    s: (3 + Math.random() * 4).toFixed(1),
    c: cols[i % cols.length],
  }))
}

export default function Intro({ onDone, authed = false }) {
  const [mode, setMode] = useState(() => (reducedMotion() ? 'reduced' : webglLikely() ? 'gl' : 'css'))
  const [orbCss, setOrbCss] = useState(false)   // 场景能建、Presence 着色器却失败时，光球退回 CSS 版
  const [geo, setGeo] = useState(measureTarget)
  const rootRef = useRef(null)
  const bgRef = useRef(null)
  const sceneRef = useRef(null)
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

  // 时间线：GL 与 CSS 关键帧共用一个零点（挂上 is-run 的那一刻）
  useEffect(() => {
    const root = rootRef.current
    let stopped = false
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      doneRef.current?.()
    }
    const timers = []
    let raf = 0
    let scene = null
    let orb = null
    let onMove = null
    const caf = typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame.bind(window) : clearTimeout
    const rafFn = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : cb => setTimeout(() => cb(performance.now()), 16)
    const isLight = () => document.body.classList.contains('light')

    if (mode === 'reduced') {
      if (isLight() && bgRef.current) bgRef.current.style.opacity = '0'
      timers.push(setTimeout(finish, TL.reducedEnd * 1000))
      return () => timers.forEach(clearTimeout)
    }

    if (mode === 'gl') {
      scene = createScene(sceneRef.current, {
        count: particleCount(window.innerWidth, window.innerHeight, navigator.hardwareConcurrency),
        onLost: finish,
      })
      if (!scene) {
        setMode('css')
        return undefined
      }
    }

    const t0 = performance.now()
    root?.classList.add('is-run')
    timers.push(setTimeout(finish, TL.end * 1000))

    const cam = [0, 0]
    const aim = [0, 0]
    if (scene) {
      onMove = e => {
        aim[0] = (e.clientX / window.innerWidth - 0.5) * 40
        aim[1] = (e.clientY / window.innerHeight - 0.5) * 28
      }
      window.addEventListener('pointermove', onMove, { passive: true })
      // 光球上下文晚一点再建（后台编译），2.3s 点亮前早已就绪
      timers.push(setTimeout(() => {
        if (stopped) return
        orb = createPresenceRenderer(orbRef.current, { onLost: () => { orb = null; finish() } })
        if (!orb) setOrbCss(true)
      }, TL.orbAt * 1000))
    }

    let vw = 0
    let vh = 0
    let dpr = 1
    let osz = 0
    let last = t0
    const frame = () => {
      if (stopped) return
      raf = rafFn(frame)
      const now = performance.now()
      const t = Math.max(0, (now - t0) / 1000)
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
      last = now
      const light = isLight()
      // 亮色主题：黑场在收尾时退场，露出登录页的亮底
      if (bgRef.current) bgRef.current.style.opacity = light ? String(1 - seg(t, 2.7, 3.2)) : '1'
      if (!scene) return
      const g = geoRef.current
      if (window.innerWidth !== vw || window.innerHeight !== vh) {
        vw = window.innerWidth
        vh = window.innerHeight
        dpr = Math.min(window.devicePixelRatio || 1, vw * vh > 1.1e6 ? 1.5 : 2)
        scene.resize(vw, vh, dpr)
      }
      const kc = 1 - Math.exp(-dt / 0.35)
      cam[0] += (aim[0] - cam[0]) * kc
      cam[1] += (aim[1] - cam[1]) * kc
      if (t < TL.dustOff + 0.1) {
        const ok = scene.render({
          t, glow: t < TL.glowOff ? glowParams(t) : null, dust: t < TL.dustOff,
          orb: [g.cx, g.cy, g.size / 2], cam, gw: glowWidth(vw, vh), shatter: TL.shatter, ign: TL.ignite,
        })
        if (ok === false) { scene.destroy(); scene = null; finish(); return }
      }
      if (orb && t > TL.ignite - 0.1) {
        if (g.size !== osz) {
          osz = g.size
          orb.resize(Math.round(osz * 1.8), Math.min(window.devicePixelRatio || 1, osz > 200 ? 1.5 : 2))
        }
        orb.render({ ...orbParams(t, presenceClock()), light: light ? 1 : 0 })
      }
    }
    raf = rafFn(frame)

    return () => {
      stopped = true
      caf(raf)
      timers.forEach(clearTimeout)
      if (onMove) window.removeEventListener('pointermove', onMove)
      scene?.destroy()
      orb?.destroy()
      scene = null
      orb = null
    }
  }, [mode])

  const style = { '--cx': `${geo.cx}px`, '--cy': `${geo.cy}px`, '--sz': `${geo.size}px` }
  const gl = mode === 'gl'
  return (
    <div ref={rootRef} className={`jva is-${mode}`} style={style} data-mode={mode} aria-hidden="true">
      <i ref={bgRef} className="jva-bg" />
      {!authed && (
        <div className="jva-amb">
          {/* 直接复用登录页的背景光类名：淡出交接时两层背景完全一致 */}
          <div className="jvl-ambient"><i className="jvl-key-light" /><i className="jvl-grain" /></div>
        </div>
      )}
      {gl && !orbCss
        ? <canvas ref={orbRef} className="jva-orb" />
        : <div className="jva-orbcss"><Presence size={geo.size} quality="css" decorative /></div>}
      {mode !== 'reduced' && <i className="jva-ring" />}
      {gl && <canvas ref={sceneRef} className="jva-gl" />}
      {mode === 'css' && <i className="jva-fb" />}
      {mode === 'css' && (
        <div className="jva-dots">
          {dots.map((d, i) => (
            <i key={i} style={{ '--a': `${d.a}deg`, '--r': `${d.r}px`, '--d': `${d.d}s`, '--s': `${d.s}px`, '--c': d.c }}><b /></i>
          ))}
        </div>
      )}
      <div className="jva-line">
        {[...TEXT].map((ch, i) => (
          <span key={i} style={{ '--i': i, '--k': i - NAME_FROM }}
            className={`jva-ch${i >= NAME_FROM && i < NAME_FROM + 3 ? ' is-name' : ''}${'，。'.includes(ch) ? ' is-punc' : ''}`}>
            {ch}
          </span>
        ))}
      </div>
    </div>
  )
}
