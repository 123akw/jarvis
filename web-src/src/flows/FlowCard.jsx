import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { flowHref, navigate } from '../routes.js'
import { absTime, chainLabel, relTime, RUN_STATUS, scheduleLabel } from './flowkit.js'
import Thumb from './Thumb.jsx'

/* 「我的流程」卡片：缩略图、名称、上次运行、触发方式标记（⏰ 定时 / 💬 消息 / 🔗 链接）
 * + 更多菜单（打开 / 运行记录 / 触发方式 / 复制 / 删除）。
 * 整张卡是一个链接（伪元素铺满），菜单按钮叠在上面，避免按钮套按钮。 */

const MENU = [
  { id: 'open', label: '打开', icon: 'pencil' },
  { id: 'runs', label: '运行记录', icon: 'list' },
  { id: 'triggers', label: '触发方式', icon: 'sliders' },
  { id: 'copy', label: '复制', icon: 'copy' },
  { id: 'delete', label: '删除', icon: 'trash', danger: true },
]

/** 下拉菜单（WAI-ARIA menu）：打开即聚焦第一项；↑↓ / Home / End 移动，Esc 关闭并把焦点还给按钮，点外面关闭 */
function Menu({ id, label, onPick, onClose, anchorRef }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.querySelector('[role=menuitem]')?.focus()
    function onDown(e) {
      if (ref.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return
      onClose(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [onClose, anchorRef])
  function onKeyDown(e) {
    const items = [...ref.current.querySelectorAll('[role=menuitem]')]
    const i = items.indexOf(document.activeElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (i + 1) % items.length
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); return }
    else if (e.key === 'Tab') { onClose(false); return }
    if (next < 0) return
    e.preventDefault()
    items[next].focus()
  }
  return (
    <div ref={ref} id={id} className="fh-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {MENU.map(m => (
        <button key={m.id} type="button" role="menuitem" tabIndex={-1}
          className={`fh-menu-item${m.danger ? ' is-danger' : ''}`} onClick={() => onPick(m.id)}>
          <Icon name={m.icon} size={16} />{m.label}
        </button>
      ))}
    </div>
  )
}

function lastRunText(last) {
  if (!last) return { dot: '', text: '还没运行过' }
  const status = RUN_STATUS[last.status] || '结束'
  const when = relTime(last.started_at || last.finished_at)
  const dot = last.status === 'ok' ? 'online' : last.status === 'error' ? 'error' : last.status === 'running' ? 'busy' : last.status === 'waiting' ? 'wait' : ''
  const text = last.status === 'waiting' ? '有一步等你确认' : `上次运行${last.status === 'rejected' ? '没被同意' : status}`
  return { dot, text: `${text}${when ? ` · ${when}` : ''}`, title: absTime(last.started_at) }
}

export function triggerText(trigger) {
  if (!trigger || trigger.kind !== 'schedule' || trigger.enabled === false) return ''
  return trigger.label || scheduleLabel(trigger.schedule)
}

const Emoji = ({ children }) => <span className="fh-chip-emoji" aria-hidden="true">{children}</span>

/** 卡片上的定时标记：正常「⏰ 每个工作日 08:00」；上次定时运行失败变红、点开看运行记录；连续失败被自动暂停的提示去处理 */
function TimerChip({ flow, onAction }) {
  const t = flow.trigger
  if (!t || t.kind !== 'schedule') return null
  if (t.enabled === false) {
    return (
      <button type="button" className="fh-flow-timer is-warn is-btn" onClick={() => onAction('schedule', flow)}>
        <Emoji>⏰</Emoji><span>定时已暂停</span>
      </button>
    )
  }
  if (t.last_status === 'error') {
    return (
      <button type="button" className="fh-flow-timer is-error is-btn" onClick={() => onAction('runs', flow)}
        title={triggerText(t)}>
        <Emoji>⏰</Emoji><span>上次定时运行失败</span>
      </button>
    )
  }
  const label = triggerText(t)
  return label ? <span className="fh-flow-timer" title="定时运行"><Emoji>⏰</Emoji><span>{label}</span></span> : null
}

/** 收到消息 / 链接触发开着时的小标记 */
function HookChips({ hooks }) {
  if (!hooks) return null
  return (
    <>
      {hooks.message ? <span className="fh-flow-timer is-hook" title="飞书 / 微信收到符合条件的消息时自动运行"><Emoji>💬</Emoji><span>收到消息</span></span> : null}
      {hooks.webhook ? <span className="fh-flow-timer is-hook" title="别的工具往专属地址发一下就运行"><Emoji>🔗</Emoji><span>链接</span></span> : null}
    </>
  )
}

export default function FlowCard({ flow, idx, hooks = null, onAction }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const menuId = useId()
  const name = flow.name || '未命名流程'
  const last = lastRunText(flow.last_run)
  const href = flowHref(flow.id)

  function close(refocus) {
    setOpen(false)
    if (refocus) btnRef.current?.focus()
  }
  function pick(id) {
    setOpen(false)
    if (id === 'open') navigate(href)
    else onAction(id, flow)
  }

  return (
    <li className={`fh-flow${open ? ' is-menu' : ''}`}>
      <div className="fh-flow-thumb">
        {flow.graph ? <Thumb graph={flow.graph} idx={idx} label={`流程图：${chainLabel(flow.graph, idx)}`} /> : null}
      </div>
      <div className="fh-flow-body">
        <h3 className="fh-flow-name">
          <a className="fh-flow-link" href={href}
            onClick={e => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
              e.preventDefault()
              navigate(href)
            }}>{name}</a>
        </h3>
        {flow.summary ? <p className="fh-flow-sum">{flow.summary}</p> : null}
        <p className="fh-flow-meta">
          <span className="fh-flow-last" title={last.title || undefined}>
            <span className={`status-dot ${last.dot}`} aria-hidden="true" />{last.text}
          </span>
          <TimerChip flow={flow} onAction={onAction} />
          <HookChips hooks={hooks} />
        </p>
      </div>
      <button ref={btnRef} type="button" className="fh-more" aria-label={`「${name}」的更多操作`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(o => !o)}>
        <Icon name="more" size={18} />
      </button>
      {open ? (
        <div className="fh-menu-anchor">
          <Menu id={menuId} label={`「${name}」的操作`} onPick={pick} onClose={close} anchorRef={btnRef} />
        </div>
      ) : null}
    </li>
  )
}
