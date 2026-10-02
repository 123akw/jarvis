import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './Presence.css'

/**
 * 「AI 存在感」光球 —— 贾维斯在场的唯一视觉符号（登录页、语音通话、空态、思考提示共用）。
 *
 * 用法：
 *   <Presence state="idle" size={160} />                       // 空态挂载点 .jv-presence-slot
 *   <Presence state="listening" getLevel={() => micLevel} />   // 高频音量：每帧轮询，不触发 React 重渲染
 *   <Presence state="speaking" level={0.6} />                  // 低频音量：直接传数字
 *   <Presence state="thinking" size={20} decorative />         // Chat 里「思考中」的小尺寸版
 *
 * props：
 *   state      'idle' | 'listening' | 'thinking' | 'speaking'（未知值按 idle）
 *              idle=缓慢呼吸流动；listening=随输入音量膨胀；thinking=渐变加速流转 + 扫光；
 *              speaking=随输出音量律动。状态切换由帧率无关的指数平滑插值，不跳变。
 *   level      0–1 数字，输入/输出音量（越界自动截断）
 *   getLevel   () => 0–1，每帧调用；提供时优先于 level（麦克风/播放音量这类高频源用它）
 *   size       直径 px，默认 160；光晕会溢出到约 1.8 倍范围，外层留好空间
 *   quality    'auto'（默认：先出 CSS 版，空闲时懒加载 WebGL 版淡入替换）| 'css'（只用 CSS 版）
 *              size < 96、prefers-reduced-motion、无 WebGL 时自动只用 CSS 版
 *   label      无障碍名称，默认「贾维斯：待命/在听/思考中/回答中」
 *   decorative true 时 aria-hidden（旁边已有文字状态时用）
 *   className  附加到根节点
 *
 * 性能约定：CSS 版的持续流动全部是 transform/opacity 关键帧（合成线程）；JS 只在 listening/speaking
 * 或状态过渡未收敛时跑一个全局共享的 rAF（多个光球共用一个回调），空闲 idle/thinking 主线程零开销。
 * 页面隐藏时 rAF 与 CSS 动画都由浏览器暂停；光球滚出视口时 WebGL 停画。
 */

export const PRESENCE_STATES = ['idle', 'listening', 'thinking', 'speaking']
const STATE_LABEL = { idle: '待命', listening: '在听', thinking: '思考中', speaking: '回答中' }
export const GL_MIN_SIZE = 96

export const clamp01 = v => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
export const normalizeState = s => (PRESENCE_STATES.includes(s) ? s : 'idle')

/** 音量 RMS（0~1，人声通常 0.01~0.2）→ 视觉音量 0~1：减底噪、归一、开方压缩让小声也看得见。 */
export function rmsToLevel(rms, floor = 0.012, full = 0.16) {
  return Math.sqrt(clamp01((rms - floor) / (full - floor)))
}

/** 各状态的目标视觉参数。speed=流动速度，spin=整体旋转速度，energy=亮度/脉络强度，
 *  scale=球体缩放，halo=外光晕强度，sweep=思考扫光（0/1）。 */
export function targetParams(state, level = 0) {
  const l = clamp01(level)
  switch (normalizeState(state)) {
    case 'listening':
      return { speed: 0.5 + 0.7 * l, spin: 0.08, energy: 0.45 + 0.55 * l, scale: 1 + 0.16 * l, halo: 0.68 + 0.32 * l, sweep: 0 }
    case 'thinking':
      return { speed: 1.6, spin: 1.15, energy: 0.62, scale: 0.94, halo: 0.6, sweep: 1 }
    case 'speaking':
      return { speed: 0.8 + 0.6 * l, spin: 0.22, energy: 0.5 + 0.5 * l, scale: 1 + 0.12 * l, halo: 0.74 + 0.36 * l, sweep: 0 }
    default:
      return { speed: 0.28, spin: 0.05, energy: 0.28, scale: 1, halo: 0.5, sweep: 0 }
  }
}

