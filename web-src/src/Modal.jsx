import { useEffect, useLayoutEffect, useRef } from 'react'
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

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),'
  + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => {
    if (el.closest('[inert],[hidden]')) return false
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden'
  })
}

/**
 * 对话框焦点管理（WAI-ARIA dialog 模式）：
 *  - 打开时记下原焦点，把焦点移进对话框（优先 [data-autofocus]，否则对话框本身）；
 *  - Tab / Shift+Tab 在对话框内循环，不会跑到背后的页面；
 *  - 关闭时把焦点还给打开前的元素（它还在页面上的话）。
 * 用 layout effect：同一次提交里「旧浮层卸载还焦点 → 新弹窗挂载取焦点」的先后顺序是确定的。
 */
export function useDialogFocus(ref, active = true) {
  useLayoutEffect(() => {
    const root = ref.current
    if (!active || !root) return undefined
    const returnTo = document.activeElement
    const auto = root.querySelector('[data-autofocus]')
    ;(auto || root).focus({ preventScroll: true })
    function onKey(e) {
      if (e.key !== 'Tab') return
      const list = focusables(root)
      if (!list.length) { e.preventDefault(); root.focus(); return }
      const first = list[0]
      const last = list[list.length - 1]
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || cur === root || !root.contains(cur))) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && (cur === last || !root.contains(cur))) {
        e.preventDefault(); first.focus()
      }
    }
    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('keydown', onKey)
      if (returnTo && returnTo !== document.body && returnTo.isConnected && typeof returnTo.focus === 'function') {
        returnTo.focus({ preventScroll: true })
      }
    }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** 统一的设置类模态外壳：遮罩 + 居中玻璃卡（手机端为底部抽屉）+ Esc 关闭 + 焦点陷阱。
 *  dismissOnBackdrop=false 用于含口令输入的表单，避免误点遮罩丢掉已填内容。 */
export default function Modal({ label, onClose, size = 'md', dismissOnBackdrop = true, className = '', children }) {
  const ref = useRef(null)
  useEscape(onClose)
  useDialogFocus(ref)
  return (
    <div className="jv-modal-backdrop"
      onMouseDown={e => { if (dismissOnBackdrop && e.target === e.currentTarget) onClose?.() }}>
      <div ref={ref} className={`jv-modal jv-modal--${size}${className ? ` ${className}` : ''}`}
        role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
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
