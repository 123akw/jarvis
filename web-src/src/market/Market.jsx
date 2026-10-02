import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { login, logout } from '../api.js'
import Icon from '../Icon.jsx'
import Presence from '../Presence.jsx'
import { navigate } from '../routes.js'
import { applyTheme, currentTheme } from '../theme.js'
import { getCatalog, marketSignup, recommend } from './api.js'
import Brand from './Brand.jsx'
import Gate from './Gate.jsx'
import Hero from './Hero.jsx'
import { clearDraft, emptyDraft, loadDraft, loginPath, normalizeCatalog, normalizeRecommendation, saveDraft } from './model.js'
import Recommend from './Recommend.jsx'
import Result from './Result.jsx'
import Skills from './Skills.jsx'
import Toolbox from './Toolbox.jsx'
import './market.css'

/*
 * 智能体市场（/market）：插件市场（顶部一句话 +「帮我推荐」）→ 起名字 → 生成 → 结果页。
 * 每次生成 = 开一套独立账号（POST /api/market/signup，不登录当前浏览器）；结果页的主角是只显示一次的
 * 账号与口令，「去登录」回到登录页并用 ?u= 预填账号，登录后就是按所选插件组装的智能体。
 * 选择状态存 sessionStorage（刷新不丢），口令只活在内存里。契约见 docs/proposals/2026-10-round13-platform.md。
 */

const FLOW_STEPS = [{ id: 'market', label: '挑插件' }, { id: 'brand', label: '起名字' }]
// 生成与推荐至少停留一小会儿：太快一闪而过反而像出错（测试环境不等）
const MIN_WAIT = import.meta.env?.MODE === 'test' ? 0 : 650
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function Account({ me }) {
  if (!me) return <span />
  const name = me.username || '已登录'
  return (
    <span className="jvm-account" title={`已登录：${name}`} aria-label={`已登录：${name}`}>
      <i aria-hidden="true">{name.trim().slice(0, 1).toUpperCase() || '·'}</i>
      <span>{name}</span>
    </span>
  )
}

