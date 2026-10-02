import { useEffect, useRef, useState } from 'react'
import { deleteThread, getHistory, getThreads, renameThread } from './api.js'
import Icon from './Icon.jsx'

function groupLabel(iso) {
  const d = new Date(iso.replace(' ', 'T'))
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.floor((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return '近 7 天'
  return '更早'
}

export default function Threads({ current, onSelect, onNew, refreshKey, onExpired, onLoaded }) {
  const [threads, setThreads] = useState([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)      // 正在改名的会话 id
  const [draft, setDraft] = useState('')
  const [pendingDel, setPendingDel] = useState(null) // 等待二次确认删除的会话 id
  const delTimer = useRef(null)

  useEffect(() => {
    getThreads().then(setThreads).catch(e => { if (e.message === '401') onExpired?.() })
  }, [refreshKey])
  useEffect(() => () => clearTimeout(delTimer.current), [])
  useEffect(() => { onLoaded?.(threads) }, [threads])   // 顶栏标题与 ⌘K 跳转共用这份列表，不再重复拉取

  function askRemove(e, id) {
    e.stopPropagation()
    if (pendingDel !== id) {   // 第一击只进入确认态，3 秒不点自动还原
      setPendingDel(id)
      clearTimeout(delTimer.current)
      delTimer.current = setTimeout(() => setPendingDel(null), 3000)
      return
    }
    clearTimeout(delTimer.current)
    setPendingDel(null)
    void remove(id)
  }

  async function remove(id) {
    try {
      await deleteThread(id)
    } catch (e) {
      if (e.message === '401') onExpired?.()
      return
    }
    setThreads(ts => ts.filter(t => t.id !== id))
    if (id === current) onNew()
  }

  async function exportThread(e, t) {
    e.stopPropagation()
    try {
      const history = await getHistory(t.id)
      const doc = [`# ${t.title}`].concat(history.map(m =>
        m.role === 'user' ? `**我：**\n\n${m.content}` : `**贾维斯：**\n\n${m.content}`,
      )).join('\n\n---\n\n') + '\n'
      const blob = new Blob([doc], { type: 'text/markdown;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${t.title}.md`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (err) {
      if (err.message === '401') onExpired?.()
    }
  }

  function startEdit(e, t) {
    e.stopPropagation()
    setEditing(t.id)
    setDraft(t.title)
  }

  async function saveEdit(id) {
    const title = draft.trim()
    setEditing(null)
    if (!title || title === threads.find(t => t.id === id)?.title) return
    try {
      const r = await renameThread(id, title)
      setThreads(ts => ts.map(t => (t.id === id ? { ...t, title: r.title || title } : t)))
    } catch (e) {
      if (e.message === '401') onExpired?.()
    }
  }

  const q = query.trim().toLowerCase()
  const shown = q ? threads.filter(t => t.title.toLowerCase().includes(q)) : threads

  const groups = []
  for (const t of shown) {
    const label = groupLabel(t.updated)
    let g = groups[groups.length - 1]
    if (!g || g.label !== label) { g = { label, items: [] }; groups.push(g) }
    g.items.push(t)
  }

  return (
    <div className="threads">
      <button className="newchat" onClick={onNew}><Icon name="compose" size={17} />新对话</button>
      {threads.length > 0 && (
        <label className="tsearch-wrap">
          <Icon name="search" size={15} />
          <input className="tsearch" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="搜索对话…" aria-label="搜索对话" />
        </label>
      )}
      <div className="threadlist">
        {threads.length === 0 && <div className="empty">还没有历史对话</div>}
        {threads.length > 0 && shown.length === 0 && <div className="empty">没有匹配的对话</div>}
        {groups.map(g => (
          <div key={g.label}>
            <div className="tgroup">{g.label}</div>
            {g.items.map(t => (
              <div key={t.id}
                className={`titem${t.id === current ? ' on' : ''}`}
                onClick={() => editing !== t.id && onSelect(t.id)} title={t.title}>
                {editing === t.id ? (
                  <input className="trename" value={draft} autoFocus
                    onClick={e => e.stopPropagation()}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={() => saveEdit(t.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveEdit(t.id)
                      if (e.key === 'Escape') setEditing(null)
                    }} />
                ) : (
                  <span className="ttitle">{t.title}</span>
                )}
                <span className="tactions">
                  <button className="tdel trn" onClick={e => exportThread(e, t)} title="导出为 Markdown" aria-label="导出为 Markdown"><Icon name="download" size={15} /></button>
                  <button className="tdel trn" onClick={e => startEdit(e, t)} title="重命名" aria-label="重命名"><Icon name="pencil" size={15} /></button>
                  <button className={`tdel${pendingDel === t.id ? ' confirm' : ''}`}
                    onClick={e => askRemove(e, t.id)}
                    title={pendingDel === t.id ? '再点一次确认删除' : '删除'}
                    aria-label={pendingDel === t.id ? '再点一次确认删除' : '删除'}>
                    {pendingDel === t.id ? '确删' : <Icon name="trash" size={15} />}
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
