import { lazy, Suspense, useEffect, useState } from 'react'
import { logout } from './api.js'
import Chat from './Chat.jsx'

// three.js 相关组件懒加载：主 bundle 不再背着 3D 引擎
const MossMini = lazy(() => import('./Moss.jsx').then(m => ({ default: m.MossMini })))
import Panels from './Panels.jsx'
import Threads from './Threads.jsx'
import WeChatConnect from './WeChatConnect.jsx'
import AccountSettings from './AccountSettings.jsx'
import ProviderSettings from './ProviderSettings.jsx'
import DesktopHandoff from './DesktopHandoff.jsx'
import MemoryPanel from './MemoryPanel.jsx'
import Reminders from './Reminders.jsx'
import { applyTheme, currentTheme, toggleTheme } from './theme.js'

function newThreadId() {
  return 't-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10))
}

const isNarrow = () => window.innerWidth <= 1180

export default function Hud({ session, onLogout }) {
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [dash, setDash] = useState(null)
  const [clock, setClock] = useState('')
  const [geo, setGeo] = useState(null)
  const [thread, setThread] = useState(() => localStorage.getItem('jws_thread') || 'web')
  const [leftOpen, setLeftOpen] = useState(() => !isNarrow())
  const [rightOpen, setRightOpen] = useState(() => !isNarrow())
  const [wxOpen, setWxOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [theme, setTheme] = useState(currentTheme)

  useEffect(() => {
    applyTheme(theme)
    return () => applyTheme('dark')   // 退出 HUD（登出）回到暗色登录页
  }, [theme])

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
    try { await logout() } catch { /* local state still fails closed */ } finally { onLogout() }
  }

  function selectThread(id) {
    setThread(id)
    if (isNarrow()) setLeftOpen(false)  // 窄屏选完会话自动收抽屉
  }

  return (
    <div className="hud">
      <div className="sweep" /><div className="grain" />
      <header>
        <button className={`chip navbtn${leftOpen ? ' on' : ''}`}
          onClick={() => setLeftOpen(v => !v)} title="会话历史">☰</button>
        <span className="wordmark">J.A.R.V.I.S.</span>
        <span className="tagline">私人管家 · v{dash?.version ?? '—'}</span>
        <span className="spacer" />
        <button className="chip navbtn account-chip" onClick={() => setAccountOpen(true)} aria-label="账户设置"><span>{session?.username || '账号'}{session?.role ? ` · ${session.role}` : ''}</span></button>
        <button className="chip navbtn" onClick={() => setMemoryOpen(true)} aria-label="记忆" title="贾维斯记住了什么">◉ 记忆</button>
        <button className="chip navbtn" onClick={() => setProviderOpen(true)} aria-label="API 设置" title="模型与联网 API 设置">⚙ API</button>
        <DesktopHandoff />
        <span className="chip hide-sm">{dash?.model ?? '—'}</span>
        <span className="chip online hide-sm"><span className="dot" />{dash?.place || '在线'}</span>
        <span className="chip hide-sm">{clock}</span>
        {session?.role === 'Owner' ? <button className="chip navbtn wxnav" aria-label="接入个人微信"
          onClick={() => setWxOpen(true)} title="接入个人微信">微信</button> : null}
        <button className="chip navbtn" onClick={() => setTheme(toggleTheme())}
          title={theme === 'light' ? '切换到暗色' : '切换到亮色'} aria-label="切换主题">{theme === 'light' ? '☾' : '☀'}</button>
        <button className={`chip navbtn${rightOpen ? ' on' : ''}`}
          onClick={() => setRightOpen(v => !v)} title="日程 / 待办 / 备忘">▦</button>
        <button className="chip logout" onClick={quit} title="退出登录">⏻</button>
      </header>
      <Reminders onExpired={onLogout} />
      <main className={`${leftOpen ? '' : 'hide-left'} ${rightOpen ? '' : 'hide-right'}`}>
        <section className={`left pane${leftOpen ? ' open' : ''}`}>
          <Threads current={thread} refreshKey={refreshKey}
            onSelect={selectThread} onNew={() => selectThread(newThreadId())}
            onExpired={onLogout} />
          <div className="sidefoot">
            <div className="minireactor"><Suspense fallback={null}><MossMini busy={busy} /></Suspense></div>
            <div className="sf-lines">
              <div>{busy ? 'MOSS · 扫描中' : 'MOSS · 待命'}</div>
              <div>{geo ? '浏览器定位' : dash?.place ? 'IP 定位' : '未定位'}</div>
            </div>
          </div>
        </section>
        <Chat threadId={thread} location={geo} onBusy={setBusy}
          onTurnDone={() => setRefreshKey(k => k + 1)} onExpired={onLogout} />
        <section className={`right${rightOpen ? ' open' : ''}`}>
          <Panels refreshKey={refreshKey} onData={setDash} onExpired={onLogout} />
        </section>
        {(leftOpen || rightOpen) && (
          <div className="drawer-backdrop"
            onClick={() => { setLeftOpen(false); setRightOpen(false) }} />
        )}
      </main>
      {wxOpen ? (
        <WeChatConnect onClose={() => setWxOpen(false)} onExpired={onLogout} />
      ) : null}
      {memoryOpen ? <MemoryPanel onClose={() => setMemoryOpen(false)} onExpired={onLogout} /> : null}
      {accountOpen ? <div className="wx-backdrop"><AccountSettings session={session} onClose={() => setAccountOpen(false)} onReauth={onLogout} /></div> : null}
      {providerOpen ? <div className="wx-backdrop"><ProviderSettings session={session} onClose={() => setProviderOpen(false)} onExpired={onLogout} onApplied={() => setRefreshKey(key => key + 1)} /></div> : null}
    </div>
  )
}
