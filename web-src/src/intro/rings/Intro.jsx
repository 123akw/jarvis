import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { readLoginForm } from '../../Login.jsx'
import Presence, { prefersReducedMotion } from '../../Presence.jsx'
import { currentTheme } from '../../theme.js'
import { measureTarget } from './target.js'
import {
  CSS_S, MAX_TOTAL_MS, READY_DEADLINE_MS, REDUCED_MS, SCENE_S, distanceForSize, lerp, ringFit, sceneState,
} from './timeline.js'
import './rings.css'

/**
 * 进场动画方案「rings」：核心启动。契约见 ../registry.js。
 *
 * 编排（时间从本组件挂载起算）：
 *   0ms        立刻出纯 CSS 预备画面（暗场 + 中心一点白热微光），同时 import 3D 场景（three 大包）
 *   ≤700ms     3D 场景画出第一帧 → 交叉淡入 3D 版，从首帧起播 2.75s
 *   >700ms     还没就绪（冷缓存 / 慢网）或无 WebGL2 / 加载失败 → 播 CSS 简化版（同一套节拍，WAAPI 驱动）
 *   减弱动态    只把最后一帧（登录页同款光球 + 背景光）用 600ms 淡入
 * onDone 由这里的计时器保证调用（不依赖 GL 帧循环），最晚 0.7 + 2.75 = 3.45s。
 */

const loadSceneDefault = () => import('./RingsScene.jsx')

/** WebGL2 + 非软件渲染才走 3D（three r182 需要 WebGL2）；省流量模式不拉 three */
export function support3D() {
  try {
    if (typeof window === 'undefined' || typeof window.WebGL2RenderingContext === 'undefined') return false
    if (navigator.connection?.saveData) return false
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
    const ok = !!gl
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return ok
  } catch {
    return false
  }
}

