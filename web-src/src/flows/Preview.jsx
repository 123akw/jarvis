import { useMemo } from 'react'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { describeNode, nodeInfo, orderNodes } from './flowkit.js'
import Thumb from './Thumb.jsx'

/* 流程预览弹层（一句话生成的草稿、模板共用）：缩略图 +「它会做什么」+「需要准备」（是否满足 + 动作）+ 提醒。
 * 按钮只有两个：生成的草稿是「换个说法」/「打开编辑」，模板是「关闭」/「用这个模板」。 */

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

const ACTION_LABEL = { feishu: '去绑定飞书' }

/** 「需要准备」：每条带状态（✓ 已满足 / ! 还没好 / · 自己确认）与动作 */
export function Requirements({ items, onAction }) {
  if (!items.length) return null
  return (
    <ul className="fh-reqs">
      {items.map(r => (
        <li key={r.key} className="fh-req" data-ok={r.ok === true ? 'yes' : r.ok === false ? 'no' : 'unknown'}>
          <span className="fh-req-mark" aria-hidden="true">
            {r.ok === true ? <Icon name="check" size={12} /> : r.ok === false ? '!' : <i />}
          </span>
          <span className="fh-req-text">
            {r.text}
            <span className="sr-only">{r.ok === true ? '（已满足）' : r.ok === false ? '（还没准备好）' : ''}</span>
          </span>
          {r.action && ACTION_LABEL[r.action] ? (
            <button type="button" className="fh-link fh-req-go" onClick={() => onAction?.(r.action)}>
              {ACTION_LABEL[r.action]}<Icon name="chevron" size={13} />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export default function Preview({
  label, title, subtitle, icon = '', graph, idx, quote = '', notes = [], reqs = [], onAction,
  primary, onPrimary, secondary, onSecondary, onClose,
}) {
  return (
    <Modal label={label} onClose={onClose} size="lg" className="fh-preview">
      <ModalHead title={<>{icon ? <span className="fh-preview-icon" aria-hidden="true">{icon}</span> : null}{title}</>}
        subtitle={subtitle} onClose={onClose} />
      <div className="jv-modal-body fh-preview-body">
        {quote ? <p className="fh-quote"><span>你说的</span>{quote}</p> : null}
        <div className="fh-preview-stage">
          <Thumb graph={graph} idx={idx} size="lg" />
        </div>
        <h3 className="fh-preview-sub">它会做什么</h3>
        <StepList graph={graph} idx={idx} />
        {reqs.length ? (
          <>
            <h3 className="fh-preview-sub">需要准备</h3>
            <Requirements items={reqs} onAction={onAction} />
          </>
        ) : null}
        {notes.length ? (
          <div className="fh-notes" role="note">
            <p className="fh-notes-title"><Icon name="sparkles" size={14} />贾维斯提醒</p>
            <ul>{notes.map(n => <li key={n}>{n}</li>)}</ul>
          </div>
        ) : null}
        <div className="fh-sheet-foot">
          <div className="fh-preview-actions">
            <button type="button" className="jv-btn" onClick={onSecondary}>{secondary}</button>
            <button type="button" className="jv-btn jv-btn--primary" onClick={onPrimary} data-autofocus>
              {primary}<Icon name="chevron" size={15} />
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
