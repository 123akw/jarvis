import { useEffect, useRef, useState } from 'react'
import { login, logout } from '../api.js'
import Icon from '../Icon.jsx'
import Presence, { prefersReducedMotion } from '../Presence.jsx'
import { navigate } from '../routes.js'
import { applyTheme, currentTheme } from '../theme.js'
import { InstallSheet } from './InstallGuide.jsx'
import { getPublicPlatform } from './platform.js'
import { useInstallPrompt, usePlatformTheme, usePwaHead } from './usePlatform.js'
import './platform.css'

function greeting(now = new Date()) {
  const h = now.getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

const fmtDate = d => d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  + ' · ' + d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })

/** 日期时钟：按分钟对齐刷新 */
function Clock({ className }) {
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

/** 分享链接里的 ?u=<用户名>：市场生成平台时带上，打开就预填 */
function presetUser() {
  try {
    return (new URLSearchParams(window.location.search).get('u') || '').trim().slice(0, 64)
  } catch {
    return ''
  }
}

const orbSize = () => (typeof window !== 'undefined' && window.innerWidth <= 900 ? 96 : 160)

/** 品牌化登录卡：与贾维斯登录页同一种形式（身份验证 · 用户名 · 口令 · 按钮），登录走 api.js 的 login */
function LoginCard({ name, onAuthed }) {
  const preset = useRef(presetUser()).current
  const [u, setU] = useState(preset)
  const [p, setP] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [shaking, setShaking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const userRef = useRef(null)
  const passRef = useRef(null)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function submit(e) {
    e.preventDefault()
    if (busy || leaving) return
    const user = (userRef.current?.value ?? u).trim()
    const pass = passRef.current?.value ?? p
    if (!user || !pass) {
      setHint(!user ? '请输入用户名' : '请输入口令')
      ;(!user ? userRef : passRef).current?.focus()
      return
    }
    setBusy(true)
    let session = null
    try { session = await login(user, pass) } catch { session = null }
    setBusy(false)
    setP('')
    if (!session) {
      setHint('用户名或口令不对，再试一次')
      setShaking(true)
      passRef.current?.focus()
      return
    }
    // 卡片先退，再进主应用（主应用按这个账号的平台定制）
    setLeaving(true)
    timer.current = setTimeout(() => { onAuthed?.(session); navigate('/') }, prefersReducedMotion() ? 0 : 320)
  }

  return (
    <form className={`pfe-card${shaking ? ' shake' : ''}${leaving ? ' leaving' : ''}`} onSubmit={submit} aria-label={`登录${name}`}
      onAnimationEnd={e => { if (e.target === e.currentTarget) setShaking(false) }}>
      <div className="pfe-card-title">身份验证</div>
      <label className="pfe-field">
        <span>用户名</span>
        <input ref={userRef} value={u} onChange={e => { setU(e.target.value); setHint('') }}
          autoComplete="username" autoCapitalize="off" spellCheck={false} autoFocus={!preset} />
      </label>
      <label className="pfe-field">
        <span>口令</span>
        <input ref={passRef} type="password" value={p} onChange={e => { setP(e.target.value); setHint('') }}
          autoComplete="current-password" autoFocus={Boolean(preset)} />
      </label>
      <button className="pfe-btn" disabled={busy || leaving}>
        {leaving ? '正在进入…' : busy ? '验证中…' : '登录'}
      </button>
      <div className={`pfe-hint${hint ? ' show' : ''}`} aria-live="polite">{hint}</div>
    </form>
  )
}

/** 已登录：直接进去；不是自己就退出换号 */
function SignedIn({ session, onAuthed }) {
  const [busy, setBusy] = useState(false)
  async function switchAccount() {
    setBusy(true)
    try { await logout() } catch { /* 本地照样回到登录卡 */ }
    onAuthed?.(false)
  }
  const name = session.username || ''
  return (
    <div className="pfe-card">
      <div className="pfe-card-title">已登录</div>
      <div className="pfe-who">
        <span className="avatar lg" aria-hidden="true">{name.slice(0, 1).toUpperCase() || '·'}</span>
        <span className="pfe-who-name">{name}</span>
      </div>
      <button type="button" className="pfe-btn" onClick={() => navigate('/')}>进入我的智能体</button>
      <button type="button" className="pfe-link" onClick={() => void switchAccount()} disabled={busy}>换个账号登录</button>
    </div>
  )
}

/**
 * /p/<slug>：某个平台的入口。手机扫平台二维码落到这里——平台名、图标、主题色的登录页，登录后进入这个账号的平台；
 * 页面同时把自己声明成可装到主屏的 App（manifest、主屏图标、状态栏色、service worker）。
 * session：null=检查中、false=游客、对象=已登录（见 App.jsx）。
 */
export default function PlatformEntry({ slug, session, onAuthed }) {
  const [brand, setBrand] = useState(null)
  const [state, setState] = useState('loading')   // loading | ok | missing | error
  const [retry, setRetry] = useState(0)
  const [guide, setGuide] = useState(false)
  const install = useInstallPrompt()

  useEffect(() => { applyTheme(currentTheme()) }, [])
  useEffect(() => {
    let alive = true
    setState('loading')
    getPublicPlatform(slug)
      .then(b => { if (!alive) return; setBrand(b); setState(b?.name ? 'ok' : 'missing') })
      .catch(e => { if (alive) setState(e?.status === 404 ? 'missing' : 'error') })
    return () => { alive = false }
  }, [slug, retry])

  const ok = state === 'ok'
  usePlatformTheme(ok ? brand.accent : null)
  usePwaHead(ok ? { slug: brand.slug || slug, name: brand.name, accent: brand.accent } : null)

  if (state === 'missing' || state === 'error') {
    const missing = state === 'missing'
    return (
      <div className="pfe pfe--missing">
        <div className="pfe-ambient" aria-hidden="true"><i className="pfe-glow" /><i className="pfe-grain" /></div>
        <main className="pfe-lost">
          <Presence state="idle" size={96} quality="css" decorative />
          <h1 className="pfe-lost-title">{missing ? '没有找到这个智能体' : '暂时打不开'}</h1>
          <p className="pfe-lost-text">
            {missing ? '链接可能输错了，或者它已经改名。可以找分享给你的人再要一次。' : '网络好像不太稳，稍后再试一次。'}
          </p>
          <div className="pfe-lost-actions">
            {missing
              ? <button type="button" className="pfe-btn" onClick={() => navigate('/market')}>去智能体市场</button>
              : <button type="button" className="pfe-btn" onClick={() => setRetry(n => n + 1)}>重试</button>}
            <button type="button" className="pfe-link" onClick={() => navigate('/')}>回到首页</button>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className={`pfe${ok ? ' is-ready' : ''}`}>
      <div className="pfe-ambient" aria-hidden="true"><i className="pfe-glow" /><i className="pfe-grain" /></div>
      {ok ? (
        <>
          <header className="pfe-top"><span className="pfe-powered">由贾维斯驱动</span></header>
          <main className="pfe-main">
            <section className="pfe-greet">
              <div className="pfe-orb pf-orb"><Presence state="idle" size={orbSize()} quality="css" decorative /></div>
              <div className="pfe-eyebrow"><span className="pf-tile sm" aria-hidden="true">{brand.icon || '✨'}</span>{brand.name}</div>
              <h1 className="pfe-h1">{greeting()}。</h1>
              <Clock className="pfe-date" />
              {brand.tagline ? <p className="pfe-tagline">{brand.tagline}</p> : null}
            </section>
            <div className="pfe-card-wrap">
              {session === null ? <div className="pfe-card pfe-card--wait" aria-hidden="true" />
                : session ? <SignedIn session={session} onAuthed={onAuthed} />
                  : <LoginCard name={brand.name} onAuthed={onAuthed} />}
              <button type="button" className="pfe-install" onClick={() => setGuide(true)}>
                <Icon name="addbox" size={16} />装到手机主屏
              </button>
            </div>
          </main>
          {guide ? <InstallSheet onInstall={install} onClose={() => setGuide(false)} /> : null}
        </>
      ) : null}
    </div>
  )
}
