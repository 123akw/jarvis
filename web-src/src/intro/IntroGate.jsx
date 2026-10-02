import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_INTRO, INTRO_DONE_EVENT, INTROS, markSeen, pickIntro, setIntroPlaying } from './registry.js'
import { introAllowed } from '../routes.js'
import './intro.css'

const SAFETY_MS = 8000
const FADE_MS = 420

function safeSessionStorage() {
  try { return window.sessionStorage } catch { return null }
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** 进场播放期间空闲时预取登录页光球的 WebGL chunk：进场结束后登录页不必再懒加载 */
let prefetchGL = () => import('../PresenceGL.js')
/** 测试注入用 */
export function setPrefetchLoader(fn) { prefetchGL = fn }
function whenIdle(cb) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(cb, { timeout: 1200 })
    return () => window.cancelIdleCallback?.(id)
  }
  const id = setTimeout(cb, 600)
  return () => clearTimeout(id)
}

/** 进场动画外壳：选方案 → 懒加载 → 播放 → 淡出卸载。点击、任意键、8s 兜底都会结束。
 *  开始淡出时派发 INTRO_DONE_EVENT，登录页收到后才播问候语和登录卡的入场。 */
export default function IntroGate({ authed = false }) {
  const name = useMemo(() => pickIntro({
    search: window.location.search, storage: safeSessionStorage(), reducedMotion: prefersReducedMotion(),
    fallback: introAllowed(window.location.pathname) ? DEFAULT_INTRO : null,   // 品牌平台入口、流程页不播贾维斯开场
  }), [])
  const Intro = useMemo(() => (name ? lazy(INTROS[name]) : null), [name])
  // 同步标记「正在播」：登录页可能在下一个任务里就挂载，得在它读之前就位
  const [phase, setPhase] = useState(() => { setIntroPlaying(!!name); return name ? 'playing' : 'gone' })

  const finish = useCallback(() => {
    setPhase(p => (p === 'playing' ? 'leaving' : p))
  }, [])

  useEffect(() => {
    if (phase === 'playing') {
      markSeen(safeSessionStorage())
      const timer = setTimeout(finish, SAFETY_MS)
      const onKey = () => finish()
      window.addEventListener('keydown', onKey)
      const cancelIdle = whenIdle(() => { prefetchGL().catch(() => { /* 预取失败：登录页照常懒加载 */ }) })
      return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); cancelIdle() }
    }
    if (phase === 'leaving') {
      setIntroPlaying(false)
      window.dispatchEvent(new Event(INTRO_DONE_EVENT))
      const timer = setTimeout(() => setPhase('gone'), FADE_MS)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [phase, finish])

  // 异常卸载（理论上不会）也要放开登录页
  useEffect(() => () => {
    setIntroPlaying(false)
  }, [])

  if (phase === 'gone' || !Intro) return null
  return (
    <div className={`jv-intro-gate${phase === 'leaving' ? ' leaving' : ''}`} onClick={finish}
      role="presentation" aria-hidden="true" data-intro={name}>
      <Suspense fallback={null}>
        <Intro onDone={finish} authed={authed} />
      </Suspense>
      <span className="jv-intro-skip">点击任意处跳过</span>
    </div>
  )
}
