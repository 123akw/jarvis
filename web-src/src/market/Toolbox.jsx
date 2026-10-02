import { useState } from 'react'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'

/** 底部固定工具箱条：已选数量 + 小图标（点开可移除）+ 当前步骤的主按钮 */
export default function Toolbox({ plugins, onRemove, action, hint }) {
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
              <span className="jvm-tray-label">工具箱</span>
              <span className="jvm-tray-count" aria-live="polite">{n ? `已选 ${n} 个` : '还是空的'}</span>
            </span>
          </button>
          {action ? (
            <button type="button" className="jvm-btn jvm-dock-go" onClick={action.onClick} disabled={action.disabled}>
              {action.label}
            </button>
          ) : null}
        </div>
        {hint ? <p className="jvm-dock-hint" role="status">{hint}</p> : null}
      </div>
      {open ? (
        <Modal label="我的工具箱" size="sm" onClose={() => setOpen(false)} className="jvm-sheet">
          <ModalHead title="我的工具箱" subtitle={n ? `已选 ${n} 个插件，生成后都会装进你的智能体` : '还没选插件'} onClose={() => setOpen(false)} />
          <div className="jv-modal-body">
            {n ? (
              <ul className="jvm-box-list">
                {plugins.map(p => (
                  <li key={p.id}>
                    <span className="jvm-rec-icon" aria-hidden="true">{p.icon}</span>
                    <span className="jvm-box-name">{p.name}</span>
                    <button type="button" className="jvm-box-remove" onClick={() => onRemove(p.id)} aria-label={`移除 ${p.name}`}>
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="jvm-box-empty">在插件市场里点「加入」，选好的会出现在这里。</p>}
            <button type="button" className="jvm-btn jvm-btn--block" data-autofocus onClick={() => setOpen(false)}>好的</button>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
