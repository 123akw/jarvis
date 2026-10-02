import { useCallback, useEffect, useRef, useState } from 'react'
import { login } from './api.js'
import Presence, { prefersReducedMotion } from './Presence.jsx'
import { INTRO_DONE_EVENT, introPlaying } from './intro/registry.js'
import { applyTheme, currentTheme } from './theme.js'
import './Login.css'

/** 登录页柔和背景光：零依赖 CSS 光场（两团静态光 + 光球身后缓慢漂移的主光 + 细颗粒），样式在 Login.css。 */
function Ambient() {
  return (
    <div className="jvl-ambient" aria-hidden="true">
      <i className="jvl-key-light" />
      <i className="jvl-grain" />
    </div>
  )
}

/** 地址栏 ?u=<用户名>：市场生成账号后带着它跳来登录页，只预填用户名（不碰口令） */
const PREFILL_PARAM = 'u'
function readPrefillUser() {
  try { return (new URLSearchParams(window.location.search).get(PREFILL_PARAM) || '').trim().slice(0, 64) } catch { return '' }
}
/** 登录成功后把 ?u= 从地址栏清掉（其余参数与 hash 原样保留），不留历史记录 */
function clearPrefillParam() {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(PREFILL_PARAM)) return
    url.searchParams.delete(PREFILL_PARAM)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  } catch { /* 清不掉不影响登录 */ }
}

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return '夜深了，领导。'
  if (h < 11) return '早上好，领导。'
  if (h < 13) return '中午好，领导。'
  if (h < 18) return '下午好，领导。'
  return '晚上好，领导。'
}

const fmtDate = d => d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  + ' · ' + d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })

/** 日期时钟单独成组件，按分钟对齐刷新：整页不再每秒重渲染 */
function LoginClock({ className }) {
  const [text, setText] = useState(() => fmtDate(new Date()))
  useEffect(() => {
    let t = 0
    const arm = () => {
      const now = new Date()
      t = setTimeout(() => { setText(fmtDate(new Date())); arm() }, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 30)
    }
    arm()
    return () => clearTimeout(t)
  }, [])
  return <div className={className}>{text}</div>
}

const orbSizeFor = () => {
  if (typeof window === 'undefined') return 200
  return Math.round(Math.max(120, Math.min(210, window.innerWidth * 0.42, window.innerHeight * 0.24)))
}
function useOrbSize() {
  const [size, setSize] = useState(orbSizeFor)
  useEffect(() => {
    let t = 0
    const on = () => { clearTimeout(t); t = setTimeout(() => setSize(orbSizeFor()), 120) }
    window.addEventListener('resize', on)
    return () => { clearTimeout(t); window.removeEventListener('resize', on) }
  }, [])
  return size
}

