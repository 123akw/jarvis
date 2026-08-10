import { useEffect, useRef, useState } from 'react'
import { login } from './api.js'
import Reactor3D from './Reactor3D.jsx'

const TELEMETRY = [
  'JWS 内核 v0.2 · 心跳正常',
  '记忆库 SQLITE · 已挂载',
  '工具阵列 13 项 · 待命',
  '加密链路 TLS1.3 · 在线',
  '全息渲染管线 · 60 FPS',
]

export default function Login({ onAuthed }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [fail, setFail] = useState(false)
  const [spinup, setSpinup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const cardRef = useRef()

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 2400)
    return () => clearInterval(t)
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
      <div className="login-gyro">
        <Reactor3D busy={busy} fail={fail} spinup={spinup} />
      </div>

      <form ref={cardRef} className="login-card chamfer" onSubmit={submit}>
        <div className="login-mark">J.A.R.V.I.S.</div>
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

      <div className="telemetry">
        {TELEMETRY.map((line, i) => (
          <div key={i} className={i === tick % TELEMETRY.length ? 'tl on' : 'tl'}>{line}</div>
        ))}
      </div>
      <div className="login-corner tl-c" /><div className="login-corner br-c" />
    </div>
  )
}
