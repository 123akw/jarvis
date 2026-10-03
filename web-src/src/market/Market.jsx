import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { login, logout } from '../api.js'
import Icon from '../Icon.jsx'
import Presence, { prefersReducedMotion } from '../Presence.jsx'
import { startTour, useTour } from '../tour/index.jsx'
import { APP_PATH, loginHref, navigate } from '../routes.js'
import { applyTheme, currentTheme } from '../theme.js'
import { getCatalog, marketSignup, previewSourcePlugin, recommend } from './api.js'
import Brand from './Brand.jsx'
import Catalog, { NO_FILTERS } from './Catalog.jsx'
import { DndRoot } from './dnd/index.jsx'
import Featured from './Featured.jsx'
import Gate from './Gate.jsx'
import Hero from './Hero.jsx'
import PluginAdmin from './PluginAdmin.jsx'
import { detailHref } from './PluginCard.jsx'
import PluginDetail from './PluginDetail.jsx'
import {
  blockReason, bundlesFrom, clearDraft, emptyDraft, loadDraft, loginPath, normalizeCatalog, normalizeRecommendation, saveDraft,
} from './model.js'
import RecommendPanel from './Recommend.jsx'
import Result from './Result.jsx'
import Toolbox from './Toolbox.jsx'
import { AccountArea, SearchBox, Wordmark, useSearchHotkeys } from './TopBar.jsx'
import './market.css'

/*
 * 智能体市场（主域名首页 /，旧链接 /market）。第十七轮去冗余：首屏只有一句话 + 大搜索框（兼做「一句话帮我推荐」）
 * + 一行职业小标签 → 吸顶的分类页签（来源 / 类型收进「筛选」）→ 精选一行 → 紧凑列表行的目录 → 插件详情
 * （?plugin=<id>，可分享、可后退）→ 工具箱（卡片可直接拖进去，见 dnd/）→ 起名字 → 生成 → 结果页。
 * 管理员的「插件管理」在头像菜单里。
 * 每次生成 = 开一套独立账号（POST /api/market/signup，不登录当前浏览器）；结果页的主角是只显示一次的
 * 账号与口令，「去登录」去登录页并用 ?u= 预填账号，登录后就是按所选插件组装的智能体。
 * 选择状态存 sessionStorage（刷新不丢），口令只活在内存里。契约见 docs/proposals/2026-10-round15-market.md、
 * docs/proposals/2026-10-round17-market.md。
 */

const FLOW_STEPS = [{ id: 'market', label: '挑插件' }, { id: 'brand', label: '起名字' }]
// 生成与推荐至少停留一小会儿：太快一闪而过反而像出错（测试环境不等）
const MIN_WAIT = import.meta.env?.MODE === 'test' ? 0 : 650
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const readDetail = () => {
  try { return new URLSearchParams(window.location.search).get('plugin') || '' } catch { return '' }
}
const smooth = () => (prefersReducedMotion() ? 'auto' : 'smooth')

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

