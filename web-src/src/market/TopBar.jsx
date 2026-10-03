import { useEffect, useRef, useState } from 'react'
import { unreadText, useAdminUnread } from '../admin/useAdminUnread.js'
import Icon from '../Icon.jsx'
import { navigate } from '../routes.js'

const isMac = () => {
  try { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') } catch { return false }
}

/** 是不是正在往输入框 / 可编辑区域里打字（这时「/」是字，不是快捷键） */
function typing(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** 搜索快捷键：⌘K / Ctrl+K 任何时候、「/」不在打字且没有弹窗时 → focus()。页面上只挂一份 */
export function useSearchHotkeys(focus) {
  const ref = useRef(focus)
  ref.current = focus
  useEffect(() => {
    function onKey(e) {
      const k = e.key
      if ((k === 'k' || k === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault()
        ref.current?.({ select: true })
      } else if (k === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(document.activeElement)
        && !document.querySelector('[aria-modal="true"]')) {
        e.preventDefault()
        ref.current?.({ select: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * 搜索框：即时过滤；Esc 先清空再失焦。全站同一时刻只露一个：
 *  - size="hero"：首屏大搜索框（56 高，兼做「一句话帮我推荐」，建议下拉由 Hero 挂在 children 里）；
 *  - size="compact"：首屏搜索框滚出视野后，顶栏淡入的 40 高小号版本，共用同一个关键词。
 * onKeyDown 先交给调用方（建议列表的 ↑↓ / 回车）；调用方 preventDefault 了就不再走默认的 Esc 处理。
 */
export function SearchBox({ value, onChange, inputRef, onSubmit, size = 'compact', id, onKeyDown, inputProps = {}, children = null }) {
  const hero = size === 'hero'
  return (
    <form className={`jvm-search is-${size}`} role="search" onSubmit={e => { e.preventDefault(); onSubmit?.() }}>
      <Icon name="search" size={hero ? 20 : 17} className="jvm-search-icon" />
      <input ref={inputRef} id={id} type="search" value={value} aria-label="搜索插件"
        placeholder={hero ? '搜插件，或说说你想让它帮你做什么' : '搜索插件、技能、MCP…'}
        enterKeyHint="search" autoComplete="off" spellCheck={false} maxLength={hero ? 120 : 60}
        {...inputProps}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          onKeyDown?.(e)
          if (e.defaultPrevented || e.key !== 'Escape') return
          e.preventDefault()
          if (value) onChange('')
          else e.currentTarget.blur()
        }} />
      <span className="jvm-search-end">
        {value ? (
          <button type="button" className="jvm-search-clear" onClick={() => { onChange(''); inputRef.current?.focus() }} aria-label="清空搜索">
            <Icon name="close" size={14} />
          </button>
        ) : hero ? null : <kbd className="jvm-kbd" aria-hidden="true">{isMac() ? '⌘K' : 'Ctrl K'}</kbd>}
      </span>
      {children}
    </form>
  )
}

/** 菜单里「新手引导」的小问号（和其他菜单项的线性图标同粗细） */
function TourIcon() {
  return (
    <svg className="jv-icon" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" /><path d="M12 17h.01" />
    </svg>
  )
}

/** 已登录时的头像菜单：账号名、进入我的智能体、我的流程、（管理员）插件管理与管理后台、退出登录。
 *  点头像开合；Esc / 点外面 / 选完一项都收起，焦点回到头像；方向键在菜单项之间移动。 */
function AccountMenu({ me, onEnter, onFlows, onAdmin, onLogout, onTour }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const name = me.username || '已登录'
  const owner = me.role === 'Owner'
  const adminUnread = useAdminUnread(owner)
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) btnRef.current?.focus()
  }
  useEffect(() => {
    if (!open) return undefined
    menuRef.current?.querySelector('[role="menuitem"]')?.focus()
    const onDown = e => {
      if (!menuRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])
  const onKey = e => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])]
    const i = items.indexOf(document.activeElement)
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Tab') close(false)
  }
  const pick = fn => () => { close(false); fn?.() }
  async function doLogout() {
    setBusy(true)
    try { await onLogout?.() } finally { setBusy(false); setOpen(false) }
  }
  return (
    <span className="jvm-account-wrap">
      <button ref={btnRef} type="button" className="jvm-account" aria-haspopup="menu" aria-expanded={open}
        aria-label={`账号：${name}`} title={`已登录：${name}`} onClick={() => setOpen(v => !v)}>
        <i aria-hidden="true">{name.trim().slice(0, 1).toUpperCase() || '·'}</i>
      </button>
      {open ? (
        <div ref={menuRef} className="jvm-account-menu" role="menu" aria-label="账号菜单" onKeyDown={onKey}>
          <div className="jvm-account-head" aria-hidden="true">
            <b>{name}</b><span>{owner ? '管理员' : '已登录'}</span>
          </div>
          <button type="button" role="menuitem" onClick={pick(onEnter)}><Icon name="bubble" size={16} />进入我的智能体</button>
          {onFlows ? <button type="button" role="menuitem" onClick={pick(onFlows)}><Icon name="flow" size={16} />我的流程</button> : null}
          {owner && onAdmin ? (
            <button type="button" role="menuitem" onClick={pick(onAdmin)}><Icon name="store" size={16} />插件管理</button>
          ) : null}
          {owner ? (
            <button type="button" role="menuitem" onClick={pick(() => navigate('/admin'))}>
              <Icon name="chart" size={16} />管理后台
              {adminUnread ? (
                <span title={unreadText(adminUnread)}
                  style={{ marginLeft: 'auto', width: 7, height: 7, flex: 'none', borderRadius: '50%', background: 'var(--jv-danger)' }}>
                  <span className="sr-only">（{unreadText(adminUnread)}）</span>
                </span>
              ) : null}
            </button>
          ) : null}
          {onTour ? <button type="button" role="menuitem" onClick={pick(onTour)}><TourIcon />新手引导</button> : null}
          <span className="jvm-account-sep" role="separator" />
          <button type="button" role="menuitem" className="is-danger" disabled={busy} onClick={doLogout}>
            <Icon name="logout" size={16} />{busy ? '正在退出…' : '退出登录'}
          </button>
        </div>
      ) : null}
    </span>
  )
}

/** 右上角：检查中留白；游客「登录」；已登录「进入我的智能体」+ 头像菜单。compact（起名 / 结果页）只留头像 */
export function AccountArea({ me, checking, onLogin, onEnter, onFlows, onAdmin, onLogout, onTour, compact = false }) {
  if (checking) return <span className="jvm-top-wait" aria-hidden="true" />
  if (!me) {
    // 起名 / 结果页里游客不放「登录」：正在走流程，结果页自己有「去登录」
    return compact ? <span /> : <button type="button" className="jvm-top-btn" onClick={onLogin}>登录</button>
  }
  return (
    <span className="jvm-top-me">
      {compact ? null : (
        <button type="button" className="jvm-top-btn is-primary" onClick={onEnter}>
          <span className="jvm-top-enter-long">进入我的智能体</span><span className="jvm-top-enter-short">我的智能体</span>
        </button>
      )}
      <AccountMenu me={me} onEnter={onEnter} onFlows={onFlows} onAdmin={onAdmin} onLogout={onLogout} onTour={onTour} />
    </span>
  )
}

/** 品牌字标：回到市场首屏 */
export function Wordmark({ onHome }) {
  return (
    <button type="button" className="jvm-wordmark" onClick={onHome} aria-label="J.A.R.V.I.S. 智能体市场，回到顶部">
      <span className="jvm-logo" aria-hidden="true" />
      <span className="jvm-wordmark-text" aria-hidden="true">J.A.R.V.I.S.</span>
    </button>
  )
}
