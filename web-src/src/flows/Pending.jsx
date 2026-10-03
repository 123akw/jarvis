import Icon from '../Icon.jsx'
import { navigate } from '../routes.js'
import { approveHref, relTime, remainLabel } from './flowkit.js'
import { Drawer } from './RunsDrawer.jsx'

/* 「我的流程」首页顶部的「等你确认 · N」（第二十轮，契约 §3.1 / §6.1）：有待确认时才出现；
 * 点开是列表（流程名、停在哪一步、要发的内容预览、还剩多久），点一条进确认页。 */

/** 首页顶部的入口条：只有 N > 0 时由首页渲染 */
export function PendingBar({ pending, approvals, onOpen }) {
  const first = approvals[0]?.flow?.name
  const more = pending > 1 ? `等 ${pending} 个流程` : ''
  return (
    <button type="button" className="fh-pending" onClick={onOpen} aria-haspopup="dialog">
      <span className="fh-pending-dot" aria-hidden="true" />
      <b>等你确认 · {pending}</b>
      <span className="fh-pending-text">{first ? `「${first}」${more}停在发送前，等你看一眼` : '有流程停在发送前，等你看一眼'}</span>
      <Icon name="chevron" size={16} className="fh-pending-go" />
    </button>
  )
}

function Item({ a }) {
  const href = approveHref(a)
  const remain = remainLabel(a.expires_at)
  const soon = /分钟|快到期/.test(remain)
  return (
    <li>
      <a className="fh-ap" href={href}
        onClick={e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(href) }}>
        <span className="fh-ap-main">
          <span className="fh-ap-top">
            <b>{a.flow?.name || '一个流程'}</b>
            {remain ? <span className={`fh-ap-left${soon ? ' is-soon' : ''}`}>{remain}</span> : null}
          </span>
          <span className="fh-ap-step">停在「{a.title || '发送前确认'}」{a.created_at ? ` · ${relTime(a.created_at)}` : ''}</span>
          {a.preview ? <span className="fh-ap-preview">{a.preview}</span> : null}
        </span>
        <Icon name="chevron" size={16} className="fh-run-go" />
      </a>
    </li>
  )
}

/** 待确认列表（抽屉）：桌面右侧、手机底部 */
export default function PendingDrawer({ approvals, pending, onClose }) {
  return (
    <Drawer label="等你确认" onClose={onClose} className="fh-pending-drawer">
      <div className="fh-drawer-head">
        <div>
          <h2 className="fh-drawer-title">等你确认</h2>
          <p className="fh-drawer-sub">{pending} 个流程停在发送前。看一眼内容，同意了才会接着发。</p>
        </div>
        <button type="button" className="jv-modal-close" onClick={onClose} aria-label="关闭"><Icon name="close" size={16} /></button>
      </div>
      <div className="fh-drawer-body">
        {approvals.length ? (
          <ul className="fh-ap-list" aria-label="等你确认的流程">
            {approvals.map(a => <Item key={a.id} a={a} />)}
          </ul>
        ) : <p className="fh-muted">都处理完了。</p>}
        {pending > approvals.length ? <p className="fh-muted fh-ap-more">只列了最近的 {approvals.length} 条。</p> : null}
      </div>
    </Drawer>
  )
}
