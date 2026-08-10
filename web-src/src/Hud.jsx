import { useEffect, useState } from 'react'
import { logout } from './api.js'
import Chat from './Chat.jsx'
import { MossMini } from './Moss.jsx'
import Panels from './Panels.jsx'
import Threads from './Threads.jsx'

function newThreadId() {
  return 't-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10))
}

export default function Hud({ onLogout }) {
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [dash, setDash] = useState(null)
  const [clock, setClock] = useState('')
  const [geo, setGeo] = useState(null)
  const [thread, setThread] = useState(() => localStorage.getItem('jws_thread') || 'web')

  useEffect(() => { localStorage.setItem('jws_thread', thread) }, [thread])

  useEffect(() => {
    const t = setInterval(() =>
      setClock(new Date().toLocaleTimeString('zh-CN', { hour12: false })), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {  // 浏览器定位：拿到就随对话上报，拒绝则服务端按 IP 兜底
    navigator.geolocation?.getCurrentPosition(
      p => setGeo({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => {}, { timeout: 8000, maximumAge: 600000 })
  }, [])

  async function quit() {
    await logout()
    onLogout()
  }

  return (
    <div className="hud">
      <div className="sweep" /><div className="grain" />
      <header>
        <span className="wordmark">J.A.R.V.I.S.</span>
        <span className="tagline">私人管家 · v{dash?.version ?? '—'}</span>
        <span className="spacer" />
        <span className="chip">{dash?.model ?? '—'}</span>
        <span className="chip online"><span className="dot" />{dash?.place || '在线'}</span>
        <span className="chip">{clock}</span>
        <button className="chip logout" onClick={quit} title="退出登录">⏻</button>
      </header>
      <main>
        <section className="left pane">
          <Threads current={thread} refreshKey={refreshKey}
            onSelect={setThread} onNew={() => setThread(newThreadId())}
            onExpired={onLogout} />
          <div className="sidefoot">
            <div className="minireactor"><MossMini busy={busy} /></div>
            <div className="sf-lines">
              <div>{busy ? 'MOSS · 扫描中' : 'MOSS · 待命'}</div>
              <div>{geo ? '浏览器定位' : dash?.place ? 'IP 定位' : '未定位'}</div>
            </div>
          </div>
        </section>
        <Chat threadId={thread} location={geo} onBusy={setBusy}
          onTurnDone={() => setRefreshKey(k => k + 1)} onExpired={onLogout} />
        <Panels refreshKey={refreshKey} onData={setDash} onExpired={onLogout} />
      </main>
    </div>
  )
}
