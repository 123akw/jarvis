import { useMemo } from 'react'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { describeNode, nodeInfo, orderNodes } from './flowkit.js'
import Thumb from './Thumb.jsx'

/* 流程预览弹层（一句话生成的草稿、模板共用）：缩略图 + 「这条流程会做这些事」+ 提示 → 打开编辑 / 用这个模板。 */

/** 步骤清单：按连线先后，每步一句人话 */
export function StepList({ graph, idx }) {
  const steps = useMemo(() => orderNodes(graph).map(n => ({ id: n.id, info: nodeInfo(n, idx), desc: describeNode(n, graph, idx) })), [graph, idx])
  return (
    <ol className="fh-steps">
      {steps.map((s, i) => (
        <li key={s.id} className="fh-step" data-tone={s.info.tone}>
          <span className="fh-step-icon" aria-hidden="true">{s.info.icon}</span>
          <span className="fh-step-text">
            <b><span className="sr-only">第 {i + 1} 步：</span>{s.info.name}</b>
            {s.desc ? <span>{s.desc}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

export default function Preview({
  label, title, subtitle, icon = '', graph, idx, quote = '', notes = [], needs = [], blocked = [],
  busy = false, busyText = '', error = '', primary, onPrimary, secondary = '', onSecondary, onClose,
}) {
  return (
    <Modal label={label} onClose={onClose} size="lg" className="fh-preview">
      <ModalHead title={<>{icon ? <span className="fh-preview-icon" aria-hidden="true">{icon}</span> : null}{title}</>}
        subtitle={subtitle} onClose={onClose} />
      <div className="jv-modal-body fh-preview-body" aria-busy={busy || undefined}>
        {quote ? <p className="fh-quote"><span>你说的</span>{quote}</p> : null}
        <div className={`fh-preview-stage${busy ? ' is-busy' : ''}`}>
          <Thumb graph={graph} idx={idx} size="lg" />
          {busy ? <div className="fh-preview-busy" role="status"><span className="fh-spark" aria-hidden="true" />{busyText || '正在生成…'}</div> : null}
        </div>
        <h3 className="fh-preview-sub">这条流程会做这些事</h3>
        <StepList graph={graph} idx={idx} />
        {notes.length || needs.length || blocked.length ? (
          <div className="fh-notes" role="note">
            <p className="fh-notes-title"><Icon name="sparkles" size={14} />开始前看一眼</p>
            <ul>
              {needs.map(n => <li key={`need-${n}`}>{n}</li>)}
              {blocked.map(p => <li key={`p-${p.id}`} className="is-warn">「{p.name}」现在用不了{p.reason ? `：${p.reason}` : ''}</li>)}
              {notes.map(n => <li key={`note-${n}`}>{n}</li>)}
            </ul>
          </div>
        ) : null}
        {error ? <p className="fh-form-err" role="alert">{error}</p> : null}
        <div className="fh-preview-actions">
          {secondary ? <button type="button" className="jv-btn" onClick={onSecondary} disabled={busy}>{secondary}</button> : null}
          <button type="button" className="jv-btn jv-btn--primary" onClick={onPrimary} disabled={busy} data-autofocus>
            {primary}<Icon name="chevron" size={15} />
          </button>
        </div>
      </div>
    </Modal>
  )
}