function Progress({ step, onGo }) {
  return (
    <nav className="jvm-progress" aria-label="进度">
      <ol>
        {FLOW_STEPS.map((s, i) => (
          <li key={s.id}>
            <button type="button" aria-current={step === s.id ? 'step' : undefined} onClick={() => onGo(s.id)}>
              <b aria-hidden="true">{i + 1}</b><span>{s.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

function CatalogPending({ state, onRetry }) {
  if (state.status === 'error') {
    return (
      <div className="jvm-empty" role="alert">
        <p>市场暂时打不开：{state.error}</p>
        <button type="button" className="jvm-btn" onClick={onRetry}>再试一次</button>
      </div>
    )
  }
  return (
    <div className="jvm-empty" role="status" aria-label="正在打开市场">
      <div className="jvm-skel is-cards" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
    </div>
  )
}

export default function Market({ session, onAuthed }) {
  const [draft, setDraft] = useState(loadDraft)
  const [catalog, setCatalog] = useState({ status: 'loading', data: null, error: '' })
  const [rec, setRec] = useState({ status: 'idle', error: '', retry: null })
  const [secret, setSecret] = useState(null)        // { username, password }：只在内存，离开结果页即清掉
  const [gate, setGate] = useState(null)            // { mode: 'closed' | 'invite', message }
  const [busy, setBusy] = useState(false)
  const [genError, setGenError] = useState('')
  const [adminSession, setAdminSession] = useState(null)   // 拦路口里管理员登录后的会话（不改 App 的会话）
  const scrollRef = useRef(null)
  const recSeq = useRef(0)
  const firstStep = useRef(true)
  const appSession = session && typeof session === 'object' ? session : null
  const me = adminSession || appSession
  const step = draft.step
  const data = catalog.data

  useEffect(() => { try { applyTheme(currentTheme()) } catch { /* 存储不可读：保持默认暗色 */ } }, [])
  useEffect(() => { saveDraft(draft) }, [draft])

  const loadCatalog = useCallback(() => {
    setCatalog(c => ({ ...c, status: 'loading', error: '' }))
    getCatalog()
      .then(raw => setCatalog({ status: 'ok', data: normalizeCatalog(raw), error: '' }))
      .catch(e => setCatalog({ status: 'error', data: null, error: e.message }))
  }, [])
  useEffect(() => { loadCatalog() }, [loadCatalog])

  // 换步骤：回到顶部，焦点落到新标题（读屏读出这一步）；初次渲染不抢焦点
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 })
    if (step !== 'done') setSecret(null)
    if (firstStep.current) { firstStep.current = false; return }
    if (step === 'done') return
    document.getElementById(step === 'market' ? 'jvm-hero-title' : 'jvm-step-title')?.focus({ preventScroll: true })
  }, [step])

  const byId = useMemo(() => new Map((data?.plugins || []).map(p => [p.id, p])), [data])
  const pickedPlugins = draft.picked.map(id => byId.get(id)).filter(Boolean)
  const profession = data?.professions.find(p => p.id === draft.profession) || null

  const go = next => { setGenError(''); setDraft(d => ({ ...d, step: next })) }
  const toggle = id => setDraft(d => ({
    ...d, picked: d.picked.includes(id) ? d.picked.filter(x => x !== id) : [...d.picked, id],
  }))
  const addAll = ids => setDraft(d => ({ ...d, picked: [...new Set([...d.picked, ...ids])] }))

  async function runRecommend(params) {
    const seq = ++recSeq.current
    const retry = () => runRecommend(params)
    setRec({ status: 'loading', error: '', retry })
    try {
      const [raw] = await Promise.all([recommend(params), wait(MIN_WAIT)])
      if (seq !== recSeq.current) return
      setDraft(d => ({ ...d, recommendation: normalizeRecommendation(raw) }))
      setRec({ status: 'idle', error: '', retry: null })
    } catch (e) {
      if (seq !== recSeq.current) return
      setRec({ status: 'error', error: e.message, retry })
    }
  }
  const pickProfession = id => {
    setDraft(d => ({ ...d, profession: id }))
    runRecommend({ profession: id })
  }
  const describe = () => runRecommend({ profession: draft.profession || undefined, description: draft.description.trim() })

  function platformIn() {
    const b = draft.brand
    const body = { name: b.name.trim(), icon: b.icon, accent: b.accent, plugins: draft.picked.filter(id => byId.has(id)) }
    if (b.tagline.trim()) body.tagline = b.tagline.trim()
    if (draft.profession) body.profession = draft.profession
    return body
  }
  const canGenerate = pickedPlugins.length > 0 && draft.brand.name.trim().length > 0

  async function generate({ invite = '', as = me, inGate = false } = {}) {
    if (!data || !canGenerate) return
    setGenError('')
    // 游客：注册关闭 / 要邀请码时先拦一下；已登录（Owner 帮客户开号）直接生成，权限由服务端判
    if (!as && !invite && !inGate && data.signup !== 'open') {
      setGate({ mode: data.signup === 'invite' ? 'invite' : 'closed', message: '' })
      return
    }
    setBusy(true)
    try {
      const [r] = await Promise.all([marketSignup(platformIn(), invite), wait(MIN_WAIT)])
      const platform = r?.platform && typeof r.platform === 'object' ? r.platform : { ...platformIn() }
      const username = typeof r?.username === 'string' ? r.username : ''
      if (!Array.isArray(platform.plugins)) platform.plugins = platformIn().plugins
      setSecret(username && r?.password ? { username, password: String(r.password) } : null)
      setGate(null)
      setDraft(d => ({ ...emptyDraft(), brand: d.brand, step: 'done', done: { platform, username } }))
    } catch (e) {
      let message = e.message
      if (e.status === 403 && as) {
        message = /[一-龥]/.test(e.message) && e.message !== '这一步暂时没有权限'
          ? e.message : '这个账号不能在市场里开新账号，请让管理员来操作'
      }
      if (inGate || (e.status === 403 && !as)) {
        setGate(g => ({ mode: g?.mode || (data.signup === 'invite' ? 'invite' : 'closed'), message }))
      } else setGenError(message)
    } finally {
      setBusy(false)
    }
  }

  async function gateLogin(username, password) {
    setBusy(true)
    setGate(g => ({ ...g, message: '' }))
    let s = null
    try { s = await login(username, password) } catch { s = null }
    setBusy(false)
    if (!s?.authed) {
      setGate(g => ({ ...g, message: '用户名或口令不对，再试一次' }))
      return
    }
    setAdminSession(s)
    await generate({ as: s, inGate: true })
  }

  // 去登录：App 里已登录的先退出（否则回到首页还是当前账号）；拦路口里临时登录的管理员不动 App 会话
  async function goLogin() {
    const to = loginPath(secret?.username || draft.done?.username || '')
    setSecret(null)
    if (appSession) {
      try { await logout() } catch { /* 会话已失效也照样去登录页 */ }
      onAuthed?.(false)
    }
    navigate(to)
  }
  function goHome() {
    setSecret(null)
    navigate('/')
  }
  function reset() {
    setSecret(null)
    setGenError('')
    clearDraft()
    setDraft(emptyDraft())
  }

  const inFlow = step === 'market' || step === 'brand'
  const accent = step === 'brand' ? draft.brand.accent : step === 'done' ? draft.done?.platform?.accent : ''
  let dock = null
  if (inFlow && data) {
    const action = step === 'brand'
      ? { label: busy ? '正在生成…' : '生成我的智能体', onClick: () => generate(), disabled: busy || !canGenerate }
      : { label: '下一步', onClick: () => go('brand'), disabled: !pickedPlugins.length }
    const hint = step !== 'brand' ? ''
      : genError || (!pickedPlugins.length ? '至少选一个插件才能生成' : !draft.brand.name.trim() ? '给智能体起个名字就能生成' : '')
    dock = <Toolbox plugins={pickedPlugins} onRemove={toggle} action={action} hint={hint} />
  }
  const installed = (Array.isArray(draft.done?.platform?.plugins) ? draft.done.platform.plugins : [])
    .map(id => byId.get(id)).filter(Boolean)

  return (
    <div className={`jvm is-${step}${inFlow ? ' in-flow' : ''}`} ref={scrollRef}
      style={accent ? { '--jvm-glow': accent } : undefined}>
      <div className="jvm-ambient" aria-hidden="true"><i /></div>
      <header className="jvm-top">
        {step === 'brand' ? (
          <button type="button" className="jvm-back" onClick={() => go('market')} aria-label="回到插件市场">
            <Icon name="chevron" size={18} />
          </button>
        ) : (
          <span className="jvm-wordmark">J.A.R.V.I.S.<span>智能体工坊</span></span>
        )}
        {step === 'brand' ? <Progress step={step} onGo={go} /> : null}
        <Account me={me} />
      </header>

      <main className="jvm-main" key={step}>
        {step === 'done' && draft.done ? (
          <Result platform={draft.done.platform} plugins={installed} secret={secret} username={draft.done.username}
            signedIn={!!appSession} onLogin={goLogin} onHome={goHome} onReset={reset} />
        ) : step === 'brand' && data ? (
          <Brand brand={draft.brand} accents={data.accents} profession={profession} plugins={pickedPlugins}
            onBrand={brand => setDraft(d => ({ ...d, brand }))} />
        ) : (
          <>
            <Hero catalog={data} />
            {data ? (
              <div className="jvm-market">
                <Recommend catalog={data} draft={draft} recState={rec} onPickProfession={pickProfession}
                  onDescription={description => setDraft(d => ({ ...d, description }))} onDescribe={describe}
                  onToggle={toggle} onAddAll={addAll} />
                <Skills catalog={data} picked={draft.picked} onToggle={toggle} authed={!!me} />
              </div>
            ) : <CatalogPending state={catalog} onRetry={loadCatalog} />}
          </>
        )}
      </main>

      {dock}

      {busy && !gate ? (
        <div className="jvm-forging" role="status" aria-live="assertive">
          <Presence size={120} state="thinking" decorative />
          <p>正在生成「{draft.brand.name.trim() || '你的智能体'}」…</p>
          <span>装插件、开账号</span>
        </div>
      ) : null}

      {gate ? (
        <Gate key={gate.mode} mode={gate.mode} message={gate.message} busy={busy} onClose={() => setGate(null)}
          onInvite={code => generate({ invite: code, inGate: true })} onLogin={gateLogin} />
      ) : null}
    </div>
  )
}
