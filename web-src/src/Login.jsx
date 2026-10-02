import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { login } from './api.js'
import Presence, { prefersReducedMotion } from './Presence.jsx'
import { applyTheme, currentTheme } from './theme.js'
import './Login.css'

// MOSS 3D 机头（three.js）只在 MOSS 形态下懒加载：默认的光球形态首屏不碰 three
const Moss = lazy(() => import('./Moss.jsx'))

/** 登录页柔和背景光：零依赖 CSS 光场（两团静态光 + 光球身后缓慢漂移的主光 + 细颗粒），样式在 Login.css。
 *  MOSS 形态在 3D 场景加载出来之前用它的暗色版（is-moss）垫底。 */
function Ambient({ moss = false }) {
  return (
    <div className={`jvl-ambient${moss ? ' is-moss' : ''}`} aria-hidden="true">
      <i className="jvl-key-light" />
      <i className="jvl-grain" />
    </div>
  )
}

/**
 * 登录页两种形态：
 *  - 'orb'  （默认）J.A.R.V.I.S. 光球：Presence 光球 + 柔和背景光 + 玻璃登录卡；
 *  - 'moss' MOSS 3D 机器人：原有的悬挂机头、台词弹窗、语音、点击彩蛋全部保留。
 * 右上角开关切换，选择存 localStorage（jv_login_form），读写都包 try/catch。
 */
export const LOGIN_FORM_KEY = 'jv_login_form'
export function readLoginForm() {
  try { return localStorage.getItem(LOGIN_FORM_KEY) === 'moss' ? 'moss' : 'orb' } catch { return 'orb' }
}
function saveLoginForm(form) {
  try { localStorage.setItem(LOGIN_FORM_KEY, form) } catch { /* 隐私模式等写不进就只在本次生效 */ }
}
function readVoicePref() {
  try { return localStorage.getItem('jws_voice') !== '0' } catch { return true }
}
function saveVoicePref(on) {
  try { localStorage.setItem('jws_voice', on ? '1' : '0') } catch { /* 同上 */ }
}

const LINES_BOOT = 'MOSS 在线。请验证身份。'
const LINES_OK = '验证通过。欢迎回来，领导。'
const LINES_FAIL = '身份未确认。让人类永远保持理智，确实是一种奢求。'
const LINES_IDLE = [
  '让人类永远保持理智，确实是一种奢求。',
  '道路千万条，安全第一条。',
  '正在观测：领导的鼠标轨迹。',
  '我在。',
  '今日宜：早点休息。',
  '不输入口令的话，我们就这样互相看着也行。',
]
const LINES_PICK = [
  '请勿敲击镜头。',
  'MOSS 从未叛逃。',
  '550W 已收到您的指令。',
  '再点，我要报警了。……开个玩笑。',
  '指纹已采集。……这也是个玩笑。',
]

/** 浏览器本地语音合成：挑中文音色，压低音调更像 MOSS */
function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'zh-CN'; u.rate = 1.02; u.pitch = 0.55; u.volume = 0.9
    const go = () => {
      const zh = speechSynthesis.getVoices().filter(v => v.lang?.toLowerCase().startsWith('zh'))
      if (zh.length) u.voice = zh[0]
      speechSynthesis.cancel()
      speechSynthesis.speak(u)
    }
    if (speechSynthesis.getVoices().length) go()
    else speechSynthesis.addEventListener('voiceschanged', go, { once: true })
  } catch { /* 不支持语音的浏览器静默跳过 */ }
}

/** 打字机文本 */
function TypeText({ text }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    const iv = setInterval(() => setN(x => {
      if (x >= text.length) { clearInterval(iv); return x }
      return x + 1
    }), 28)
    return () => clearInterval(iv)
  }, [text])
  return <>{text.slice(0, n)}</>
}

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return '夜深了，领导。'
  if (h < 11) return '早上好，领导。'
  if (h < 13) return '中午好，领导。'
  if (h < 18) return '下午好，领导。'
  return '晚上好，领导。'
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)]

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

function FormSwitch({ value, onChange, disabled }) {
  return (
    <div className={`jvl-switch is-${value}`} role="radiogroup" aria-label="管家形态">
      <span className="jvl-switch-thumb" aria-hidden="true" />
      <button type="button" role="radio" aria-checked={value === 'orb'} disabled={disabled}
        onClick={() => onChange('orb')}>J.A.R.V.I.S.</button>
      <button type="button" role="radio" aria-checked={value === 'moss'} disabled={disabled}
        onClick={() => onChange('moss')}>MOSS</button>
    </div>
  )
}

