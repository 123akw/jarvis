import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { useEscape } from './Modal.jsx'

const nowText = () => new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })

/** 时钟单独成组件：只在菜单打开时挂载，每 15 秒只重渲染这一行 */
function Clock() {
  const [clock, setClock] = useState(nowText)
  useEffect(() => {
    const t = setInterval(() => setClock(nowText()), 15000)
    return () => clearInterval(t)
  }, [])
  return <span className="mono">{clock}</span>
}

/** 头像菜单：账户、记忆、设置、微信、悬浮窗、主题、退出全部收在这里；
 *  在线状态 / 定位 / 模型 / 版本 / 时钟作为次要信息放在菜单头部。
 *  poweredBy：账号有自己的平台时，贾维斯退到菜单底部一行小字。 */
export default function AccountMenu({ session, status, commands, poweredBy = false }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const menuRef = useRef(null)
  const btnRef = useRef(null)
  const name = session?.username || '账号'
  const initial = name.trim().slice(0, 1).toUpperCase() || '·'
  // 键盘关闭菜单：焦点交还头像按钮（否则落到 body，键盘用户要从头 Tab）
  const closeToButton = () => { setOpen(false); btnRef.current?.focus() }
  useEscape(closeToButton, open)

  useEffect(() => {
    if (!open) return undefined
    const onDown = e => { if (!rootRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    menuRef.current?.querySelector('[role="menuitem"]')?.focus()
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function onMenuKey(e) {
    const items = [...menuRef.current.querySelectorAll('[role="menuitem"]')]
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (i + 1) % items.length
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'Tab') { setOpen(false); return }   // Tab 离开菜单即收起，焦点自然移到下一个控件
    if (next < 0) return
    e.preventDefault()
    items[next]?.focus()
  }

  function pick(c) {
    // 先把焦点交还头像按钮再执行：随后打开的弹窗会把它记作「关闭后还焦点」的目标
    btnRef.current?.focus()
    setOpen(false)
    c.run()
  }

  return (
    <div className="acct" ref={rootRef}>
      <button ref={btnRef} type="button" className={`avatar-btn${open ? ' on' : ''}`} onClick={() => setOpen(v => !v)}
        aria-label="账户与设置" aria-haspopup="menu" aria-expanded={open} title={name}>
        <span className="avatar">{initial}</span>
      </button>
      {open ? (
        <div className="jv-menu" role="menu" aria-label="账户与设置" ref={menuRef} onKeyDown={onMenuKey}>
          <div className="menu-profile">
            <span className="avatar lg">{initial}</span>
            <span className="mp-text">
              <span className="mp-name" title={name}>{name}</span>
              <span className="mp-role">{session?.role || ''}</span>
            </span>
          </div>
          <div className="menu-status">
            <span className={`status-dot ${status.state}`} aria-hidden="true" />
            <span>{status.label}</span>
            {status.place ? <span className="ms-sep">·</span> : null}
            {status.place ? <span>{status.place}</span> : null}
            <span className="ms-sep">·</span>
            <Clock />
          </div>
          {status.detail ? <div className="menu-status sub">{status.detail}</div> : null}
          <div className="menu-sep" role="separator" />
          {commands.map(c => (c.sep
            ? <div key={c.id} className="menu-sep" role="separator" />
            : (
              <button key={c.id} type="button" role="menuitem"
                className={`menu-item${c.danger ? ' danger' : ''}`}
                onClick={() => pick(c)}>
                <Icon name={c.icon} size={17} />
                <span className="mi-label">{c.label}</span>
                {c.hint ? <span className="mi-hint">{c.hint}</span> : null}
              </button>
            )))}
          {poweredBy ? <div className="menu-foot">由贾维斯驱动</div> : null}
        </div>
      ) : null}
    </div>
  )
}