/** 登录页：J.A.R.V.I.S. 光球 + 柔和背景光 + 玻璃登录卡。 */
export default function Login({ onAuthed, notice = '' }) {
  const [u, setU] = useState(readPrefillUser)
  const [prefilled] = useState(() => u !== '')   // 预填了用户名：光标直接落到口令框
  const [p, setP] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('idle') // idle | leaving（卡片退场）| bloom（光球扩散）
  const [shaking, setShaking] = useState(false)
  const [typing, setTyping] = useState(false)
  const [bloomAt, setBloomAt] = useState(null)
  const [missing, setMissing] = useState('')   // 空着没填的那一栏：'user' | 'pass'
  const [hint, setHint] = useState('')         // 错误提示：一直留到用户重新输入（原来 0.7 秒就消失，来不及读）
  const orbSize = useOrbSize()
  // 进场动画播放中：问候语、登录卡、顶栏先不入场（光球照常就位，进场末帧要与它对齐），
  // 收到 INTRO_DONE_EVENT（门帘开始淡出）再入场；没有进场动画时照常立刻入场
  const [introHold, setIntroHold] = useState(introPlaying)
  const [afterIntro, setAfterIntro] = useState(false)
  useEffect(() => {
    if (!introHold) return undefined
    const go = () => { setIntroHold(false); setAfterIntro(true) }
    if (!introPlaying()) { go(); return undefined }
    window.addEventListener(INTRO_DONE_EVENT, go)
    return () => window.removeEventListener(INTRO_DONE_EVENT, go)
  }, [introHold])
  const orbRef = useRef(null)
  const userRef = useRef(null)
  const passRef = useRef(null)
  const typingLevel = useRef({ v: 0, t: 0 })
  const typingTimer = useRef(0)
  const timers = useRef([])
  const spinup = stage !== 'idle'

  const later = (fn, ms) => { timers.current.push(setTimeout(fn, ms)) }

  // 跟随用户的主题（存储不可读时按暗色）
  useEffect(() => {
    let theme = 'dark'
    try { theme = currentTheme() } catch { theme = 'dark' }
    applyTheme(theme)
  }, [])

  useEffect(() => () => {
    timers.current.forEach(clearTimeout)
    clearTimeout(typingTimer.current)
  }, [])

  // 打字时光球「在听」：每次按键给一个音量脉冲，按指数衰减；停手 1.2 秒回到待命
  const getTypingLevel = useCallback(() => {
    const k = typingLevel.current
    return k.v * Math.exp(-(performance.now() - k.t) / 320)
  }, [])
  function onKeyActivity() {
    typingLevel.current = { v: 0.45 + Math.random() * 0.4, t: performance.now() }
    setTyping(true)
    clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => setTyping(false), 1200)
  }

  function succeed(session) {
    clearPrefillParam()
    const reduced = prefersReducedMotion()
    const r = orbRef.current?.getBoundingClientRect()
    const origin = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    setStage('leaving')           // 卡片与文字先退，光球进入「回答」律动
    later(() => { setBloomAt(origin); setStage('bloom') }, reduced ? 0 : 260)
    later(() => onAuthed(session, { handoff: origin || {} }), reduced ? 280 : 1000)
  }

  async function submit(e) {
    e.preventDefault()
    if (busy || spinup) return
    // 从表单元素取值：浏览器自动填充的口令在用户交互前可能还没同步进 React 状态
    const user = (userRef.current?.value ?? u).trim()
    const pass = passRef.current?.value ?? p
    if (!user || !pass) {   // 空着的栏不发请求：提示并把光标放过去
      setMissing(!user ? 'user' : 'pass')
      setHint(!user ? '请输入用户名' : '请输入口令')
      ;(!user ? userRef : passRef).current?.focus()
      return
    }
    setMissing('')
    setBusy(true)
    let session = null
    try { session = await login(user, pass) } catch { session = null }
    setP('')
    if (session) {
      setBusy(false)
      succeed(session)
      return
    }
    setBusy(false)
    setHint('身份未确认，请重试')
    setShaking(true)
    // 提交时按钮被禁用、焦点丢到 body：放回口令框，直接重输
    passRef.current?.focus()
  }

  const orbState = spinup ? 'speaking' : busy ? 'thinking' : typing ? 'listening' : 'idle'

  return (
    <div className={`jv-login stage-${stage}${introHold ? ' intro-hold' : ''}${afterIntro ? ' after-intro' : ''}`}>
      <Ambient />

      <div className="jvl-top">
        <span className="jvl-brand">J.A.R.V.I.S.</span>
      </div>

      <main className="jvl-main">
        <div className="jvl-orb" ref={orbRef}>
          <Presence size={orbSize} state={orbState} level={spinup ? 1 : 0}
            getLevel={orbState === 'listening' ? getTypingLevel : undefined} />
        </div>
        <div className="jvl-greet">
          <h1 className="jvl-h1">{greeting()}</h1>
          <LoginClock className="jvl-date" />
        </div>
        <div className="jvl-card-wrap">
          <form className={`jvl-card${shaking ? ' shake' : ''}`} onSubmit={submit} aria-label="登录"
            onAnimationEnd={e => { if (e.target === e.currentTarget) setShaking(false) }}>
            <div className="jvl-card-title">身份验证</div>
            {notice ? <div className="jvl-notice" role="status">{notice}</div> : null}
            <label className="jvl-field">
              <span>用户名</span>
              <input ref={userRef} value={u} onChange={e => { setU(e.target.value); setMissing(''); setHint(''); onKeyActivity() }}
                autoComplete="username" autoFocus={!prefilled} spellCheck={false} aria-invalid={missing === 'user' || undefined} />
            </label>
            <label className="jvl-field">
              <span>口令</span>
              <input ref={passRef} type="password" value={p} onChange={e => { setP(e.target.value); setMissing(''); setHint(''); onKeyActivity() }}
                autoComplete="current-password" autoFocus={prefilled} aria-invalid={missing === 'pass' || undefined} />
            </label>
            <button className="jvl-btn" disabled={busy || spinup}>
              <span>{spinup ? '正在接入…' : busy ? '验证中…' : '接入系统'}</span>
            </button>
            <div className={`jvl-hint${hint ? ' show' : ''}`} aria-live="polite">{hint}</div>
          </form>
        </div>
      </main>

      {stage === 'bloom' && (
        <div className="jv-bloom is-in" aria-hidden="true"
          style={bloomAt ? { left: `${bloomAt.x}px`, top: `${bloomAt.y}px` } : { left: '50%', top: '40%' }} />
      )}
    </div>
  )
}