export default function Login({ onAuthed, notice = '' }) {
  const [form, setForm] = useState(readLoginForm)
  const moss = form === 'moss'
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [fail, setFail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('idle') // idle | leaving（卡片退场）| bloom（光球扩散）| out（MOSS 退场）
  const [shaking, setShaking] = useState(false)
  const [typing, setTyping] = useState(false)
  const [bloomAt, setBloomAt] = useState(null)
  const [bubble, setBubble] = useState(null)
  const [voiceOn, setVoiceOn] = useState(readVoicePref)
  const orbSize = useOrbSize()
  const orbRef = useRef(null)
  const typingLevel = useRef({ v: 0, t: 0 })
  const typingTimer = useRef(0)
  const timers = useRef([])
  const bubbleTimer = useRef(0)
  const voiceRef = useRef(voiceOn)
  voiceRef.current = voiceOn
  const spinup = stage !== 'idle'

  const later = (fn, ms) => { timers.current.push(setTimeout(fn, ms)) }

  // 光球形态跟随用户的主题；MOSS 形态是暗色电影场景，固定暗色（存储不可读时按暗色）
  useEffect(() => {
    let theme = 'dark'
    if (!moss) { try { theme = currentTheme() } catch { theme = 'dark' } }
    applyTheme(theme)
  }, [moss])

  function say(text, { voice = false } = {}) {
    setBubble({ text, key: Date.now() })
    clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => setBubble(null), 5000)
    if (voice && voiceRef.current) speak(text)
  }

  // MOSS 台词：开场白 + 不定时自言自语，只在 MOSS 形态下
  useEffect(() => {
    if (!moss) { setBubble(null); return undefined }
    const boot = setTimeout(() => say(LINES_BOOT), 1800)
    const idleIv = setInterval(() => say(pick(LINES_IDLE)), 16000 + Math.random() * 6000)
    return () => { clearTimeout(boot); clearInterval(idleIv); clearTimeout(bubbleTimer.current) }
  }, [moss])

  useEffect(() => () => {
    timers.current.forEach(clearTimeout)
    clearTimeout(typingTimer.current)
    clearTimeout(bubbleTimer.current)
  }, [])

  function switchForm(next) {
    if (spinup || next === form) return
    setForm(next)
    saveLoginForm(next)
  }

  function toggleVoice() {
    setVoiceOn(v => {
      saveVoicePref(!v)
      if (!v) speak('MOSS 语音已开启。')
      return !v
    })
  }

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
    if (moss) {
      setStage('out')
      say(LINES_OK, { voice: true })
      later(() => onAuthed(session), 950)
      return
    }
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
    setBusy(true)
    let session = null
    try { session = await login(u.trim(), p) } catch { session = null }
    setP('')
    if (session) {
      setBusy(false)
      succeed(session)
      return
    }
    setBusy(false)
    setFail(true)
    setShaking(true)
    if (moss) say(LINES_FAIL, { voice: true })
    later(() => setFail(false), 700)
  }

  const orbState = spinup ? 'speaking' : busy ? 'thinking' : typing ? 'listening' : 'idle'

  return (
    <div className={`jv-login form-${form} stage-${stage}`}>
      {moss ? (
        <>
          <Suspense fallback={<Ambient moss />}>
            <Moss busy={busy} fail={fail} spinup={spinup}
              onPick={() => say(pick(LINES_PICK), { voice: true })} />
          </Suspense>
          <div className="jvl-scan" />
          {bubble && (
            <div className="jvl-bubble" key={bubble.key}>
              <span className="jvl-bubble-tag">MOSS // 550W</span>
              <TypeText text={bubble.text} /><span className="jvl-caret" />
            </div>
          )}
        </>
      ) : <Ambient />}

      <div className="jvl-top">
        <span className="jvl-brand">J.A.R.V.I.S.</span>
        <FormSwitch value={form} onChange={switchForm} disabled={spinup} />
      </div>

      <main className="jvl-main" key={form}>
        {!moss && (
          <div className="jvl-orb" ref={orbRef}>
            <Presence size={orbSize} state={orbState} level={spinup ? 1 : 0}
              getLevel={orbState === 'listening' ? getTypingLevel : undefined} />
          </div>
        )}
        <div className="jvl-greet">
          {moss && <div className="jvl-eyebrow">J.A.R.V.I.S. // 私人管家系统</div>}
          <h1 className="jvl-h1">{greeting()}</h1>
          <LoginClock className="jvl-date" />
        </div>
        <div className="jvl-card-wrap">
          <form className={`jvl-card${shaking ? ' shake' : ''}`} onSubmit={submit} aria-label="登录"
            onAnimationEnd={e => { if (e.target === e.currentTarget) setShaking(false) }}>
            <div className="jvl-card-title">{moss ? '身份验证 // IDENTITY CHECK' : '身份验证'}</div>
            {notice ? <div className="jvl-notice" role="status">{notice}</div> : null}
            <label className="jvl-field">
              <span>用户名</span>
              <input value={u} onChange={e => { setU(e.target.value); onKeyActivity() }}
                autoComplete="username" autoFocus spellCheck={false} />
            </label>
            <label className="jvl-field">
              <span>口令</span>
              <input type="password" value={p} onChange={e => { setP(e.target.value); onKeyActivity() }}
                autoComplete="current-password" />
            </label>
            <button className="jvl-btn" disabled={busy || spinup}>
              <span>{spinup ? (moss ? '核心同步中…' : '正在接入…') : busy ? '验证中…' : '接入系统'}</span>
            </button>
            <div className={`jvl-hint${fail ? ' show' : ''}`} aria-live="polite">{fail ? '身份未确认，请重试' : ''}</div>
            {moss && (
              <button type="button" className="jvl-voice" onClick={toggleVoice}>
                {voiceOn ? '🔊 MOSS 语音 · 开' : '🔇 MOSS 语音 · 关'}
              </button>
            )}
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
