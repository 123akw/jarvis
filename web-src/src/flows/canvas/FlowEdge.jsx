import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import { memo, useContext } from 'react'
import Icon from '../../Icon.jsx'
import { CanvasActions } from './NodeCard.jsx'

/** 连线：贝塞尔曲线；悬停 / 选中时中间出现「+」（插一个节点进来）；运行中按状态流动、变绿、变暗 */
export const FlowEdge = memo(function FlowEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data = {}, selected, markerEnd,
}) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const { openQuick, hoverEdge } = useContext(CanvasActions)
  const run = data.run || ''
  const show = !data.locked && (selected || data.hover)
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd}
        className={`fc-edge${run ? ` is-${run}` : ''}${selected ? ' is-selected' : ''}`} interactionWidth={24} />
      {run === 'flowing' ? <path d={path} className="fc-edge-flow" fill="none" /> : null}
      {!data.locked ? (
        <EdgeLabelRenderer>
          <div className={`fc-edge-tools nodrag nopan${show ? ' is-shown' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            onMouseEnter={() => hoverEdge?.(id)} onMouseLeave={() => hoverEdge?.(null)}>
            <button type="button" className="fc-edge-plus" aria-label={`在「${data.label || '这条线'}」中间加节点`} title="在中间加节点"
              tabIndex={show ? 0 : -1}
              onClick={e => { e.stopPropagation(); openQuick({ edgeId: id, rect: e.currentTarget.getBoundingClientRect() }) }}>
              <Icon name="plus" size={12} />
            </button>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
})

export const EDGE_TYPES = { flow: FlowEdge }
