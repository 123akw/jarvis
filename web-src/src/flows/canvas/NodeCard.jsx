import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { createContext, memo, useContext, useEffect } from 'react'
import Icon from '../../Icon.jsx'
import { approveHref } from '../flowkit.js'
import { ELSE_HANDLE, fmtMs } from '../graph.js'
import Glyph, { NodeIcon } from './glyphs.jsx'

/** 画布动作（节点出口的「+」等），由 Canvas 提供 */
export const CanvasActions = createContext({ openQuick() {} })

const RUN_TEXT = { running: '正在运行', ok: '完成', error: '出错了', skipped: '没走到', stopped: '已停止', waiting: '等你确认' }

export function RunBadge({ run }) {
  if (!run?.status) return null
  const { status } = run
  if (run.stale && status !== 'running') {
    return (
      <span className="fc-run-badge is-stale" role="img" aria-label="结果已过期：改过了，再运行结果可能不同" title="改过了，再运行结果可能不同">
        <Glyph name="warn" size={12} /><span>已过期</span>
      </span>
    )
  }
  if (status === 'waiting') {
    return (
      <span className="fc-run-badge is-waiting" role="img" aria-label="等你确认">
        <Glyph name="wait" size={12} /><span>等你确认</span>
      </span>
    )
  }
  return (
    <span className={`fc-run-badge is-${status}`} role="img" aria-label={`${RUN_TEXT[status] || ''}${run.ms && status === 'ok' ? `，用时 ${fmtMs(run.ms)}` : ''}`}>
      {status === 'running' ? <i className="fc-spin" aria-hidden="true" />
        : status === 'ok' ? <><Icon name="check" size={13} /><span>{run.ms ? fmtMs(run.ms) : ''}</span></>
          : status === 'error' ? <Icon name="close" size={13} />
            : status === 'skipped' ? <span>没走到</span>
              : <span>停了</span>}
    </span>
  )
}

/**
 * 节点卡（画布与手机列表共用的外观）：图标、标题、类型小字、1–2 行摘要、问题提示、运行态。
 * vm：{ node, title, typeLabel, emoji, summary, issues, run, cases }
 */
export function NodeFace({ vm, selected = false, children = null, as: Tag = 'div', ...rest }) {
  const { node, run, issues = [] } = vm
  const first = issues.find(i => i.level === 'error') || issues[0]
  const runMsg = run?.stale ? '' : run?.status === 'error' ? run.message : run?.status === 'skipped' ? (run.reason || '条件没走到这条分支') : ''
  return (
    <Tag className={`fc-node${selected ? ' is-selected' : ''}${first ? ` has-${first.level}` : ''}`} data-type={node.type}
      data-run={run?.status || undefined} data-stale={run?.stale || undefined} data-tour={node.type === 'start' ? 'flow-node-start' : undefined} {...rest}>
      <div className="fc-node-head">
        <NodeIcon type={node.type} emoji={vm.emoji} />
        <div className="fc-node-titles">
          <b className="fc-node-title">{vm.title}</b>
          {vm.typeLabel && vm.typeLabel !== vm.title ? <small className="fc-node-type">{vm.typeLabel}</small> : null}
        </div>
        <RunBadge run={run} />
      </div>
      {vm.summary ? <p className="fc-node-sum">{vm.summary}</p> : null}
      {runMsg ? <p className={`fc-node-runmsg is-${run.status}`}>{runMsg}</p> : null}
      {run?.status === 'waiting' && !run.stale ? <WaitLink approval={run.approval} /> : null}
      {first && !runMsg ? (
        <p className={`fc-node-issue is-${first.level}`}>
          <Glyph name="warn" size={13} /><span>{first.message}{issues.length > 1 ? `（还有 ${issues.length - 1} 处）` : ''}</span>
        </p>
      ) : null}
      {children}
    </Tag>
  )
}

/** 节点卡上的「已发给你确认 · 去确认」：新标签页打开确认页，画布留着 */
function WaitLink({ approval }) {
  const href = approveHref(approval)
  return (
    <p className="fc-node-wait">
      <span>已发给你确认</span>
      {href ? (
        <a className="fc-node-wait-go nodrag nopan" href={href} target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()} aria-label="去确认（在新标签页打开）">去确认<Icon name="chevron" size={12} /></a>
      ) : null}
    </p>
  )
}

function Plus({ nodeId, handle, label, locked }) {
  const { openQuick } = useContext(CanvasActions)
  if (locked) return null
  return (
    <button type="button" className="fc-plus nodrag nopan" aria-label={`在「${label}」后面加节点`} title="在后面加节点"
      onClick={e => { e.stopPropagation(); openQuick({ after: nodeId, handle, rect: e.currentTarget.getBoundingClientRect() }) }}>
      <Icon name="plus" size={13} />
    </button>
  )
}

/** React Flow 自定义节点：每种类型同一结构；条件节点每个分支一个出口并标名字，最后是「否则」 */
export const FlowNode = memo(function FlowNode({ id, data, selected }) {
  const vm = data.vm
  const { node } = vm
  const update = useUpdateNodeInternals()
  const handleKey = (vm.cases || []).map(c => `${c.id}:${c.label}`).join('|')
  useEffect(() => { update(id) }, [handleKey, id, update])
  const locked = data.locked
  const connectable = !locked
  return (
    <NodeFace vm={vm} selected={selected}>
      {node.type !== 'start' ? <Handle type="target" position={Position.Left} className="fc-handle fc-handle--in" isConnectable={connectable} /> : null}
      {node.type === 'condition' ? (
        <ul className="fc-cases" aria-label="分支出口">
          {[...(vm.cases || []), { id: ELSE_HANDLE, label: '否则' }].map(c => (
            <li key={c.id} className={`fc-case${c.id === ELSE_HANDLE ? ' is-else' : ''}${vm.branch === undefined ? '' : vm.branch === c.id ? ' is-on' : ' is-off'}`}
              aria-label={vm.branch === c.id ? `${c.label}（这次走了这里）` : undefined}>
              <span className="fc-case-label">{c.label}</span>
              <Handle type="source" position={Position.Right} id={c.id} className="fc-handle fc-handle--out" isConnectable={connectable} />
              <Plus nodeId={id} handle={c.id} label={`${vm.title} · ${c.label}`} locked={locked} />
            </li>
          ))}
        </ul>
      ) : node.type !== 'end' ? (
        <>
          <Handle type="source" position={Position.Right} className="fc-handle fc-handle--out" isConnectable={connectable} />
          <Plus nodeId={id} handle={null} label={vm.title} locked={locked} />
        </>
      ) : null}
    </NodeFace>
  )
})

export const NODE_TYPES = { flow: FlowNode }
