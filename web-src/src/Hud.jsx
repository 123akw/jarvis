import { useEffect, useState } from 'react'
import { logout } from './api.js'
import Chat from './Chat.jsx'
import Panels from './Panels.jsx'
import Reactor3D from './Reactor3D.jsx'

export default function Hud({ onLogout }) {
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [dash, setDash] = useState(null)
  const [clock, setClock] = useState('')

  useEffect(() => {
    const t = setInterval(() =>
      setClock(new Date().toLocaleTimeString('zh-CN', { hour12: false })), 1000)
    return () => clearInterval(t)
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
        <span className="tagline">JUST A RATHER VERY INTELLIGENT SYSTEM · 私人管家</span>
        <span className="spacer" />
        <span className="chip">{dash?.model ?? '—'}</span>
        <span className="chip online"><span className="dot" />在线</span>
        <span className="chip">{clock}</span>
        <button className="chip logout" onClick={quit} title="退出登录">⏻</button>
      </header>
      <main>
        <section className="left">
          <div className="pane reactor-pane">
            <div className="reactor-box">
              <Reactor3D busy={busy} dust={false} />
            </div>
            <div className={`reactor-label${busy ? ' busy-label' : ''}`}>
              {busy ? '运算中' : '待命中'}
            </div>
          </div>
          <div className="pane readouts">
            <div className="eyebrow">系统读数</div>
            <dl>
              <div><dt>核心模型</dt><dd>{dash?.model ?? '—'}</dd></div>
              <div><dt>版本</dt><dd>v{dash?.version ?? '—'}</dd></div>
              <div><dt>在线时长</dt><dd>{dash ? `${dash.uptime_min} 分钟` : '—'}</dd></div>
              <div><dt>本次会话</dt><dd>{dash ? `${dash.chats} 轮` : '—'}</dd></div>
              <div><dt>记忆引擎</dt><dd>SQLite</dd></div>
              <div><dt>工具阵列</dt><dd>13 项</dd></div>
            </dl>
          </div>
        </section>
        <Chat onBusy={setBusy} onTurnDone={() => setRefreshKey(k => k + 1)} onExpired={onLogout} />
        <Panels refreshKey={refreshKey} onData={setDash} onExpired={onLogout} />
      </main>
    </div>
  )
}