/** 目录加载中：页签与列表的骨架；出错：说人话 + 重试 */
function CatalogPending({ state, onRetry }) {
  if (state.status === 'error') {
    return (
      <div className="jvm-none" role="alert">
        <span className="jvm-none-icon" aria-hidden="true">📡</span>
        <p className="jvm-none-title">市场暂时打不开</p>
        <p className="jvm-none-sub">{state.error}</p>
        <div className="jvm-none-actions"><button type="button" className="jvm-btn" onClick={onRetry}>再试一次</button></div>
      </div>
    )
  }
  return (
    <div className="jvm-pending" role="status" aria-label="正在打开市场">
      <div className="jvm-skel is-chips" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <div className="jvm-skel is-bundles" aria-hidden="true"><i /><i /><i /><i /></div>
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
  const [sources, setSources] = useState([])               // 插件源（仅 Owner 拉得到）：来源筛选里每个源一项
  const [sourcePreview, setSourcePreview] = useState(null) // 插件源里点「安装」→ 交给插件管理弹窗出预览
  const [adminReq, setAdminReq] = useState(null)           // 头像菜单「插件管理」→ 打开插件管理弹窗
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState(NO_FILTERS)
  const [recOpen, setRecOpen] = useState(false)            // 推荐面板按需展开（推荐时打开，可收起）
  const [recBasis, setRecBasis] = useState('')             // 面板上一行「按什么推荐的」
  const [heroSearch, setHeroSearch] = useState(true)       // 首屏搜索框还在视野里吗：滚走了顶栏才出小搜索
  const [detailId, setDetailId] = useState(readDetail)     // ?plugin=<id>
  const [toast, setToast] = useState('')
  const scrollRef = useRef(null)
  const searchRef = useRef(null)      // 首屏大搜索框
  const topSearchRef = useRef(null)   // 顶栏小搜索框（宽屏，首屏搜索框滚走后）
  const heroSearchRef = useRef(null)
  const recSeq = useRef(0)
  const firstStep = useRef(true)
  const toastTimer = useRef(0)
  const appSession = session && typeof session === 'object' ? session : null
  const me = adminSession || appSession
  const checking = session === null && !adminSession
  const step = draft.step
  const data = catalog.data
  const isOwner = me?.role === 'Owner'
  const q = query.trim()

  useEffect(() => { try { applyTheme(currentTheme()) } catch { /* 存储不可读：保持默认暗色 */ } }, [])
  useEffect(() => { saveDraft(draft) }, [draft])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const loadCatalog = useCallback(({ quiet = false } = {}) => {
    if (!quiet) setCatalog(c => ({ ...c, status: 'loading', error: '' }))
    getCatalog()
      .then(raw => setCatalog({ status: 'ok', data: normalizeCatalog(raw), error: '' }))
      .catch(e => setCatalog({ status: 'error', data: null, error: e.message }))
  }, [])
  useEffect(() => { loadCatalog() }, [loadCatalog])

  // 首屏搜索框滚出视野 → 顶栏出现小搜索（宽屏）/ 搜索按钮（手机）；不支持 IntersectionObserver 时一直当它在
  const hasHero = step === 'market'
  useEffect(() => {
    const el = heroSearchRef.current
    if (!hasHero || !el || typeof IntersectionObserver !== 'function') { setHeroSearch(true); return undefined }
    const io = new IntersectionObserver(([e]) => setHeroSearch(e.isIntersecting),
      { root: scrollRef.current, rootMargin: '-64px 0px 0px 0px', threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [hasHero])

  // 浏览器后退 / 前进：详情跟着地址栏的 ?plugin= 开关
  useEffect(() => {
    const sync = () => setDetailId(readDetail())
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

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
  const bundles = useMemo(() => bundlesFrom(data), [data])

  const say = text => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }
  const go = next => { setGenError(''); setDraft(d => ({ ...d, step: next })) }
  const toggle = id => setDraft(d => ({
    ...d, picked: d.picked.includes(id) ? d.picked.filter(x => x !== id) : [...d.picked, id],
  }))
  const addAll = ids => setDraft(d => ({ ...d, picked: [...new Set([...d.picked, ...ids])] }))
  const addBundle = b => {
    const fresh = b.ids.filter(id => !draft.picked.includes(id)).length
    // 套装即职业预设：还没选职业时顺手记上，生成的智能体用这个职业的开场白与快捷问题
    setDraft(d => ({ ...d, picked: [...new Set([...d.picked, ...b.ids])], profession: d.profession || b.profession }))
    say(`已把「${b.title}」的 ${fresh} 个插件放进工具箱`)
  }
  const move = (id, dir) => setDraft(d => {
    const ids = d.picked.filter(x => byId.has(x))
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return d
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    return { ...d, picked: [...ids, ...d.picked.filter(x => !byId.has(x))] }
  })
  const clearPicked = () => setDraft(d => ({ ...d, picked: [] }))
  /** 工具箱里拖动排序：from / to 是工具箱里（有效插件）的下标 */
  const reorder = (from, to) => setDraft(d => {
    const ids = d.picked.filter(x => byId.has(x))
    if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return d
    const [it] = ids.splice(from, 1)
    ids.splice(to, 0, it)
    return { ...d, picked: [...ids, ...d.picked.filter(x => !byId.has(x))] }
  })
  const remove = id => setDraft(d => ({ ...d, picked: d.picked.filter(x => x !== id) }))
  /** 能不能放进工具箱：需要配置 / 暂不可用给原因；已经在里面时返回「已在工具箱」（Dock 显示成灰色的「已在」态）；能加返回 '' */
  const canAdd = id => {
    const p = byId.get(id)
    if (!p) return '插件不存在'
    const blocked = blockReason(p)
    if (blocked) return p.status === 'needs_config' ? `需要管理员先配置：${blocked}` : `暂不可用：${blocked}`
    return draft.picked.includes(id) ? '已在工具箱里了' : ''
  }
  /** 拖进工具箱 / 工具箱里撤销移除（去重追加；撤销后 dnd 会再调 onReorder 挪回原位）。
   *  整套拖进来（meta.kind === 'bundle'）按套装加，顺手记上职业；不能加的跳过 */
  const dropAdd = (ids, meta = null) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(id => byId.has(id) && !blockReason(byId.get(id)))
    if (!list.length) return
    const bid = meta?.kind === 'bundle' ? String(meta.id || '').replace(/^bundle:/, '') : ''
    const bundle = bid ? bundles.find(b => b.id === bid) : null
    if (bundle) {
      setDraft(d => ({ ...d, picked: [...new Set([...d.picked, ...list])], profession: d.profession || bundle.profession }))
      say(`已把「${bundle.title}」的 ${list.filter(id => !draft.picked.includes(id)).length} 个插件放进工具箱`)
    } else addAll(list)
  }

  // ---- 插件详情：?plugin=<id> 进历史栈，后退即关闭；从同类推荐里换一个用 replace，不越堆越深 ----
  function openDetail(id, { replace = false } = {}) {
    const url = detailHref(id)
    try {
      if (replace || readDetail()) window.history.replaceState(window.history.state, '', url)
      else window.history.pushState({ jvmDetail: true }, '', url)
    } catch { /* 地址栏改不了也照常打开 */ }
    setDetailId(id)
  }
  function closeDetail() {
    if (window.history.state?.jvmDetail) {
      window.history.back()   // popstate 会把 detailId 清掉
      return
    }
    // 从分享链接直接进来的：没有可退的上一页，就地去掉参数
    try {
      const params = new URLSearchParams(window.location.search)
      params.delete('plugin')
      const qs = params.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
    } catch { /* 同上 */ }
    setDetailId('')
  }

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
  /** 推荐面板展开并滚进视野（首屏下方） */
  function showRec() {
    setRecOpen(true)
    requestAnimationFrame(() => document.getElementById('jvm-helper')?.scrollIntoView?.({ block: 'nearest', behavior: smooth() }))
  }
  const pickProfession = id => {
    setDraft(d => ({ ...d, profession: id }))
    setRecBasis(`按职业：${data?.professions.find(p => p.id === id)?.name || id}`)
    runRecommend({ profession: id })
    showRec()
  }

  // ---- 首屏搜索：回车看结果；「AI 推荐」/ 搜不到 / 详情里的示例 → 按这句话推荐 ----
  function browse() {
    const el = document.getElementById('jvm-catalog')
    el?.scrollIntoView?.({ block: 'start', behavior: smooth() })
    document.getElementById('jvm-catalog-title')?.focus({ preventScroll: true })
  }
  function askAI(text) {
    const description = String(text || '').trim().slice(0, 300)
    if (!description) return
    if (detailId) closeDetail()
    setQuery('')
    setDraft(d => ({ ...d, description }))
    setRecBasis(`按你说的：「${description}」`)
    runRecommend({ profession: draft.profession || undefined, description })
    showRec()
  }
  /** ⌘K / 「/」：首屏搜索框在视野里就用它；滚走了用顶栏的小搜索（宽屏），手机上回到顶部再聚焦 */
  function focusSearch({ select = false } = {}) {
    const top = topSearchRef.current
    let input = searchRef.current
    if (!heroSearch && top && top.offsetParent !== null) input = top
    else if (!heroSearch) scrollRef.current?.scrollTo?.({ top: 0, behavior: smooth() })
    input?.focus({ preventScroll: input === top })
    if (select) input?.select()
  }
  useSearchHotkeys(step === 'market' ? focusSearch : null)
  // 新手引导：首屏目录就绪、登录状态查清、没开详情 / 拦路口 / 生成中时，第一次来自动播一次
  useTour('market', { ready: step === 'market' && !!data && !checking && !detailId && !gate && !busy })
  function home() {
    setQuery('')
    if (step === 'brand') go('market')
    else scrollRef.current?.scrollTo?.({ top: 0, behavior: smooth() })
  }

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

  // 去登录：App 里已登录的先退出（否则登录页还是当前账号）；拦路口里临时登录的管理员不动 App 会话
  async function goLogin() {
    const to = loginPath(secret?.username || draft.done?.username || '')
    setSecret(null)
    if (appSession) {
      try { await logout() } catch { /* 会话已失效也照样去登录页 */ }
      onAuthed?.(false)
    }
    navigate(to)
  }
  function goApp() {
    setSecret(null)
    navigate(APP_PATH)
  }
  // 头像菜单「退出登录」：留在市场，以游客身份继续逛（草稿保留，口令不留）
  async function signOut() {
    setSecret(null)
    try { await logout() } catch { /* 会话已失效也照样当作退出 */ }
    onAuthed?.(false)
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
      : { label: '下一步', arrow: true, onClick: () => go('brand'), disabled: !pickedPlugins.length }
    const hint = step !== 'brand' ? ''
      : genError || (!pickedPlugins.length ? '至少选一个插件才能生成' : !draft.brand.name.trim() ? '给智能体起个名字就能生成' : '')
    dock = (
      <Toolbox plugins={pickedPlugins} onRemove={toggle} onMove={move} onReorder={reorder} onAdd={dropAdd} onClear={clearPicked} onOpen={openDetail}
        action={action} hint={hint} />
    )
  }
  const installed = (Array.isArray(draft.done?.platform?.plugins) ? draft.done.platform.plugins : [])
    .map(id => byId.get(id)).filter(Boolean)

  const account = (
    <AccountArea me={me} checking={checking} compact={step !== 'market'}
      onLogin={() => navigate(loginHref())} onEnter={goApp} onFlows={() => navigate('/flows')}
      onAdmin={isOwner ? () => setAdminReq(r => ({ tab: 'manage', n: (r?.n || 0) + 1 })) : undefined} onLogout={signOut}
      onTour={step === 'market' ? () => startTour('market') : undefined} />
  )
  let topCenter = null
  if (step === 'brand') topCenter = <Progress step={step} onGo={go} />
  else if (step === 'market' && data && !heroSearch) {
    topCenter = (
      <>
        <div className="jvm-top-search"><SearchBox value={query} onChange={setQuery} inputRef={topSearchRef} onSubmit={browse} /></div>
        <button type="button" className="jvm-top-icon" onClick={() => focusSearch()} aria-label="搜索插件（回到顶部）">
          <Icon name="search" size={19} />
        </button>
      </>
    )
  }
  const showRecPanel = !!data && !q && recOpen && (rec.status !== 'idle' || !!draft.recommendation)

  return (
    <DndRoot onAdd={dropAdd} canAdd={canAdd} onReorder={reorder} onRemove={remove}>
      <div className={`jvm is-${step}${inFlow ? ' in-flow' : ''}${q ? ' is-searching' : ''}${detailId && data ? ' has-sheet' : ''}`} ref={scrollRef}
        style={accent ? { '--jvm-glow': accent } : undefined}>
        <div className="jvm-ambient" aria-hidden="true"><i /></div>
        <header className={`jvm-top${topCenter && step === 'market' ? ' has-search' : ''}`}>
          {step === 'brand' ? (
            <button type="button" className="jvm-back" onClick={() => go('market')} aria-label="回到插件市场">
              <Icon name="chevron" size={18} />
            </button>
          ) : <Wordmark onHome={home} />}
          {topCenter ? <div className="jvm-top-center">{topCenter}</div> : null}
          <div className="jvm-top-end">{account}</div>
        </header>

        <main className="jvm-main" key={step}>
          {step === 'done' && draft.done ? (
            <Result platform={draft.done.platform} plugins={installed} secret={secret} username={draft.done.username}
              signedIn={!!appSession} onLogin={goLogin} onHome={goApp} onReset={reset} />
          ) : step === 'brand' && data ? (
            <Brand brand={draft.brand} accents={data.accents} profession={profession} plugins={pickedPlugins}
              onBrand={brand => setDraft(d => ({ ...d, brand }))} />
          ) : (
            <>
              <Hero catalog={data} query={query} onQuery={setQuery} inputRef={searchRef} formRef={heroSearchRef}
                onSubmit={browse} onAsk={askAI} profession={draft.profession} onPickProfession={pickProfession}
                onReopen={!recOpen && draft.recommendation && rec.status === 'idle' ? showRec : undefined} />
              {showRecPanel ? (
                <RecommendPanel catalog={data} recommendation={draft.recommendation} picked={draft.picked} recState={rec}
                  basis={recBasis} onToggle={toggle} onAddAll={addAll} onOpen={openDetail} onClose={() => setRecOpen(false)} />
              ) : null}
              {data ? (
                <Catalog catalog={data} picked={draft.picked} onToggle={toggle} onOpen={openDetail}
                  query={query} onClearQuery={() => { setQuery(''); searchRef.current?.focus() }} onAskAI={askAI}
                  filters={filters} onFilters={setFilters}
                  lead={<Featured bundles={bundles} picked={draft.picked} onAdd={addBundle} />}
                  sources={isOwner ? sources : []}
                  onInstallFromSource={(sid, name) => setSourcePreview({ load: () => previewSourcePlugin(sid, name) })} />
              ) : <CatalogPending state={catalog} onRetry={loadCatalog} />}
              {isOwner && data ? (
                <PluginAdmin triggers={false} request={adminReq} onChanged={() => loadCatalog({ quiet: true })} onSources={setSources}
                  external={sourcePreview} />
              ) : null}
            </>
          )}
        </main>

        {dock}

        <p className={`jvm-toast${toast ? ' is-on' : ''}`} role="status" aria-live="polite">{toast}</p>

        {detailId && data ? (
          <PluginDetail catalog={data} pluginId={detailId} picked={draft.picked} onToggle={toggle} onOpen={openDetail}
            onClose={closeDetail} onAskAI={askAI} authed={!!me} toolboxCount={pickedPlugins.length} />
        ) : null}

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
    </DndRoot>
  )
}
