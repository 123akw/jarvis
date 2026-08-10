import { useEffect, useState } from 'react'
import { getDashboard } from './api.js'

export default function Panels({ refreshKey, onData, onExpired }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => getDashboard()
      .then(x => { if (alive) { setD(x); onData?.(x) } })
      .catch(e => { if (e.message === '401') onExpired?.() })
    load()
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [refreshKey])

  if (!d) return null
  const today = d.time.slice(0, 10)
  const nowMin = d.time.slice(0, 16)
  const sch = d.schedule.filter(x => x.when.slice(0, 10) >= today)
  return (
    <section className="right">
      <div className="pane card">
        <div className="eyebrow">今日日程 <small>{sch.length ? `${sch.length} 项` : ''}</small></div>
        {sch.length === 0 && <div className="empty">今日无安排</div>}
        <ul>{sch.slice(0, 8).map(x => (
          <li key={x.id}>
            <span className={`when${x.when < nowMin ? ' over' : ''}`}>{x.when.slice(5)}</span>
            <span>{x.title}</span>
          </li>
        ))}</ul>
      </div>
      <div className="pane card">
        <div className="eyebrow">待办 <small>{d.todos.length ? `${d.todos.length} 项待办` : '已清空'}</small></div>
        {d.todos.length === 0 && <div className="empty">清单已清空</div>}
        <ul>{d.todos.slice(0, 8).map(x => (
          <li key={x.id}><span className="tickbox">[ ]</span><span>{x.content}</span></li>
        ))}</ul>
      </div>
      <div className="pane card">
        <div className="eyebrow">备忘 <small>{d.memos.length ? `${d.memos.length} 条` : ''}</small></div>
        {d.memos.length === 0 && <div className="empty">暂无备忘</div>}
        <ul>{d.memos.slice(-5).reverse().map(x => (
          <li key={x.id}><span className="tickbox">·</span><span>{x.content}</span></li>
        ))}</ul>
      </div>
    </section>
  )
}
