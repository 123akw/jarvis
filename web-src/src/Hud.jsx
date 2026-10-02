import { useCallback, useEffect, useRef, useState } from 'react'
import { getFeishuStatus, logout } from './api.js'
import AccountMenu from './AccountMenu.jsx'
import AccountSettings from './AccountSettings.jsx'
import WeakPasswordNotice from './WeakPasswordNotice.jsx'
import Chat from './Chat.jsx'
import CommandPalette from './CommandPalette.jsx'
import { DesktopGuide, useDesktopHandoff } from './DesktopHandoff.jsx'
import FeishuConnect from './FeishuConnect.jsx'
import Icon from './Icon.jsx'
import MemoryPanel from './MemoryPanel.jsx'
import Modal, { useEscape } from './Modal.jsx'
import Panels from './Panels.jsx'
import ProviderSettings from './ProviderSettings.jsx'
import Reminders from './Reminders.jsx'
import Threads from './Threads.jsx'
import { createQuick, useUndoToast } from './UndoToast.jsx'
import WeChatConnect from './WeChatConnect.jsx'
import { applyTheme, currentTheme, toggleTheme } from './theme.js'
import { trackKeyboard } from './viewport.js'

function newThreadId() {
  return 't-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10))
}

/* 断点（与 styles.css 媒体查询一致）：
 *  narrow  ≤1024    会话栏是抽屉、今日是浮层，默认都收起
 *  regular 1025–1599 会话栏常驻可折叠；今日是浮层，默认收起
 *  wide    ≥1600    会话栏与今日板都可常驻，默认展开（记住用户的折叠偏好） */
const NARROW_MAX = 1024
const WIDE_MIN = 1600
const modeOf = w => (w <= NARROW_MAX ? 'narrow' : w >= WIDE_MIN ? 'wide' : 'regular')

