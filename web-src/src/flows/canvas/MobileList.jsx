import Icon from '../../Icon.jsx'
import { conditionHandles, handleLabel, nodeById, nodeTitle } from '../graph.js'
import { NodeFace } from './NodeCard.jsx'

/* 手机（<760px）：列表式编辑。按拓扑序一张张节点卡；点卡片打开底部弹层配置；
 * 每张卡下面「在后面加一步」（条件节点按分支各一个），从底部面板选节点，自动连线。 */
export default function MobileList({ graph, order, vmOf, locked, onOpen, onAdd }) {
  return (
    <ol className="fc-mlist" aria-label="流程的每一步">
      {order.map((id, i) => {
        const node = nodeById(graph, id)
        if (!node) return null
        const vm = vmOf(node)
        const prev = order[i - 1]
        // 不是紧挨着上一张卡接过来的（分支、汇合），标出「接在谁后面」
        const ins = graph.edges.filter(e => e.target === id)
        const from = ins.filter(e => e.source !== prev || e.sourceHandle)
          .map(e => {
            const s = nodeById(graph, e.source)
            const h = handleLabel(s, e.sourceHandle)
            return h ? `${nodeTitle(s)} · ${h}` : nodeTitle(s)
          })
        const handles = node.type === 'condition' ? conditionHandles(node) : node.type === 'end' ? [] : [null]
        return (
          <li key={id} className="fc-mitem">
            {from.length ? <p className="fc-mfrom">接在{from.map(f => `「${f}」`).join('、')}后面</p>
              : node.type !== 'start' && !ins.length ? <p className="fc-mfrom is-warn">还没连上前面的节点</p> : null}
            <div className="fc-mcard">
              <NodeFace vm={vm} />
              <button type="button" className="fc-mcard-hit" onClick={() => onOpen(id)}
                aria-label={`设置「${vm.title}」（${vm.typeLabel}）${vm.issues?.length ? `，还差 ${vm.issues.length} 处` : ''}`} />
            </div>
            {!locked && handles.length ? (
              <div className="fc-madd">
                {handles.map(h => (
                  <button key={h ?? '_'} type="button" className="fc-madd-btn" onClick={() => onAdd(id, h)}>
                    <Icon name="plus" size={14} />{h ? `在「${handleLabel(node, h)}」后面加一步` : '在后面加一步'}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
