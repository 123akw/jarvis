import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { login } from './api.js'

// three.js 场景懒加载：登录表单先出，3D 机头随后淡入
const Moss = lazy(() => import('./Moss.jsx'))

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

export default function Login({ onAuthed, notice = '' }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [fail, setFail] = useState(false)
  const [spinup, setSpinup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dateStr, setDateStr] = useState('')
  const [bubble, setBubble] = useState(null)
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem('jws_voice') !== '0')
  const cardRef = useRef()
  const bubbleTimer = useRef()
  const voiceRef = useRef(voiceOn)
  voiceRef.current = voiceOn

  function say(text, { voice = false } = {}) {
    setBubble({ text, key: Date.now() })
    clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => setBubble(null), 5000)
    if (voice && voiceRef.current) speak(text)
  }

  useEffect(() => {
    const c = setInterval(() => {
      const d = new Date()
      setDateStr(d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
        + ' · ' + d.toLocaleTimeString('zh-CN', { hour12: false }))
    }, 1000)
    const boot = setTimeout(() => say(LINES_BOOT), 1800)
    const idleIv = setInterval(() => say(pick(LINES_IDLE)), 16000 + Math.random() * 6000)
    return () => { clearInterval(c); clearTimeout(boot); clearInterval(idleIv); clearTimeout(bubbleTimer.current) }
  }, [])

  function toggleVoice() {
    setVoiceOn(v => {
      localStorage.setItem('jws_voice', v ? '0' : '1')
      if (!v) speak('MOSS 语音已开启。')
      return !v
    })
  }

  async function submit(e) {
    e.preventDefault()
    if (busy || spinup) return
    setBusy(true)
    const session = await login(u.trim(), p)
    setP('')
    if (session) {
      setSpinup(true)
      say(LINES_OK, { voice: true })
      setTimeout(() => onAuthed(session), 950)
      return
    }
    setBusy(false)
    setFail(true)
    say(LINES_FAIL, { voice: true })
    cardRef.current.classList.remove('shake')
    void cardRef.current.offsetWidth
    cardRef.current.classList.add('shake')
    setTimeout(() => setFail(false), 700)
  }

  return (
    <div className={`login${spinup ? ' login-out' : ''}`}>
      <Suspense fallback={<div className="mossbg" />}>
        <Moss busy={busy} fail={fail} spinup={spinup}
          onPick={() => say(pick(LINES_PICK), { voice: true })} />
      </Suspense>
      <div className="grain" />

      {bubble && (
        <div className="moss-bubble" key={bubble.key}>
          <span className="mb-tag">MOSS // 550W</span>
          <TypeText text={bubble.text} /><span className="mb-caret" />
        </div>
      )}

      <div className="login-type">
        <div className="login-eyebrow">J.A.R.V.I.S. // 私人管家系统</div>
        <h1 className="login-h1">{greeting()}</h1>
        <div className="login-date">{dateStr}</div>
      </div>

      <form ref={cardRef} className="login-card" onSubmit={submit}>
        <div className="login-sub">身份验证 // IDENTITY CHECK</div>
        {notice ? <div className="login-notice" role="status">{notice}</div> : null}
        <label className="field">
          <span>用户名</span>
          <input value={u} onChange={e => setU(e.target.value)}
            autoComplete="username" autoFocus spellCheck={false} />
        </label>
        <label className="field">
          <span>口令</span>
          <input type="password" value={p} onChange={e => setP(e.target.value)}
            autoComplete="current-password" />
        </label>
        <button className="login-btn" disabled={busy || spinup}>
          {spinup ? '核心同步中…' : busy ? '验证中…' : '接入系统'}
        </button>
        <div className={`login-hint${fail ? ' show' : ''}`}>身份未确认，请重试</div>
        <button type="button" className="voice-toggle" onClick={toggleVoice}>
          {voiceOn ? '🔊 MOSS 语音 · 开' : '🔇 MOSS 语音 · 关'}
        </button>
      </form>
    </div>
  )
}