export const PARAM_KEYS = ['speed', 'spin', 'energy', 'scale', 'halo', 'sweep']

// ---- 全局花纹时钟：同一页面里所有光球（含进场动画里的那颗）在待命状态下逐帧同相 ----
const IDLE = targetParams('idle')
const CLOCK_SEED = Math.random() * 10   // 每次加载换一种花纹；同一页面内所有光球共用
/** 待命状态下的流动相位 / 旋转角 / 呼吸缩放，只由 performance.now() 决定。
 *  Presence 在非待命状态下累积的偏移会随状态回落保持不变，所以回到待命后依然与时钟同速；
 *  进场动画末帧按同一时钟渲染，交接给登录页光球时花纹完全一致。 */
export function presenceClock(nowMs = performance.now()) {
  const time = nowMs / 1000
  return {
    time,
    phase: CLOCK_SEED + IDLE.speed * time,
    spin: CLOCK_SEED * 0.63 + IDLE.spin * 1.6 * time,
    breath: 1 + 0.022 * Math.sin(time * (Math.PI * 2 / 5.6)),
  }
}
// 各参数的时间常数（秒）：音量相关的快、氛围相关的慢——像呼吸，不像开关
const TAU = { speed: 0.7, spin: 0.8, energy: 0.16, scale: 0.09, halo: 0.22, sweep: 0.45 }

/** 帧率无关的指数平滑：每个参数以各自时间常数逼近目标。60fps 跑一帧和 30fps 跑半帧结果一致。 */
export function stepParams(cur, target, dt) {
  const out = {}
  const d = Math.max(0, Number.isFinite(dt) ? dt : 0)
  for (const k of PARAM_KEYS) {
    out[k] = cur[k] + (target[k] - cur[k]) * (1 - Math.exp(-d / TAU[k]))
  }
  return out
}

export function paramsSettled(cur, target, eps = 0.002) {
  return PARAM_KEYS.every(k => Math.abs(cur[k] - target[k]) < eps)
}

/** 音量包络：起音快（看得出你一开口它就动）、释放慢（不抖）。 */
export function smoothLevel(prev, next, dt, attack = 0.05, release = 0.24) {
  const tau = next > prev ? attack : release
  return prev + (next - prev) * (1 - Math.exp(-Math.max(0, dt) / tau))
}

export function prefersReducedMotion() {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

let glSupport
/** 只探一次；jsdom 等没有 WebGLRenderingContext 的环境直接 false（不去碰 getContext）。 */
export function webglAvailable() {
  if (glSupport !== undefined) return glSupport
  glSupport = false
  try {
    if (typeof window === 'undefined' || typeof window.WebGLRenderingContext === 'undefined') return glSupport
    if (navigator.connection?.saveData) return glSupport
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: true })
    glSupport = !!gl
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    glSupport = false
  }
  return glSupport
}

/** 测试用：清掉 WebGL 探测缓存。 */
export function resetWebglProbe() { glSupport = undefined }

let loadGL = () => import('./PresenceGL.js')
/** 测试注入用：替换 WebGL 版的懒加载器。 */
export function setPresenceGLLoader(fn) { loadGL = fn }

// ---- 全局共享帧驱动：所有光球/流光共用一个 rAF，没有订阅者就停 ----
// 模块加载时取下 rAF 的引用：之后别处（含测试）替换全局 rAF 不会把光球的帧混进去
const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
  ? window.requestAnimationFrame.bind(window)
  : cb => setTimeout(() => cb(typeof performance !== 'undefined' ? performance.now() : Date.now()), 16)
const subs = new Set()
let running = false
let lastNow = 0

function frame(now) {
  const dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 1 / 60
  lastNow = now
  for (const fn of [...subs]) {
    let keep = false
    try { keep = fn(dt, now) } catch { keep = false }
    if (!keep) subs.delete(fn)
  }
  if (subs.size) raf(frame)
  else { running = false; lastNow = 0 }
}

