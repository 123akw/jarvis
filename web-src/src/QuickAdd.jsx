import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { addSchedule, addTodo, deleteSchedule, deleteTodo } from './api.js'
import Icon from './Icon.jsx'
import { parseQuickAdd } from './quickAdd.js'

const TOAST_MS = 6000

/** 一句话速记：「今日」板待办输入框。写上时间就是日程（输入时实时预览），否则照旧是待办；
 *  提交后顶部给一个可撤销的 toast。Esc 或「改成待办」可以推翻解析结果。
 *  seed：⌘K「速记…」带进来的草稿 { seq, text }（seq 变化时填入并聚焦）。 */
export default function QuickAdd({ seed = null, onChanged, onExpired }) {
  const [draft, setDraft] = useState('')
  const [asTodo, setAsTodo] = useState(false)     // 用户推翻了解析：本次按待办
  const [err, setErr] = useState('')
  const [toast, setToast] = useState(null)        // { text, undo, state: ''|'busy'|'undone'|'fail' }
  const inputRef = useRef(null)
  const toastTimer = useRef(0)
  const hintId = useId()

  const parsed = useMemo(() => parseQuickAdd(draft, new Date()), [draft])
  const timed = parsed.kind === 'schedule' || parsed.kind === 'empty'
  const plan = asTodo && draft.trim() ? { kind: 'todo', title: draft.trim() } : parsed

  useEffect(() => () => clearTimeout(toastTimer.current), [])
  useEffect(() => {
    if (!seed) return undefined
    setDraft(seed.text || '')
    setAsTodo(false)
    setErr('')
    // 等「今日」浮层展开、Hud 把焦点交给面板之后再把光标放进输入框
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 80)
    return () => clearTimeout(t)
  }, [seed?.seq])

  function showToast(next, ms = TOAST_MS) {
    clearTimeout(toastTimer.current)
    setToast(next)
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }

  async function submit() {
    const text = draft.trim()
    if (!text) return
    if (plan.kind === 'empty') { setErr('还差要做的事，比如「明天下午3点 复盘」'); return }
    setErr('')
    setDraft('')        // 乐观清空：失败时放回
    setAsTodo(false)
    try {
      if (plan.kind === 'schedule') {
        const r = await addSchedule(plan.title, plan.when)
        const day = plan.rel || plan.label.split(' ').slice(0, 2).join(' ')
        showToast({ text: `已添加日程：${day} ${plan.when.slice(11)} ${plan.title}`, undo: () => deleteSchedule(r.id), state: '' })
      } else {
        const r = await addTodo(text)
        showToast({ text: `已添加待办：${text}`, undo: () => deleteTodo(r.id), state: '' })
      }
      onChanged?.()
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setDraft(text)
      setAsTodo(plan.kind === 'todo' && timed)
      // 422 是服务端的格式校验：原文照登（「时间需要 YYYY-MM-DD HH:MM 格式」之类）
      setErr(e.status === 422 && e.message ? e.message : `没能添加这条${plan.kind === 'schedule' ? '日程' : '待办'}，请稍后再试`)
    }
  }

  async function undo() {
    if (!toast || toast.state === 'busy') return
    clearTimeout(toastTimer.current)
    setToast(t => ({ ...t, state: 'busy' }))
    try {
      await toast.undo()
      showToast({ ...toast, text: '已撤销', state: 'undone' }, 1800)
      onChanged?.()
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      if (e.status === 404) { showToast({ ...toast, text: '已撤销', state: 'undone' }, 1800); onChanged?.(); return }
      showToast({ ...toast, state: 'fail' })
    }
  }

  function onKeyDown(e) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') { e.preventDefault(); void submit() }
    else if (e.key === 'Escape' && timed && !asTodo && draft.trim()) {
      e.stopPropagation()   // 只撤销解析，不关「今日」浮层
      setAsTodo(true)
    }
  }

  const showPlan = draft.trim() && (timed || asTodo)
  return (
    <div className="quick-add">
      <div className="jv-add-row">
        <input ref={inputRef} value={draft} placeholder="＋ 待办或日程，写上时间就是日程" aria-label="速记：待办或日程"
          aria-describedby={showPlan || err ? hintId : undefined}
          onChange={e => { setDraft(e.target.value); setErr(''); if (!e.target.value.trim()) setAsTodo(false) }}
          onKeyDown={onKeyDown} />
      </div>
      <div id={hintId} aria-live="polite">
        {err ? <div className="qa-err" role="alert">{err}</div> : showPlan ? <Preview plan={plan} asTodo={asTodo}
          onToggle={() => { setAsTodo(v => !v); inputRef.current?.focus() }} /> : null}
      </div>
      {toast && typeof document !== 'undefined' ? createPortal(
        <div className="jv-toast jv-toast--action" role="status">
          <Icon name={toast.state === 'undone' ? 'check' : toast.text.startsWith('已添加日程') ? 'today' : 'list'} size={15} />
          <span className="jt-text">{toast.state === 'fail' ? '没能撤销，请稍后再试' : toast.text}</span>
          {toast.state === 'undone' ? null : (
            <button type="button" className="jt-act" onClick={() => void undo()} disabled={toast.state === 'busy'}>
              {toast.state === 'fail' ? '重试' : '撤销'}
            </button>
          )}
        </div>, document.body) : null}
    </div>
  )
}

function Preview({ plan, asTodo, onToggle }) {
  if (asTodo) {
    return (
      <div className="qa-preview is-todo">
        <Icon name="list" size={14} />
        <span className="qa-lead">按待办添加</span>
        <button type="button" className="qa-switch" onClick={onToggle}>改回日程</button>
      </div>
    )
  }
  // 今天/明天/后天：「明天 周六 15:00」；更远的写全日期「10月8日 周四 09:30」
  const [md, wk, hm] = plan.label.split(' ')
  const when = (
    <span className="qa-when" title={plan.label}>{plan.rel ? <b>{plan.rel}</b> : md} {wk} <span className="qa-hm">{hm}</span></span>
  )
  return (
    <div className={`qa-preview${plan.past ? ' is-past' : ''}`}>
      <Icon name="today" size={14} />
      <span className="qa-lead">将创建日程</span>
      {when}
      {plan.kind === 'schedule'
        ? <span className="qa-title">· {plan.title}</span>
        : <span className="qa-note">· 还差要做的事</span>}
      {plan.past ? <span className="qa-note warn">· 这个时间已经过了</span> : null}
      {plan.assumed === 'pm' && !plan.past ? <span className="qa-note">· 按下午理解</span> : null}
      <button type="button" className="qa-switch" onClick={onToggle} title="不按日程识别（Esc）">改成待办</button>
    </div>
  )
}
