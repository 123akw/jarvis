import { useEffect, useRef, useState } from 'react'
import {
  addMemo, addSchedule, addTodo, deleteMemo, deleteSchedule, deleteTodo,
  getDashboard, patchTodo,
} from './api.js'

/** 任务台：日程 / 待办 / 备忘，可勾选、快速新增、删除；出错回退到重新拉取 */
export default function Panels({ refreshKey, onData, onExpired }) {
  const [d, setD] = useState(null)
  const [todoDraft, setTodoDraft] = useState('')
  const [memoDraft, setMemoDraft] = useState('')
  const aliveRef = useRef(true)

  const load = () => getDashboard()
    .then(x => { if (aliveRef.current) { setD(x); onData?.(x) } })
    .catch(e => { if (e.message === '401') onExpired?.() })

  useEffect(() => {
    aliveRef.current = true
    load()
    const t = setInterval(load, 30000)
    return () => { aliveRef.current = false; clearInterval(t) }
  }, [refreshKey])

  async function act(fn) {
    try { await fn() } catch (e) { if (e.message === '401') { onExpired?.(); return } }
    await load()
  }

  async function submitTodo() {
    const text = todoDraft.trim()
    if (!text) return
    setTodoDraft('')
    await act(() => addTodo(text))
  }

  async function submitMemo() {
    const text = memoDraft.trim()
    if (!text) return
    setMemoDraft('')
    await act(() => addMemo(text))
  }

  if (!d) return null
  const today = d.time.slice(0, 10)
  const nowMin = d.time.slice(0, 16)
  const sch = d.schedule.filter(x => x.when.slice(0, 10) >= today)
  return (
    <>
      <div className="pane card">
        <div className="eyebrow">今日日程 <small>{sch.length ? `${sch.length} 项` : ''}</small></div>
        {sch.length === 0 && <div className="empty">今日无安排</div>}
        <ul>{sch.slice(0, 8).map(x => (
          <li key={x.id} className="prow">
            <span className={`when${x.when < nowMin ? ' over' : ''}`}>{x.when.slice(5)}</span>
            <span className="ptxt">{x.title}</span>
            <button className="pdel" title="删除这条日程"
              onClick={() => act(() => deleteSchedule(x.id))}>×</button>
          </li>
        ))}</ul>
      </div>
      <div className="pane card">
        <div className="eyebrow">待办 <small>{d.todos.length ? `${d.todos.length} 项待办` : '已清空'}</small></div>
        {d.todos.length === 0 && <div className="empty">清单已清空</div>}
        <ul>{d.todos.slice(0, 8).map(x => (
          <li key={x.id} className="prow">
            <input type="checkbox" className="ptick" checked={false}
              aria-label={`完成：${x.content}`}
              onChange={() => act(() => patchTodo(x.id, true))} />
            <span className="ptxt">{x.content}</span>
            <button className="pdel" title="删除这条待办"
              onClick={() => act(() => deleteTodo(x.id))}>×</button>
          </li>
        ))}</ul>
        <div className="paddrow">
          <input value={todoDraft} placeholder="＋ 添加待办，回车确认"
            onChange={e => setTodoDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitTodo() }} />
        </div>
      </div>
      <div className="pane card">
        <div className="eyebrow">备忘 <small>{d.memos.length ? `${d.memos.length} 条` : ''}</small></div>
        {d.memos.length === 0 && <div className="empty">暂无备忘</div>}
        <ul>{d.memos.slice(-5).reverse().map(x => (
          <li key={x.id} className="prow">
            <span className="tickbox">·</span>
            <span className="ptxt">{x.content}</span>
            <button className="pdel" title="删除这条备忘"
              onClick={() => act(() => deleteMemo(x.id))}>×</button>
          </li>
        ))}</ul>
        <div className="paddrow">
          <input value={memoDraft} placeholder="＋ 记一条备忘，回车确认"
            onChange={e => setMemoDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitMemo() }} />
        </div>
      </div>
    </>
  )
}