/** 订阅帧回调 fn(dt秒, now)；返回 false 自动退订。返回取消函数。 */
export function onFrame(fn) {
  subs.add(fn)
  if (!running) { running = true; lastNow = 0; raf(frame) }
  return () => { subs.delete(fn) }
}

/** prefers-reduced-motion 订阅（系统设置改了即时生效）。 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    let mq
    try { mq = window.matchMedia?.('(prefers-reduced-motion: reduce)') } catch { mq = null }
    if (!mq) return undefined
    const on = () => setReduced(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

const isLevelDriven = s => s === 'listening' || s === 'speaking'
/** 画布像素尺寸：画布 = 1.8 倍球径（给光晕留边）；软光不需要高分辨率，大球 dpr 封顶 1.5、小球 2 */
function sizeCanvas(r, size) {
  r.resize(Math.round(size * 1.8), Math.min(window.devicePixelRatio || 1, size > 200 ? 1.5 : 2))
}
const idleCb = cb => (typeof window.requestIdleCallback === 'function'
  ? { id: window.requestIdleCallback(cb, { timeout: 1500 }), idle: true }
  : { id: setTimeout(cb, 300), idle: false })
const cancelIdleCb = h => {
  if (!h) return
  if (h.idle) window.cancelIdleCallback?.(h.id)
  else clearTimeout(h.id)
}

