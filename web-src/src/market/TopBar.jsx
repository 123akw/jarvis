import { useEffect } from 'react'
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

/** 右上角：检查中留白；游客「登录」；已登录「进入我的智能体」+ 头像。compact（起名 / 结果页）只留头像 */
export function AccountArea({ me, checking, onLogin, onEnter, compact = false }) {
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
      <span className="jvm-account" title={`已登录：${name}`} aria-label={`已登录：${name}`} role="img">
        <i aria-hidden="true">{name.trim().slice(0, 1).toUpperCase() || '·'}</i>
      </span>
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