/** 只在跨断点时触发重渲染（拖动窗口不会每帧连带整棵树） */
function useLayoutMode() {
  const [mode, setMode] = useState(() => modeOf(window.innerWidth))
  useEffect(() => {
    const onResize = () => setMode(modeOf(window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return mode
}

const readPref = (key, fallback) => {
  const v = localStorage.getItem(key)
  return v === null || v === undefined ? fallback : v === '1'
}
const writePref = (key, on) => localStorage.setItem(key, on ? '1' : '0')

const todayText = () => new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

/** 浮层/抽屉的焦点：打开时把焦点移进面板（键盘与读屏用户不用再摸过去），
 *  关闭时若焦点还在面板里（或已随 inert 掉回 body），交还给开关按钮。 */
function useOverlayFocus(shown, panelRef, toggleRef) {
  const prev = useRef(shown)
  useEffect(() => {
    if (prev.current === shown) return
    prev.current = shown
    const panel = panelRef.current
    if (!panel) return
    if (shown) {
      panel.focus({ preventScroll: true })
    } else {
      const a = document.activeElement
      if (!a || a === document.body || panel.contains(a)) toggleRef.current?.focus({ preventScroll: true })
    }
  }, [shown]) // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Hud({ session, onLogout }) {
  const mode = useLayoutMode()
  const leftOverlay = mode === 'narrow'
  const todayOverlay = mode !== 'wide'
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [dash, setDash] = useState(null)
  const [geo, setGeo] = useState(null)
  // 本地新建、服务端还没有记录的会话：对话区据此跳过拉历史（否则每次「新对话」都换来一个 404）
  const freshRef = useRef(null)
  if (!freshRef.current) freshRef.current = new Set()
  const [thread, setThread] = useState(() => localStorage.getItem('jws_thread') || 'web')
  const [threadList, setThreadList] = useState([])
  const [leftOpen, setLeftOpen] = useState(() => mode !== 'narrow' && readPref('jws_sidebar', true))
  const [todayOpen, setTodayOpen] = useState(() => mode === 'wide' && readPref('jws_today', true))
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [wxOpen, setWxOpen] = useState(false)
  const [feishu, setFeishu] = useState(null)       // 飞书渠道状态：只有服务端配置了飞书才出现入口
  const [fsOpen, setFsOpen] = useState(false)
  const [injected, setInjected] = useState(null)   // 会议纪要「追问」、⌘K「让贾维斯去办」注入对话的消息
  const [locate, setLocate] = useState(null)       // ⌘K「历史对话」跳转要定位的消息 { seq, threadId, pos }
  const [accountOpen, setAccountOpen] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memoryHighlight, setMemoryHighlight] = useState([])   // 「昨晚整理了 N 条 · 查看」要标出的条目
  const [quickSeed, setQuickSeed] = useState(null)            // ⌘K「速记…」带给今日板输入框的草稿
  const [theme, setTheme] = useState(currentTheme)
  const desktop = useDesktopHandoff()

  useEffect(() => {
    applyTheme(theme)
    return () => applyTheme('dark')   // 退出 HUD（登出）回到暗色登录页
  }, [theme])

  useEffect(() => { localStorage.setItem('jws_thread', thread) }, [thread])
  useEffect(() => trackKeyboard(), [])   // iOS 软键盘：主界面贴合键盘以上的可见区域（见 viewport.js）

  // 跨断点：进窄屏收起抽屉/浮层；回到宽屏按用户偏好恢复常驻
  const prevMode = useRef(mode)
  useEffect(() => {
    if (prevMode.current === mode) return
    prevMode.current = mode
    setLeftOpen(mode !== 'narrow' && readPref('jws_sidebar', true))
    setTodayOpen(mode === 'wide' && readPref('jws_today', true))
  }, [mode])

  const onTurnDone = useCallback(() => setRefreshKey(k => k + 1), [])
  const quickToast = useUndoToast({ onChanged: onTurnDone, onExpired: onLogout })

  useEffect(() => {  // 飞书入口：GET /api/feishu/status 报 configured=true 才显示（旧服务端没有该接口就当未配置）
    let alive = true
    getFeishuStatus().then(s => { if (alive) setFeishu(s) }).catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {  // 浏览器定位：拿到就随对话上报，拒绝则服务端按 IP 兜底
    navigator.geolocation?.getCurrentPosition(
      p => setGeo({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => {}, { timeout: 8000, maximumAge: 600000 })
  }, [])

  useEffect(() => {  // ⌘K / Ctrl+K：命令面板
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key?.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function quit() {
    try { await logout() } catch { /* local state still fails closed */ } finally { onLogout() }
  }

  function toggleLeft() {
    const next = !leftOpen
    setLeftOpen(next)
    if (!leftOverlay) writePref('jws_sidebar', next)
  }

  function setToday(next) {
    setTodayOpen(next)
    if (!todayOverlay) writePref('jws_today', next)
  }

  function selectThread(id) {
    setThread(id)
    if (leftOverlay) setLeftOpen(false)  // 抽屉模式选完会话自动收起
  }
  const newChat = () => {
    const id = newThreadId()
    freshRef.current.add(id)
    selectThread(id)
  }
  /** 速记：打开「今日」并把草稿放进待办输入框（预览确认后回车才写入，⌘K 里不直接落库） */
  function openQuick(text) {
    setToday(true)
    setQuickSeed({ seq: Date.now(), text: text || '' })
  }
  /** ⌘K「让贾维斯去办」：收起挡住对话的抽屉/浮层，把这句话发进当前对话 */
  function askJarvis(text) {
    closeOverlays()
    setInjected({ seq: Date.now(), text })
  }
  /** ⌘K「加到日程 / 加到待办」：直接写入（不走模型），顶部 toast 可撤销 */
  async function addDirect(plan, text) {
    try {
      quickToast.show(await createQuick(plan, text))
      onTurnDone()
    } catch (e) {
      if (e.message === '401') { onLogout(); return }
      const what = plan.kind === 'schedule' ? '日程' : '待办'
      quickToast.show({ text: e.status === 422 && e.message ? e.message : `没能添加这条${what}，请稍后再试`, icon: 'close' })
    }
  }
  /** ⌘K 跳会话；从「历史对话」来的带着命中位置，对话区回放后滚到那条 */
  function pickThread(id, at) {
    selectThread(id)
    setLocate(at ? { seq: Date.now(), threadId: id, pos: at.pos } : null)
  }
  const openMemory = useCallback(ids => {
    setMemoryHighlight(Array.isArray(ids) ? ids : [])
    setMemoryOpen(true)
  }, [])

  const overlayShown = (leftOverlay && leftOpen) || (todayOverlay && todayOpen)
  const closeOverlays = useCallback(() => {
    if (leftOverlay) setLeftOpen(false)
    if (todayOverlay) setTodayOpen(false)
  }, [leftOverlay, todayOverlay])
  useEscape(closeOverlays, overlayShown)
  const sideRef = useRef(null)
  const sideBtnRef = useRef(null)
  const todayRef = useRef(null)
  const todayBtnRef = useRef(null)
  useOverlayFocus(leftOverlay && leftOpen, sideRef, sideBtnRef)
  useOverlayFocus(todayOverlay && todayOpen, todayRef, todayBtnRef)

  const isOwner = session?.role === 'Owner'
  const settingsCommands = [
    { id: 'account', label: '账户设置', hint: isOwner ? '口令 · 用户管理' : '口令', icon: 'user', keywords: '密码 口令 用户', run: () => setAccountOpen(true) },
    { id: 'memory', label: '记忆与人设', icon: 'sparkles', keywords: '画像 称呼 人格 persona', run: () => setMemoryOpen(true) },
    { id: 'settings', label: '设置中心', hint: '模型 API · 语音 · 桌面', icon: 'sliders', keywords: 'api 模型 provider key 语音 音色 语速 晨报 电台 桌面 会议 邮箱 联网 搜索', run: () => setProviderOpen(true) },
    ...(isOwner ? [{ id: 'wechat', label: '接入个人微信', icon: 'bubble', keywords: 'wechat 扫码', run: () => setWxOpen(true) }] : []),
    ...(feishu?.configured ? [{ id: 'feishu', label: '接入飞书', hint: feishu.bound ? '已绑定' : '', icon: 'feishu', keywords: 'feishu lark 飞书 绑定 机器人', run: () => setFsOpen(true) }] : []),
    { id: 'desktop', label: '桌面悬浮窗', hint: desktop.busy ? '联系中…' : '', icon: 'desktop', keywords: '悬浮球 桌面端', run: () => void desktop.activate() },
    { id: 'theme', label: theme === 'light' ? '切换到暗色' : '切换到亮色', icon: theme === 'light' ? 'moon' : 'sun', keywords: '主题 外观 theme', run: () => setTheme(toggleTheme()) },
  ]
  const logoutCommand = { id: 'logout', label: '退出登录', icon: 'logout', danger: true, run: quit }
  const menuCommands = [...settingsCommands, { id: 'sep-logout', sep: true }, logoutCommand]
  const paletteCommands = [
    { id: 'new', label: '新对话', icon: 'compose', run: newChat },
    { id: 'quick', label: '速记…', hint: '待办或日程，写上时间就是日程', icon: 'plus', keywords: '速记 待办 日程 提醒 添加 新建 quick add todo', run: () => openQuick('') },
    { id: 'sidebar', label: leftOpen ? '收起会话栏' : '展开会话栏', icon: 'sidebar', keywords: '历史 会话', run: toggleLeft },
    { id: 'today', label: todayOpen ? '收起今日' : '打开今日', hint: '日程 · 待办 · 备忘 · 会议纪要', icon: 'today', run: () => setToday(!todayOpen) },
    ...settingsCommands,
    logoutCommand,
  ]

  const status = {
    state: busy ? 'busy' : dash ? 'online' : 'idle',
    label: busy ? '正在思考' : dash ? '在线' : '连接中',
    place: dash?.place || '',
    detail: [geo ? '浏览器定位' : dash?.place ? 'IP 定位' : '未定位', dash?.model, dash?.version ? `v${dash.version}` : '']
      .filter(Boolean).join(' · '),
  }
  const title = threadList.find(t => t.id === thread)?.title || '新对话'
  const pending = dash ? dash.todos.length : 0

  return (
    <div className={`hud mode-${mode}`}>
      <header className="jv-topbar">
        <div className="tb-left">
          <button ref={sideBtnRef} type="button" className={`jv-icon-btn${leftOpen ? ' on' : ''}`} onClick={toggleLeft}
            aria-label={leftOpen ? '收起会话栏' : '展开会话栏'} aria-expanded={leftOpen}
            aria-controls="jv-sidebar" title="会话历史">
            <Icon name="sidebar" />
          </button>
          <span className="wordmark">J.A.R.V.I.S.</span>
        </div>
        <div className="tb-center">
          <span className="tb-title" title={title}>{title}</span>
          <span className="tb-meta" title={`${status.label}${status.place ? ` · ${status.place}` : ''}`}>
            <span className={`status-dot ${status.state}`} aria-hidden="true" />
            <span className="tb-model">{dash?.model || status.label}</span>
          </span>
        </div>
        <div className="tb-right">
          <button type="button" className="tb-search" onClick={() => setPaletteOpen(true)}
            aria-label="命令面板" title="搜索与命令（⌘K）">
            <Icon name="search" size={16} />
            <span className="tb-search-text">搜索与命令</span>
            <kbd>⌘K</kbd>
          </button>
          <button ref={todayBtnRef} type="button" className={`jv-icon-btn${todayOpen ? ' on' : ''}`} onClick={() => setToday(!todayOpen)}
            aria-label="今日" aria-expanded={todayOpen} aria-controls="jv-today"
            title={pending ? `今日：${pending} 项待办` : '今日：日程 / 待办 / 备忘'}>
            <Icon name="today" />
            {pending > 0 && !todayOpen ? <span className="badge-dot" aria-hidden="true" /> : null}
          </button>
          <AccountMenu session={session} status={status} commands={menuCommands} />
        </div>
      </header>
      <Reminders onExpired={onLogout} />
      <WeakPasswordNotice weak={Boolean(session?.password_weak)} onFix={() => setAccountOpen(true)} />
      {desktop.note ? <div className="jv-toast" role="status">{desktop.note}</div> : null}
      {quickToast.node}
      <main className="jv-main">
        <aside id="jv-sidebar" ref={sideRef} tabIndex={-1} className={`jv-sidebar${leftOpen ? ' open' : ''}`} aria-label="会话历史"
          inert={!leftOpen || undefined}>
          <div className="sb-brand" aria-hidden="true">J.A.R.V.I.S.</div>
          <Threads current={thread} refreshKey={refreshKey}
            onSelect={selectThread} onNew={newChat}
            onExpired={onLogout} onLoaded={setThreadList} />
        </aside>
        <Chat threadId={thread} location={geo} onBusy={setBusy} injected={injected} locate={locate}
          fresh={freshRef.current.has(thread) && !threadList.some(t => t.id === thread)}
          onTurnDone={onTurnDone} onExpired={onLogout} userName={session?.username || ''} />
        <aside id="jv-today" ref={todayRef} tabIndex={-1} className={`jv-today${todayOpen ? ' open' : ''}`} aria-label="今日"
          inert={!todayOpen || undefined}>
          <div className="today-card">
            <div className="today-head">
              <div>
                <h2 className="today-title">今日</h2>
                <p className="today-date">{todayText()}</p>
              </div>
              <button type="button" className="jv-icon-btn" onClick={() => setToday(false)} aria-label="收起今日">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="today-scroll">
              {/* 常挂载：收起时也继续轮询仪表盘（顶栏状态点、模型名、待办提示都靠它） */}
              <Panels refreshKey={refreshKey} onData={setDash} onExpired={onLogout}
                active={todayOpen} quickSeed={quickSeed} onOpenMemory={openMemory}
                onAskMeeting={text => { setInjected({ seq: Date.now(), text }); if (todayOverlay) setTodayOpen(false) }} />
            </div>
          </div>
        </aside>
        {overlayShown ? <div className="drawer-backdrop" onClick={closeOverlays} /> : null}
      </main>
      {paletteOpen ? (
        <CommandPalette commands={paletteCommands} threads={threadList} onAsk={askJarvis} onAdd={addDirect}
          onPickThread={pickThread} onExpired={onLogout} onClose={() => setPaletteOpen(false)} />
      ) : null}
      {wxOpen ? <WeChatConnect onClose={() => setWxOpen(false)} onExpired={onLogout} /> : null}
      {fsOpen ? <FeishuConnect onClose={() => setFsOpen(false)} onExpired={onLogout} onChange={setFeishu} /> : null}
      {memoryOpen ? (
        <MemoryPanel highlight={memoryHighlight} onExpired={onLogout}
          onClose={() => { setMemoryOpen(false); setMemoryHighlight([]) }} />
      ) : null}
      {accountOpen ? (
        <Modal label="账户设置" onClose={() => setAccountOpen(false)} dismissOnBackdrop={false}>
          <AccountSettings session={session} onClose={() => setAccountOpen(false)} onReauth={onLogout} />
        </Modal>
      ) : null}
      {providerOpen ? (
        <Modal label="设置中心" size="lg" onClose={() => setProviderOpen(false)} dismissOnBackdrop={false}>
          <ProviderSettings session={session} onClose={() => setProviderOpen(false)} onExpired={onLogout}
            onApplied={() => setRefreshKey(key => key + 1)} />
        </Modal>
      ) : null}
      {desktop.guide ? <DesktopGuide onClose={desktop.closeGuide} /> : null}
    </div>
  )
}