function Presence({
  state = 'idle', level = 0, getLevel, size = 160, quality = 'auto',
  label, decorative = false, className = '',
}) {
  const s = normalizeState(state)
  const reduced = useReducedMotion()
  const rootRef = useRef(null)
  const bodyRef = useRef(null)
  const haloRef = useRef(null)
  const canvasRef = useRef(null)
  const rendererRef = useRef(null)
  const stopRef = useRef(null)
  const visibleRef = useRef(true)
  const [gl, setGl] = useState('off') // off | on（已建上下文）| ready（首帧已画，淡入中）| done（CSS 版卸下）
  const setGlRef = useRef(setGl)
  const live = useRef(null)
  live.current = { state: s, level, getLevel, reduced, gl }
  const sim = useRef(null)
  if (!sim.current) {
    const t = targetParams(s, 0)
    sim.current = { cur: t, lvl: 0, phaseOff: 0, spinOff: 0, drewGL: false }
  }

  const glEligible = quality === 'auto' && !reduced && size >= GL_MIN_SIZE
  const sizeRef = useRef(size)
  sizeRef.current = size

  // 每帧：平滑音量 → 目标参数 → 插值 → 写 CSS 变换或画 WebGL
  const stepRef = useRef(null)
  stepRef.current = (dt) => {
    const L = live.current
    const S = sim.current
    if (!visibleRef.current) return false
    const raw = typeof L.getLevel === 'function' ? L.getLevel() : L.level
    S.lvl = smoothLevel(S.lvl, isLevelDriven(L.state) ? clamp01(raw) : 0, dt)
    const target = targetParams(L.state, S.lvl)
    S.cur = stepParams(S.cur, target, dt)
    // 相对全局时钟的偏移：只有偏离待命速度时才累积，待命时花纹与时钟（和进场动画）同相
    S.phaseOff += (S.cur.speed - IDLE.speed) * dt
    S.spinOff += (S.cur.spin - IDLE.spin) * dt * 1.6
    const r = rendererRef.current
    if (r && L.gl !== 'off') {
      const clk = presenceClock()
      const ok = r.render({
        phase: clk.phase + S.phaseOff, spin: clk.spin + S.spinOff, energy: S.cur.energy, scale: S.cur.scale * clk.breath,
        halo: S.cur.halo, sweep: S.cur.sweep, time: clk.time,
        light: document.body.classList.contains('light') ? 1 : 0,
      })
      if (ok === false) return false
      if (ok && !S.drewGL) { S.drewGL = true; setGlRef.current('ready') }   // ok === null：着色器还在后台编译
      return true // WebGL 版持续流动：可见期间一直画
    }
    // CSS 版：只写两个元素的 transform/opacity（不触发布局）
    const b = bodyRef.current
    const h = haloRef.current
    if (b) b.style.transform = `scale(${S.cur.scale.toFixed(4)})`
    if (h) {
      h.style.opacity = Math.min(1, S.cur.halo).toFixed(3)
      h.style.transform = `scale(${(0.92 + 0.22 * S.cur.halo).toFixed(4)})`
    }
    return isLevelDriven(L.state) || !paramsSettled(S.cur, target)
  }

  const kick = () => {
    if (live.current.reduced || stopRef.current) return
    const fn = (dt, now) => {
      const keep = stepRef.current(dt, now)
      if (!keep) stopRef.current = null
      return keep
    }
    stopRef.current = onFrame(fn)
  }

  // 状态/音量/渲染层变化 → 唤醒帧驱动（已在跑则无操作）
  useEffect(() => { kick() }, [s, level, getLevel, reduced, gl]) // eslint-disable-line react-hooks/exhaustive-deps

  // 减弱动态：停帧驱动，回到静态参数（状态只靠颜色/光晕强弱表达）
  useLayoutEffect(() => {
    if (!reduced) return
    stopRef.current?.()
    stopRef.current = null
    const t = targetParams(s, 0)
    sim.current.cur = t
    if (bodyRef.current) bodyRef.current.style.transform = ''
    if (haloRef.current) { haloRef.current.style.transform = ''; haloRef.current.style.opacity = '' }
  }, [reduced, s])

  // 视口外停画（空态区滚走、抽屉收起），回到视口再续
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver !== 'function') return undefined
    const io = new IntersectionObserver(entries => {
      visibleRef.current = entries[entries.length - 1].isIntersecting
      if (visibleRef.current) kick()
    })
    io.observe(el)
    return () => io.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // WebGL 版：首屏之后的空闲时刻才去取（独立小 chunk，零 three 依赖），画出第一帧再淡入
  useEffect(() => {
    if (!glEligible || !webglAvailable()) return undefined
    let cancelled = false
    const h = idleCb(() => {
      loadGL().then(mod => {
        const canvas = canvasRef.current
        if (cancelled || !canvas) return
        const r = mod.createPresenceRenderer(canvas, {
          onLost: () => {
            rendererRef.current = null
            setGl('off')
          },
        })
        if (!r) return
        sizeCanvas(r, sizeRef.current)
        rendererRef.current = r
        sim.current.drewGL = false
        setGl('on')
      }).catch(() => { /* 加载失败就留在 CSS 版 */ })
    })
    return () => {
      cancelled = true
      cancelIdleCb(h)
      rendererRef.current?.destroy()
      rendererRef.current = null
      setGl('off')
    }
  }, [glEligible]) // eslint-disable-line react-hooks/exhaustive-deps

  // 首帧画出后交叉淡入（与 CSS 的 .9s 过渡对齐），完成后卸下 CSS 版，停掉它的合成层动画
  useEffect(() => {
    if (gl !== 'ready') return undefined
    const t = setTimeout(() => setGl(g => (g === 'ready' ? 'done' : g)), 1000)
    return () => clearTimeout(t)
  }, [gl])

  useEffect(() => {
    if (rendererRef.current) sizeCanvas(rendererRef.current, size)
  }, [size])

  // 卸载：退订帧驱动
  useEffect(() => () => { stopRef.current?.(); stopRef.current = null }, [])

  const cls = [
    'jv-presence', `is-${s}`,
    reduced ? 'is-reduced' : '',
    gl === 'ready' || gl === 'done' ? 'gl-ready' : '',
    gl === 'done' ? 'gl-done' : '',
    className,
  ].filter(Boolean).join(' ')
  const name = label || `贾维斯：${STATE_LABEL[s]}`

  return (
    <div ref={rootRef} className={cls} data-state={s}
      style={{ '--jvp-size': `${size}px` }}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? 'true' : undefined}>
      <div className="jvp-css">
        <div ref={haloRef} className="jvp-halo"><i /><i /><i /></div>
        <div ref={bodyRef} className="jvp-body">
          <div className="jvp-breathe">
            <div className="jvp-core">
              <i className="jvp-flow" />
              <i className="jvp-blob b1" /><i className="jvp-blob b2" /><i className="jvp-blob b3" />
              <i className="jvp-depth" />
              <i className="jvp-sweep" />
              <i className="jvp-sheen" />
            </div>
          </div>
        </div>
      </div>
      {glEligible && <canvas ref={canvasRef} className="jvp-gl" aria-hidden="true" />}
    </div>
  )
}

