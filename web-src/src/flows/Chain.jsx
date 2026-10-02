import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { fmtMs, linkState, MAX_STEPS, optionSummary, ROLE_LABEL, roleOf } from './model.js'

/* 节点链：一排（手机上一列）节点卡，卡与卡之间是连线，连线中点的「+」插入积木。
 * 运行时：当前节点外圈流光、信号脉冲沿连线流向下一个节点、完成的打勾、失败的标红。
 * 动效只动 transform / opacity；减弱动态时 CSS 只切状态不做流动。 */

const STATE_TEXT = {
  pending: '排队中', running: '进行中', done: '已完成', error: '没走通', skipped: '没轮到', cancelled: '已取消',
}

function StateBadge({ state }) {
  if (state === 'done') return <span className="fl-badge fl-badge--done" aria-hidden="true"><Icon name="check" size={12} /></span>
  if (state === 'error') return <span className="fl-badge fl-badge--error" aria-hidden="true"><Icon name="close" size={12} /></span>
  if (state === 'running') return <span className="fl-badge fl-badge--live" aria-hidden="true"><i /></span>
  return null
}

function NodeOutput({ id, node, open, onToggle }) {
  if (!node) return null
  const { state } = node
  if (state === 'running') return <p className="fl-out fl-out--live">处理中…</p>
  if (state === 'error') return <p className="fl-out fl-out--error">{node.message}</p>
  if (state === 'skipped' || state === 'cancelled') return <p className="fl-out fl-out--muted">{STATE_TEXT[state]}</p>
  if (state !== 'done') return null
  const pid = `fl-pv-${id}`
  return (
    <div className="fl-out fl-out--done">
      <p className="fl-out-sum">{node.summary || '完成'}</p>
      {fmtMs(node.ms) ? <p className="fl-out-ms mono">{fmtMs(node.ms)}</p> : null}
      {node.preview ? (
        <>
          <button type="button" className="fl-out-more" aria-expanded={open} aria-controls={pid} onClick={onToggle}>
            {open ? '收起' : '展开看看'}
          </button>
          {open ? <pre id={pid} className="fl-preview" tabIndex={0}>{node.preview}</pre> : null}
        </>
      ) : null}
    </div>
  )
}

function Link({ state = 'idle', onInsert, label, ghost = false }) {
  return (
    <div className={`fl-link${ghost ? ' fl-link--ghost' : ''}`} data-flow={state}>
      <span className="fl-wire" aria-hidden="true">
        <span className="fl-wire-fill" />
        <span className="fl-pulse" />
      </span>
      {onInsert ? (
        <button type="button" className="fl-plus" aria-label={label} title="插入积木" onClick={onInsert}>
          <Icon name="plus" size={13} />
        </button>
      ) : null}
    </div>
  )
}

function nodeLabel(i, plugin, role, summary, node) {
  const base = `第 ${i + 1} 步，${ROLE_LABEL[role]}：${plugin ? plugin.name : '已下架的积木'}`
  const extra = summary ? `。${summary}` : ''
  if (!node || node.state === 'idle') return `${base}${extra}`
  const tail = node.state === 'done' ? `已完成${node.summary ? `：${node.summary}` : ''}`
    : node.state === 'error' ? `没走通：${node.message}` : STATE_TEXT[node.state]
  return `${base}，${tail}`
}

export default function Chain({ steps, byId, run, selectedId, editable, reduced, onSelect, onInsert }) {
  const refs = useRef({})
  const [open, setOpen] = useState({})
  const cursorId = run ? run.order[run.cursor] : null
  const runKey = run?.startedAt

  // 跑到哪一步就把哪一步滚进视野（横排超出时）
  useEffect(() => {
    const el = cursorId ? refs.current[cursorId] : null
    el?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth' })
  }, [cursorId, reduced])
  useEffect(() => { setOpen({}) }, [runKey])

  const canInsert = editable && steps.length < MAX_STEPS
  return (
    <ol className={`fl-chain${run ? ' is-running' : ''}`} aria-label="流程步骤">
      {steps.map((s, i) => {
        const plugin = byId[s.plugin]
        const role = roleOf(plugin) || 'process'
        const node = run?.nodes[s.id]
        const state = node?.state || 'idle'
        const summary = plugin ? optionSummary(s, plugin) : '删掉它再保存'
        const selected = selectedId === s.id
        return (
          <li key={s.id} className="fl-step" data-role={role} data-state={state} ref={el => { refs.current[s.id] = el }}>
            <div className="fl-col">
              <div className={`fl-node${selected ? ' is-selected' : ''}${plugin ? '' : ' is-missing'}`}>
                <span className="fl-halo" aria-hidden="true" />
                <button type="button" className="fl-card" aria-pressed={selected}
                  aria-label={nodeLabel(i, plugin, role, summary, node)} onClick={() => onSelect(s.id)}>
                  <span className="fl-card-band" aria-hidden="true" />
                  <span className="fl-card-top">
                    <span className="fl-card-icon" aria-hidden="true">{plugin?.icon || '⌁'}</span>
                    <span className="fl-card-role">{ROLE_LABEL[role]}</span>
                    <span className="fl-card-no mono">{String(i + 1).padStart(2, '0')}</span>
                  </span>
                  <span className="fl-card-name">{plugin ? plugin.name : '已下架的积木'}</span>
                  <span className="fl-card-sum">{summary}</span>
                  {plugin?.available === false ? <span className="fl-card-off">暂不可用</span> : null}
                </button>
                <StateBadge state={state} />
                <i className="fl-port fl-port--in" aria-hidden="true" />
                <i className="fl-port fl-port--out" aria-hidden="true" />
              </div>
              <NodeOutput id={s.id} node={node} open={!!open[s.id]}
                onToggle={() => setOpen(o => ({ ...o, [s.id]: !o[s.id] }))} />
            </div>
            {i < steps.length - 1 ? (
              <Link state={linkState(run, i)} label={`在第 ${i + 1} 步和第 ${i + 2} 步之间插入积木`}
                onInsert={canInsert ? () => onInsert(i + 1) : null} />
            ) : null}
          </li>
        )
      })}
      {canInsert ? (
        <li className="fl-step fl-step--add">
          {steps.length ? <Link ghost /> : null}
          <button type="button" className="fl-add" onClick={() => onInsert(steps.length)}>
            <span className="fl-add-plus" aria-hidden="true"><Icon name="plus" size={16} /></span>
            <span className="fl-add-text">{steps.length ? '加一步' : '添加第一步'}</span>
            <span className="fl-add-hint">{steps.length ? `还能加 ${MAX_STEPS - steps.length} 步` : '从「输入」开始'}</span>
          </button>
        </li>
      ) : null}
    </ol>
  )
}
