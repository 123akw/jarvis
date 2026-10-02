import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'

const isMac = () => {
  try { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') } catch { return false }
}

/** 是不是正在往输入框 / 可编辑区域里打字（这时「/」是字，不是快捷键） */
function typing(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** 搜索框：即时过滤；⌘K / Ctrl+K / 「/」聚焦，Esc 先清空再失焦 */
export function SearchBox({ value, onChange, inputRef, onSubmit }) {
  useEffect(() => {
    function onKey(e) {
      const k = e.key
      if ((k === 'k' || k === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      } else if (k === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(document.activeElement)
        && !document.querySelector('[aria-modal="true"]')) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inputRef])
  return (
    <form className="jvm-search" role="search" onSubmit={e => { e.preventDefault(); onSubmit?.() }}>
      <Icon name="search" size={17} className="jvm-search-icon" />
      <input ref={inputRef} type="search" value={value} placeholder="搜索插件、技能、MCP…" aria-label="搜索插件"
        enterKeyHint="search" autoComplete="off" spellCheck={false} maxLength={60}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          if (value) onChange('')
          else e.currentTarget.blur()
        }} />
      {value ? (
        <button type="button" className="jvm-search-clear" onClick={() => { onChange(''); inputRef.current?.focus() }} aria-label="清空搜索">
          <Icon name="close" size={13} />
        </button>
      ) : <kbd className="jvm-kbd" aria-hidden="true">{isMac() ? '⌘K' : 'Ctrl K'}</kbd>}
    </form>
  )
}

/** 已登录时的头像菜单：账号名、进入我的智能体、我的流程、退出登录。
 *  点头像开合；Esc / 点外面 / 选完一项都收起，焦点回到头像；方向键在菜单项之间移动。 */
function AccountMenu({ me, onEnter, onFlows, onLogout }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const name = me.username || '已登录'
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
            <b>{name}</b><span>{me.role === 'Owner' ? '管理员' : '已登录'}</span>
          </div>
          <button type="button" role="menuitem" onClick={pick(onEnter)}><Icon name="bubble" size={16} />进入我的智能体</button>
          {onFlows ? <button type="button" role="menuitem" onClick={pick(onFlows)}><Icon name="flow" size={16} />我的流程</button> : null}
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
export function AccountArea({ me, checking, onLogin, onEnter, onFlows, onLogout, compact = false }) {
  if (checking) return <span className="jvm-top-wait" aria-hidden="true" />
  if (!me) {
    // 起名 / 结果页里游客不放「登录」：正在走流程，结果页自己有「去登录」
    return compact ? <span /> : <button type="button" className="jvm-top-btn" onClick={onLogin}>登录</button>
  }
  const name = me.username || '已登录'
  return (
    <span className="jvm-top-me">
      {compact ? null : (
        <button type="button" className="jvm-top-btn is-primary" onClick={onEnter}>
          <span className="jvm-top-enter-long">进入我的智能体</span><span className="jvm-top-enter-short">我的智能体</span>
        </button>
      )}
      <AccountMenu me={me} onEnter={onEnter} onFlows={onFlows} onLogout={onLogout} />
    </span>
  )
}

/** 品牌字标：回到市场首屏 */
export function Wordmark({ onHome }) {
  return (
    <button type="button" className="jvm-wordmark" onClick={onHome} aria-label="J.A.R.V.I.S. 智能体市场，回到顶部">
      <span className="jvm-logo" aria-hidden="true" />
      <span className="jvm-wordmark-text" aria-hidden="true">J.A.R.V.I.S.</span>
      <span className="jvm-wordmark-tag" aria-hidden="true">智能体市场</span>
    </button>
  )
}