export default memo(Presence)

/**
 * 屏幕边缘流光（Apple Intelligence 式）：沿视口四边一圈柔和渐变流动，通话中用。
 * 流动本身是 CSS transform 关键帧（合成线程）；强度/厚度随 state + 音量由共享帧驱动写入。
 */
export const EdgeGlow = memo(function EdgeGlow({ state = 'idle', level = 0, getLevel, active = true }) {
  const s = normalizeState(state)
  const reduced = useReducedMotion()
  const kRef = useRef(null)
  const stripRefs = useRef([])
  const live = useRef(null)
  live.current = { s, level, getLevel }
  const sim = useRef({ lvl: 0, k: 0, t: 0 })

  useEffect(() => {
    if (!active || reduced) return undefined
    const stop = onFrame(dt => {
      const L = live.current
      const S = sim.current
      const raw = typeof L.getLevel === 'function' ? L.getLevel() : L.level
      S.lvl = smoothLevel(S.lvl, isLevelDriven(L.s) ? clamp01(raw) : 0, dt, 0.06, 0.3)
      S.t += dt
      const base = L.s === 'idle' ? 0.32 : L.s === 'thinking'
        ? 0.5 + 0.16 * Math.sin(S.t * Math.PI * 2 / 1.5)
        : 0.55 + 0.45 * S.lvl
      S.k += (base - S.k) * (1 - Math.exp(-dt / 0.25))
      if (kRef.current) kRef.current.style.opacity = S.k.toFixed(3)
      const thick = (0.75 + 0.9 * S.lvl).toFixed(3)
      stripRefs.current.forEach((el, i) => {
        if (el) el.style.transform = i < 2 ? `scaleY(${thick})` : `scaleX(${thick})`
      })
      return true
    })
    return stop
  }, [active, reduced])

  return (
    <div className={`jv-edge is-${s}${active ? ' on' : ''}${reduced ? ' is-reduced' : ''}`} aria-hidden="true">
      <div className="jve-k" ref={kRef}>
        {['t', 'b', 'l', 'r'].map((side, i) => (
          <i key={side} className={`jve-s jve-${side}`} ref={el => { stripRefs.current[i] = el }}><b /></i>
        ))}
      </div>
    </div>
  )
})

/**
 * 登录成功的光晕交接：登录页的光球扩散成整屏柔光后，主界面在这层光后面出现，光再慢慢散去。
 * origin = 扩散中心（视口 px），onDone 在淡出结束后调用。
 */
export function PresenceBloom({ origin, onDone }) {
  const reduced = prefersReducedMotion()
  useEffect(() => {
    const t = setTimeout(() => onDone?.(), reduced ? 320 : 1000)
    return () => clearTimeout(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const x = origin?.x ?? (typeof window !== 'undefined' ? window.innerWidth / 2 : 0)
  const y = origin?.y ?? (typeof window !== 'undefined' ? window.innerHeight * 0.4 : 0)
  return <div className="jv-bloom is-out" style={{ left: `${x}px`, top: `${y}px` }} aria-hidden="true" />
}
