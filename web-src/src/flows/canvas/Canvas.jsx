import {
  Background, BackgroundVariant, Controls, MarkerType, ReactFlow, ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useMemo, useRef, useState } from 'react'
import { canConnect, edgeRunState, nodeById, nodeTitle } from '../graph.js'
import { EDGE_TYPES } from './FlowEdge.jsx'
import { CanvasActions, NODE_TYPES } from './NodeCard.jsx'
import { DND_TYPE } from './Palette.jsx'

/* React Flow 画布：节点 / 连线由编辑器的节点图推出来（受控），这里只把交互翻译回编辑器的动作。
 * @xyflow/react 与它的 CSS 只在这个懒加载的画布里引入。 */

const ARIA = {
  'node.a11yDescription.default': '按回车或空格选中节点，选中后按 Delete 删除，Esc 取消。',
  'node.a11yDescription.keyboardDisabled': '按回车或空格选中节点，选中后可以用方向键挪动，按 Delete 删除，Esc 取消。',
  'node.a11yDescription.ariaLiveMessage': ({ direction }) => `节点往${{ up: '上', down: '下', left: '左', right: '右' }[direction] || ''}挪了一点`,
  'edge.a11yDescription.default': '按回车或空格选中连线，选中后按 Delete 删除，Esc 取消。',
  'controls.ariaLabel': '画布缩放',
  'controls.zoomIn.ariaLabel': '放大',
  'controls.zoomOut.ariaLabel': '缩小',
  'controls.fitView.ariaLabel': '适配视图：显示全部节点',
  'controls.interactive.ariaLabel': '锁定画布',
  'minimap.ariaLabel': '缩略图',
  'handle.ariaLabel': '连线口',
}
const SNAP = [16, 16]
const FIT = { padding: 0.24, maxZoom: 1.1 }
const MARKER = { type: MarkerType.ArrowClosed, width: 14, height: 14 }

function Inner({
  graph, vmOf, selectedId, selectedEdge, locked, readOnly, run, onSelect, onSelectEdge, onMove, onConnect,
  onConnectError, onDropItem, onQuick, onInit, sizesRef, onDeleteEdge,
}) {
  const [sizes, setSizes] = useState({})
  const [hover, setHover] = useState(null)
  const rf = useRef(null)
  const moved = useRef({})

  const nodes = useMemo(() => graph.nodes.map(n => ({
    id: n.id, type: 'flow', position: n.position,
    data: { vm: vmOf(n), locked: locked || readOnly },
    selected: n.id === selectedId,
    measured: sizes[n.id],
    draggable: !readOnly && !locked,
    deletable: false,
    ariaLabel: `${nodeTitle(n)}节点`,
  })), [graph, vmOf, selectedId, sizes, locked, readOnly])

  const edges = useMemo(() => graph.edges.map(e => {
    const s = nodeById(graph, e.source)
    const t = nodeById(graph, e.target)
    return {
      id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, type: 'flow',
      selected: e.id === selectedEdge, deletable: false, markerEnd: MARKER,
      data: { run: edgeRunState(e, run), locked: locked || readOnly, hover: hover === e.id, label: `${nodeTitle(s)} → ${nodeTitle(t)}` },
      ariaLabel: `从「${nodeTitle(s)}」连到「${nodeTitle(t)}」`,
    }
  }), [graph, selectedEdge, run, locked, readOnly, hover])

  const onNodesChange = useCallback(changes => {
    let dims = null
    let done = false
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions) {
        dims ||= {}
        dims[c.id] = { width: c.dimensions.width, height: c.dimensions.height }
      } else if (c.type === 'position') {
        if (c.position) moved.current[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) }
        if (c.dragging === false) done = true
      } else if (c.type === 'select' && c.selected) {
        onSelect(c.id)
      }
    }
    if (dims) {
      setSizes(prev => {
        const next = { ...prev, ...dims }
        if (sizesRef) sizesRef.current = next
        return next
      })
    }
    const pending = moved.current
    if (Object.keys(pending).length || done) {
      if (!done) onMove(pending, false)
      else { moved.current = {}; onMove(pending, true) }
    }
  }, [onSelect, onMove, sizesRef])

  const onEdgesChange = useCallback(changes => {
    for (const c of changes) if (c.type === 'select' && c.selected) onSelectEdge(c.id)
  }, [onSelectEdge])

  const isValidConnection = useCallback(c => !canConnect(graph, c), [graph])

  const actions = useMemo(() => ({
    openQuick: q => onQuick?.(q),
    hoverEdge: setHover,
    deleteEdge: id => onDeleteEdge?.(id),
  }), [onQuick, onDeleteEdge])

  // 从出口拖线到空白处松手：弹出「接下来做什么？」，新节点放在松手处
  const onConnectEnd = useCallback((event, state) => {
    if (readOnly || locked || !state || state.isValid || state.toNode) return
    const from = state.fromNode
    if (!from || state.fromHandle?.type !== 'source') return
    const pt = 'changedTouches' in event && event.changedTouches?.length ? event.changedTouches[0] : event
    const x = pt.clientX
    const y = pt.clientY
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const p = rf.current?.screenToFlowPosition({ x, y }) || { x: 0, y: 0 }
    onQuick?.({
      after: from.id, handle: state.fromHandle.id ?? null, rect: { left: x, right: x, top: y, bottom: y },
      position: { x: Math.round(p.x / 16) * 16, y: Math.round((p.y - 40) / 16) * 16 },
    })
  }, [readOnly, locked, onQuick])

  return (
    <CanvasActions.Provider value={actions}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={c => { const why = canConnect(graph, c); if (why) onConnectError?.(why); else onConnect(c) }}
        isValidConnection={isValidConnection} onConnectEnd={onConnectEnd}
        onNodeClick={(_, n) => onSelect(n.id)}
        onEdgeClick={(_, e) => onSelectEdge(e.id)}
        onPaneClick={() => { onSelect(null); onSelectEdge(null) }}
        onEdgeMouseEnter={(_, e) => setHover(e.id)} onEdgeMouseLeave={() => setHover(null)}
        onInit={inst => { rf.current = inst; onInit?.(inst) }}
        onDragOver={e => {
          if (readOnly || locked || !e.dataTransfer?.types?.includes(DND_TYPE)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={e => {
          const key = e.dataTransfer?.getData(DND_TYPE)
          if (!key || readOnly || locked) return
          e.preventDefault()
          const p = rf.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) || { x: 0, y: 0 }
          onDropItem(key, { x: Math.round((p.x - 128) / 16) * 16, y: Math.round((p.y - 40) / 16) * 16 })
        }}
        nodesDraggable={!readOnly && !locked} nodesConnectable={!readOnly && !locked}
        elementsSelectable edgesFocusable={!readOnly} nodesFocusable
        deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        snapToGrid snapGrid={SNAP} fitView fitViewOptions={FIT} minZoom={0.25} maxZoom={1.8}
        panOnScroll={false} zoomOnDoubleClick={false} connectionRadius={28}
        defaultEdgeOptions={{ type: 'flow' }} ariaLabelConfig={ARIA}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.4} className="fc-bg" />
        <Controls showInteractive={false} position="bottom-left" fitViewOptions={{ ...FIT, duration: 240 }} className="fc-controls" />
      </ReactFlow>
    </CanvasActions.Provider>
  )
}

export default function Canvas(props) {
  return (
    <div className={`fc-canvas${props.readOnly ? ' is-readonly' : ''}`} data-tour={props.tour === false ? undefined : 'flow-canvas'}
      role="region" aria-label="流程画布：节点和连线">
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
      {props.children}
    </div>
  )
}
