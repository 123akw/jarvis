import { useEffect, useRef, useState } from 'react'
import { login } from './api.js'
import Moss from './Moss.jsx'

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return '夜深了，领导。'
  if (h < 11) return '早上好，领导。'
  if (h < 13) return '中午好，领导。'
  if (h < 18) return '下午好，领导。'
  return '晚上好，领导。'
}

export default function Login({ onAuthed }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [fail, setFail] = useState(false)
  const [spinup, setSpinup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dateStr, setDateStr] = useState('')
  const cardRef = useRef()

  useEffect(() => {
    const c = setInterval(() => {
      const d = new Date()
      setDateStr(d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
        + ' · ' + d.toLocaleTimeString('zh-CN', { hour12: false }))
    }, 1000)
    return () => clearInterval(c)
  }, [])

  async function submit(e) {
    e.preventDefault()
    if (busy || spinup) return
    setBusy(true)
    const ok = await login(u.trim(), p)
    if (ok) {
      setSpinup(true)
      setTimeout(onAuthed, 950)
      return
    }
    setBusy(false)
    setFail(true)
    cardRef.current.classList.remove('shake')
    void cardRef.current.offsetWidth
    cardRef.current.classList.add('shake')
    setTimeout(() => setFail(false), 700)
  }

  return (
    <div className={`login${spinup ? ' login-out' : ''}`}>
      <Moss busy={busy} fail={fail} spinup={spinup} />
      <div className="grain" />

      <div className="login-type">
        <div className="login-eyebrow">J.A.R.V.I.S. // 私人管家系统</div>
        <h1 className="login-h1">{greeting()}</h1>
        <div className="login-date">{dateStr}</div>
      </div>

      <form ref={cardRef} className="login-card" onSubmit={submit}>
        <div className="login-sub">身份验证 // IDENTITY CHECK</div>
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
      </form>
    </div>
  )
}
