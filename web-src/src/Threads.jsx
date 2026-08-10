import { useEffect, useState } from 'react'
import { deleteThread, getThreads } from './api.js'

function groupLabel(iso) {
  const d = new Date(iso.replace(' ', 'T'))
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.floor((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return '近 7 天'
  return '更早'
}

export default function Threads({ current, onSelect, onNew, refreshKey, onExpired }) {
  const [threads, setThreads] = useState([])

  useEffect(() => {
    getThreads().then(setThreads).catch(e => { if (e.message === '401') onExpired?.() })
  }, [refreshKey])

  async function remove(e, id) {
    e.stopPropagation()
    await deleteThread(id)
    setThreads(ts => ts.filter(t => t.id !== id))
    if (id === current) onNew()
  }

  const groups = []
  for (const t of threads) {
    const label = groupLabel(t.updated)
    let g = groups[groups.length - 1]
    if (!g || g.label !== label) { g = { label, items: [] }; groups.push(g) }
    g.items.push(t)
  }

  return (
    <div className="threads">
      <button className="newchat" onClick={onNew}>＋ 新对话</button>
      <div className="threadlist">
        {threads.length === 0 && <div className="empty">还没有历史对话</div>}
        {groups.map(g => (
          <div key={g.label}>
            <div className="tgroup">{g.label}</div>
            {g.items.map(t => (
              <div key={t.id}
                className={`titem${t.id === current ? ' on' : ''}`}
                onClick={() => onSelect(t.id)} title={t.title}>
                <span className="ttitle">{t.title}</span>
                <button className="tdel" onClick={e => remove(e, t.id)} title="删除">×</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
