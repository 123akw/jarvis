import { useEffect, useRef } from 'react'
import Icon from './Icon.jsx'

/** Esc 关闭：只认最上层（最后打开）的那一个，叠开的模态不会被一次 Esc 全部关掉 */
const escStack = []
export function useEscape(handler, active = true) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!active) return undefined
    const token = {}
    escStack.push(token)
    function onKey(e) {
      if (e.key !== 'Escape' || escStack[escStack.length - 1] !== token) return
      e.stopPropagation()
      ref.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = escStack.indexOf(token)
      if (i >= 0) escStack.splice(i, 1)
    }
  }, [active])
}

/** 统一的设置类模态外壳：遮罩 + 居中玻璃卡（手机端为底部抽屉）+ Esc 关闭。
 *  dismissOnBackdrop=false 用于含口令输入的表单，避免误点遮罩丢掉已填内容。 */
export default function Modal({ label, onClose, size = 'md', dismissOnBackdrop = true, className = '', children }) {
  useEscape(onClose)
  return (
    <div className="jv-modal-backdrop"
      onMouseDown={e => { if (dismissOnBackdrop && e.target === e.currentTarget) onClose?.() }}>
      <div className={`jv-modal jv-modal--${size}${className ? ` ${className}` : ''}`}
        role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

/** 模态标题区：标题 + 可选副标题 + 圆形关闭钮 */
export function ModalHead({ title, subtitle, onClose, closeLabel = '关闭' }) {
  return (
    <div className="jv-modal-head">
      <div className="jv-modal-titles">
        <h2 className="jv-modal-title">{title}</h2>
        {subtitle ? <p className="jv-modal-sub">{subtitle}</p> : null}
      </div>
      {onClose ? (
        <button type="button" className="jv-modal-close" onClick={onClose} aria-label={closeLabel}>
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  )
}
