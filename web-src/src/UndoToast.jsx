import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { addSchedule, addTodo, deleteSchedule, deleteTodo } from './api.js'
import Icon from './Icon.jsx'

const TOAST_MS = 6000

/** 按速记解析结果直接写入：日程走 addSchedule，否则按原文加待办。
 *  返回 toast 载荷 { text, icon, undo }（undo 调对应的 DELETE）。失败照常抛出（401 / 422 由调用方处理）。 */
export async function createQuick(plan, text) {
  if (plan.kind === 'schedule') {
    const r = await addSchedule(plan.title, plan.when)
    const day = plan.rel || plan.label.split(' ').slice(0, 2).join(' ')
    return { text: `已添加日程：${day} ${plan.when.slice(11)} ${plan.title}`, icon: 'today', undo: () => deleteSchedule(r.id) }
  }
  const content = text.trim()
  const r = await addTodo(content)
  return { text: `已添加待办：${content}`, icon: 'list', undo: () => deleteTodo(r.id) }
}

/** 顶部可撤销的 toast（速记、⌘K 直达项共用）。show({ text, icon, undo }) 弹出；
 *  不带 undo 的是纯提示（如写入失败）。node 渲染到 body，调用方把它放进自己的树里即可。 */
export function useUndoToast({ onChanged, onExpired } = {}) {
  const [toast, setToast] = useState(null)        // { text, icon, undo?, state: ''|'busy'|'undone'|'fail' }
  const timer = useRef(0)
  const cb = useRef({ onChanged, onExpired })
  cb.current = { onChanged, onExpired }

  useEffect(() => () => clearTimeout(timer.current), [])

  function show(next, ms = TOAST_MS) {
    clearTimeout(timer.current)
    setToast({ state: '', ...next })
    timer.current = setTimeout(() => setToast(null), ms)
  }

  async function undo() {
    if (!toast?.undo || toast.state === 'busy') return
    clearTimeout(timer.current)
    setToast(t => ({ ...t, state: 'busy' }))
    try {
      await toast.undo()
      show({ ...toast, text: '已撤销', state: 'undone' }, 1800)
      cb.current.onChanged?.()
    } catch (e) {
      if (e.message === '401') { cb.current.onExpired?.(); return }
      if (e.status === 404) { show({ ...toast, text: '已撤销', state: 'undone' }, 1800); cb.current.onChanged?.(); return }
      show({ ...toast, state: 'fail' })
    }
  }

  const node = toast && typeof document !== 'undefined' ? createPortal(
    <div className="jv-toast jv-toast--action" role="status">
      <Icon name={toast.state === 'undone' ? 'check' : toast.icon || 'check'} size={15} />
      <span className="jt-text">{toast.state === 'fail' ? '没能撤销，请稍后再试' : toast.text}</span>
      {toast.state === 'undone' || !toast.undo ? null : (
        <button type="button" className="jt-act" onClick={() => void undo()} disabled={toast.state === 'busy'}>
          {toast.state === 'fail' ? '重试' : '撤销'}
        </button>
      )}
    </div>, document.body) : null

  return { show, node }
}
