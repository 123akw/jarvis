import { useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { KIND_LABEL, kindCounts } from './model.js'

/** 类型分布的一行字：「3 工具 · 1 技能 · 1 MCP」 */
export const mixText = plugins => kindCounts(plugins).map(k => `${k.n} ${k.label}`).join(' · ')

/** 工具箱抽屉：已选插件可上下调整顺序、移除、点名字看详情；顶部是类型分布 */
function Drawer({ plugins, onClose, onRemove, onMove, onClear, onOpen, action }) {
  const n = plugins.length
  const listRef = useRef(null)
  const [sure, setSure] = useState(false)   // 「全部清空」点两次才生效
  // 移动后焦点跟着那一行的同一个按钮走（移到头 / 尾时换到还能按的那个）
  const move = (id, dir) => {
    onMove(id, dir)
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector(`[data-id=${JSON.stringify(id)}]`)
      const btn = row?.querySelector(`[data-dir="${dir}"]:not(:disabled)`) || row?.querySelector('[data-dir]:not(:disabled)')
      btn?.focus()
    })
  }
  return (
    <Modal label="我的工具箱" size="sm" onClose={onClose} className="jvm-sheet jvm-box">
      <ModalHead title="我的工具箱" subtitle={n ? `已选 ${n} 个 · ${mixText(plugins)}` : '还没选插件'} onClose={onClose} />
      <div className="jv-modal-body">
        {n ? (
          <>
            <p className="jvm-box-tip">生成时按这个顺序装进智能体；排在前面的，介绍自己时先说。</p>
            <ol className="jvm-box-list" ref={listRef}>
              {plugins.map((p, i) => (
                <li key={p.id} data-id={p.id}>
                  <span className="jvm-rec-icon" aria-hidden="true">{p.icon}</span>
                  <button type="button" className="jvm-box-name" onClick={() => onOpen(p.id)} aria-label={`查看详情：${p.name}`}>
                    <span>{p.name}</span><small>{KIND_LABEL[p.kind]}</small>
                  </button>
                  <span className="jvm-box-order">
                    <button type="button" data-dir="up" onClick={() => move(p.id, -1)} disabled={i === 0} aria-label={`上移 ${p.name}`}>
                      <Icon name="up" size={15} />
                    </button>
                    <button type="button" data-dir="down" onClick={() => move(p.id, 1)} disabled={i === n - 1} aria-label={`下移 ${p.name}`}>
                      <Icon name="up" size={15} className="is-down" />
                    </button>
                  </span>
                  <button type="button" className="jvm-box-remove" onClick={() => onRemove(p.id)} aria-label={`移除 ${p.name}`}>
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ol>
            <div className="jvm-box-actions">
              <button type="button" className={`jvm-link${sure ? ' is-danger' : ''}`} onClick={() => (sure ? onClear() : setSure(true))}
                onBlur={() => setSure(false)}>
                {sure ? '再点一次，全部清空' : '全部清空'}
              </button>
              {action ? (
                <button type="button" className="jvm-btn" onClick={() => { onClose(); action.onClick() }} disabled={action.disabled}>{action.label}</button>
              ) : null}
            </div>
          </>
        ) : (
          <div className="jvm-none is-tight">
            <span className="jvm-none-icon" aria-hidden="true">🧰</span>
            <p className="jvm-none-title">工具箱还是空的</p>
            <p className="jvm-none-sub">在市场里点「加入」，或者整套加入一个精选套装。</p>
            <button type="button" className="jvm-btn jvm-btn--block" data-autofocus onClick={onClose}>去挑插件</button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** 底部常驻工具箱条：已选数量 + 类型分布 + 小图标（点开抽屉）+ 当前步骤的主按钮 */
export default function Toolbox({ plugins, onRemove, onMove, onClear, onOpen, action, hint }) {
  const [open, setOpen] = useState(false)
  const n = plugins.length
  return (
    <>
      <div className="jvm-dock" role="region" aria-label="工具箱">
        <div className="jvm-dock-inner">
          <button type="button" className="jvm-tray" onClick={() => setOpen(true)} aria-haspopup="dialog"
            aria-label={n ? `工具箱：已选 ${n} 个插件，点开查看` : '工具箱：还没选插件'}>
            <span className={`jvm-tray-icons${n ? '' : ' is-empty'}`} aria-hidden="true">
              {n ? plugins.slice(-4).map(p => <i key={p.id}>{p.icon}</i>) : <i><Icon name="plus" size={14} /></i>}
            </span>
            <span className="jvm-tray-text">
              <span className="jvm-tray-count" aria-live="polite">{n ? `已选 ${n} 个` : '工具箱是空的'}</span>
              <span className="jvm-tray-label">{n ? mixText(plugins) : '挑几个插件放进来'}</span>
            </span>
          </button>
          {action ? (
            <button type="button" className="jvm-btn jvm-dock-go" onClick={action.onClick} disabled={action.disabled}>
              {action.label}{action.arrow ? <Icon name="chevron" size={16} /> : null}
            </button>
          ) : null}
        </div>
        {hint ? <p className="jvm-dock-hint" role="status">{hint}</p> : null}
      </div>
      {open ? (
        <Drawer plugins={plugins} onClose={() => setOpen(false)} onRemove={onRemove} onMove={onMove} onClear={onClear}
          onOpen={id => { setOpen(false); onOpen(id) }} action={action} />
      ) : null}
    </>
  )
}
