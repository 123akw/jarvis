import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { INTROS, markSeen, pickIntro } from './registry.js'
import './intro.css'

const SAFETY_MS = 8000
const FADE_MS = 420

function safeSessionStorage() {
  try { return window.sessionStorage } catch { return null }
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** 进场动画外壳：选方案 → 懒加载 → 播放 → 淡出卸载。点击、任意键、8s 兜底都会结束。 */
export default function IntroGate({ authed = false }) {
  const name = useMemo(() => pickIntro({
    search: window.location.search, storage: safeSessionStorage(), reducedMotion: prefersReducedMotion(),
  }), [])
  const Intro = useMemo(() => (name ? lazy(INTROS[name]) : null), [name])
  const [phase, setPhase] = useState(name ? 'playing' : 'gone')   // playing → leaving → gone

  const finish = useCallback(() => {
    setPhase(p => (p === 'playing' ? 'leaving' : p))
  }, [])

  useEffect(() => {
    if (phase === 'playing') {
      markSeen(safeSessionStorage())
      const timer = setTimeout(finish, SAFETY_MS)
      const onKey = () => finish()
      window.addEventListener('keydown', onKey)
      return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey) }
    }
    if (phase === 'leaving') {
      const timer = setTimeout(() => setPhase('gone'), FADE_MS)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [phase, finish])

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