function isMobileViewport() {
  try {
    return Math.min(window.innerWidth, window.innerHeight) < 600 || window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

/** 收尾画面是否亮色：登录页光球形态跟随用户主题（MOSS 形态固定暗色）；登录页可能还没挂上，所以直接读偏好 */
function isLightEnding() {
  try {
    if (document.body.classList.contains('light')) return true
    return currentTheme() === 'light' && readLoginForm() !== 'moss'
  } catch {
    return false
  }
}

function mark(name) {
  try { performance.mark(`intro-rings:${name}`) } catch { /* 无 performance.mark 的环境忽略 */ }
}

export default function Intro({
  onDone, authed = false, loadScene = loadSceneDefault, canUse3D = support3D, reducedMotion,
}) {
  const reduced = reducedMotion ?? prefersReducedMotion()
  const [mode, setMode] = useState(reduced ? 'reduced' : 'preroll')   // preroll | 3d | css | reduced
  const [Scene, setScene] = useState(null)
  const [target, setTarget] = useState(() => measureTarget())
  const targetRef = useRef(target)
  const decided = useRef(reduced ? 'reduced' : null)
  const mountAt = useRef(0)
  const timers = useRef([])
  const finished = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const [mobile] = useState(isMobileViewport)
  const [light] = useState(isLightEnding)
  const [cssMs, setCssMs] = useState(CSS_S * 1000)

  const later = useCallback((fn, ms) => { timers.current.push(setTimeout(fn, ms)) }, [])
  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    mark('done')
    onDoneRef.current?.()
  }, [])

  const startCss = useCallback(() => {
    if (decided.current) return
    decided.current = 'css'
    mark('css')
    // 主线程被卡（慢机解析大包）导致计时器晚到时，压缩 CSS 版时长，保证总时长不超过 3.5s
    const left = MAX_TOTAL_MS - 60 - (performance.now() - mountAt.current)
    const ms = Math.round(Math.max(1800, Math.min(CSS_S * 1000, left)))
    setCssMs(ms)
    setMode('css')
    later(finish, ms)
  }, [finish, later])

  // 第二帧画出时由场景回调：700ms 内到达才用 3D，结束时刻 = 首帧 + 场景时长
  const onReady = useCallback(t0 => {
    if (decided.current) return
    const now = performance.now()
    if (now - mountAt.current > READY_DEADLINE_MS) return
    decided.current = '3d'
    mark('3d')
    setMode('3d')
    later(finish, Math.max(0, t0 + SCENE_S * 1000 - now))
  }, [finish, later])

  useEffect(() => {
    mountAt.current = performance.now()
    mark('mount')
    let alive = true
    if (reduced) {
      later(finish, REDUCED_MS)
    } else if (!canUse3D()) {
      startCss()
    } else {
      later(startCss, READY_DEADLINE_MS)
      Promise.resolve().then(loadScene).then(mod => {
        if (alive && !decided.current) setScene(() => mod.default)
      }).catch(() => { if (alive) startCss() })
    }
    const list = timers.current
    return () => {
      alive = false
      finished.current = true          // 卸载后不再回调 onDone
      list.forEach(clearTimeout)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 落点：登录页可能比本组件晚挂载（还在拉 session），前 2 秒里多量几次；视口变化时重量
  useEffect(() => {
    const re = () => {
      const t = measureTarget()
      targetRef.current = t
      setTarget(prev => (prev.x === t.x && prev.y === t.y && prev.size === t.size ? prev : t))
    }
    const ids = [60, 400, 1000, 1700].map(ms => setTimeout(re, ms))
    window.addEventListener('resize', re)
    return () => { ids.forEach(clearTimeout); window.removeEventListener('resize', re) }
  }, [])

  const showScene = Scene && (mode === 'preroll' || mode === '3d')
  return (
    <div className={`ir-root is-${mode}${mobile ? ' is-mobile' : ''}${light ? ' is-light' : ''}`}
      data-mode={mode} data-authed={authed ? '1' : '0'}>
      {(mode === 'css' || mode === 'reduced' || (light && mode === '3d')) && (
        <EndFrame target={target} orb={mode === 'reduced' || mode === '3d'} />
      )}
      <div className="ir-preroll" aria-hidden="true"><i className="ir-ember" /></div>
      {showScene && (
        <div className="ir-gl">
          <Scene targetRef={targetRef} mobile={mobile} onReady={onReady} />
        </div>
      )}
      {mode === 'css' && <CssRings target={target} durationMs={cssMs} />}
    </div>
  )
}

/** 登录页同款背景（直接复用 Login.css 的背景光类名）+ 静态光球（减弱动态 / 亮色主题下 3D 版收尾时用）。
 *  暗色 3D 版不挂它：画布是不透明的，背景光由场景里的全屏背景着色器画。 */
function EndFrame({ target, orb }) {
  return (
    <div className="ir-end">
      <div className="jvl-ambient"><i className="jvl-key-light" /><i className="jvl-grain" /></div>
      {orb && <OrbAt target={target} />}
    </div>
  )
}

function OrbAt({ target, innerRef, style }) {
  return (
    <div className="ir-orb-at" ref={innerRef}
      style={{ left: `${target.x}px`, top: `${target.y}px`, ...style }}>
      <div className="ir-orb-center">
        <Presence size={target.size} quality="css" decorative />
      </div>
    </div>
  )
}

// ---------------- CSS 简化版：同一条时间轴采样成 WAAPI 关键帧（只动 transform / opacity） ----------------

const CSS_RINGS = [
  { R: 1.55, cls: 'r0', axis: '0, 1, 0' },
  { R: 2.05, cls: 'r1', axis: '1, 0, 0' },
  { R: 2.6, cls: 'r2', axis: '1, 0, 1' },
]
const TILT = 'rotateX(58deg) rotateZ(-9deg)'
const STEPS = 44

function sample(fn) {
  const out = []
  for (let i = 0; i <= STEPS; i++) {
    const s = (i / STEPS) * CSS_S
    out.push({ offset: i / STEPS, ...fn(sceneState(s), s) })
  }
  return out
}

function CssRings({ target, durationMs = CSS_S * 1000 }) {
  const stageRef = useRef(null)
  const ringRefs = useRef([])
  const pulseRef = useRef(null)
  const emberRef = useRef(null)
  const orbRef = useRef(null)
  const flashRef = useRef(null)
  const startedAt = useRef(0)
  const { x, y, size } = target
  const G = useMemo(() => {
    const W = window.innerWidth
    const H = window.innerHeight
    const dEnd = distanceForSize(size, H, 28)
    const fit = ringFit(W, H, lerp(44, dEnd, sceneState(1.5).dolly), 28, 2.6)
    // 预备画面的微光是 120px：CSS 版起始帧（舞台缩放 dEnd/44 × 核心 0.3）与之等大，切换无跳变
    const ember = 120 / ((dEnd / 44) * 0.3)
    return { dEnd, ember, unit: (size / 2) * fit, dx: x - W / 2, dy: y - H / 2 }
  }, [x, y, size])

  // 落点晚到（登录页后挂载）或视口变化时重建关键帧，并接着已播放的进度继续，不从头来
  useLayoutEffect(() => {
    const anims = []
    if (!startedAt.current) startedAt.current = performance.now()
    const elapsed = Math.max(0, performance.now() - startedAt.current)
    const run = (el, frames) => {
      if (!el || typeof el.animate !== 'function') return
      const a = el.animate(frames, { duration: durationMs, fill: 'both', easing: 'linear' })
      a.currentTime = Math.min(elapsed, durationMs)
      anims.push(a)
    }
    // 镜头：缩放 = 透视下核心的视大小（dEnd / 当前距离），平移 = 移轴落到登录页光球
    run(stageRef.current, sample(st => {
      const d = lerp(44, G.dEnd, st.dolly)
      return { transform: `translate(${(G.dx * st.pan).toFixed(2)}px, ${(G.dy * st.pan).toFixed(2)}px) scale(${(G.dEnd / d).toFixed(4)})` }
    }))
    CSS_RINGS.forEach((r, i) => {
      run(ringRefs.current[i], sample(st => {
        const q = st.rings[i]
        return {
          opacity: q.appear.toFixed(3),
          transform: `rotate3d(${r.axis}, ${((q.angle * 180) / Math.PI).toFixed(2)}deg) ${TILT} scale(${q.scale.toFixed(4)})`,
        }
      }))
    })
    run(pulseRef.current, sample(st => ({
      opacity: st.pulse.alpha.toFixed(3),
      transform: `${TILT} scale(${(st.pulse.radius / 2.6).toFixed(4)})`,
    })))
    run(emberRef.current, sample(st => ({
      opacity: (1 - st.ignite).toFixed(3),
      transform: `scale(${(st.coreScale * (1 + 0.6 * st.flash)).toFixed(4)})`,
    })))
    run(orbRef.current, sample(st => ({
      opacity: Math.min(1, st.ignite * 1.4).toFixed(3),
      transform: `scale(${st.coreScale.toFixed(4)})`,
    })))
    run(flashRef.current, sample(st => ({ opacity: (st.flash * 0.75).toFixed(3) })))
    return () => anims.forEach(a => a.cancel())
  }, [G, durationMs])

  return (
    <div className="ir-css" aria-hidden="true">
      <div className="ir-css-stage" ref={stageRef}>
        <div className="ir-css-plane">
          {CSS_RINGS.map((r, i) => (
            <div key={r.cls} className={`ir-cring ${r.cls}`} ref={el => { ringRefs.current[i] = el }}
              style={{ '--d': `${(2 * r.R * G.unit).toFixed(1)}px` }}><i /></div>
          ))}
          <div className="ir-cpulse" ref={pulseRef} style={{ '--d': `${(2 * 2.6 * G.unit).toFixed(1)}px` }} />
        </div>
        <i className="ir-cflash" ref={flashRef} style={{ '--d': `${target.size * 2.2}px` }} />
        <i className="ir-cember" ref={emberRef} style={{ '--d': `${G.ember.toFixed(1)}px` }} />
        <div className="ir-corb" ref={orbRef}>
          <Presence size={target.size} quality="css" decorative />
        </div>
      </div>
    </div>
  )
}
