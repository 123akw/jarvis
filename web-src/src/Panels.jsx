import { useEffect, useRef, useState } from 'react'
import {
  addMemo, addSchedule, addTodo, deleteMemo, deleteSchedule, deleteTodo,
  emailMeeting, getDashboard, getMeeting, getMeetings, patchTodo,
} from './api.js'

/** 任务台：日程 / 待办 / 备忘，可勾选、快速新增、删除；出错回退到重新拉取 */
export default function Panels({ refreshKey, onData, onExpired }) {
  const [d, setD] = useState(null)
  const [meetings, setMeetings] = useState(null)   // {items, active}
  const [todoDraft, setTodoDraft] = useState('')
  const [memoDraft, setMemoDraft] = useState('')
  const aliveRef = useRef(true)

  const load = () => Promise.all([
    getDashboard()
      .then(x => { if (aliveRef.current) { setD(x); onData?.(x) } })
      .catch(e => { if (e.message === '401') onExpired?.() }),
    getMeetings()
      .then(m => { if (aliveRef.current) setMeetings(m) })
      .catch(() => {}),   // 旧服务端没有该端点也不影响任务台
  ])

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
      <MeetingsCard meetings={meetings} onExpired={onExpired} />
    </>
  )
}

/** 会议纪要卡片：列出最近的会议，点开看纪要、可重发邮件；监控中给状态点 */
function MeetingsCard({ meetings, onExpired }) {
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [note, setNote] = useState('')
  if (!meetings || (!meetings.items.length && !meetings.active)) return null
  async function toggle(id) {
    setNote('')
    if (openId === id) { setOpenId(null); setDetail(null); return }
    setOpenId(id); setDetail(null)
    try { setDetail(await getMeeting(id)) }
    catch (e) { if (e.message === '401') onExpired?.(); else setNote('纪要读取失败') }
  }
  async function resend(id) {
    setNote('发送中…')
    try { const r = await emailMeeting(id); setNote(`已发送至 ${r.to}`) }
    catch (e) { if (e.message === '401') onExpired?.(); else setNote(e.message || '发送失败') }
  }
  return (
    <div className="pane card">
      <div className="eyebrow">会议纪要 <small>{meetings.active ? '● 监控中' : `${meetings.items.length} 场`}</small></div>
      {meetings.items.length === 0 && <div className="empty">会议监控中，结束后在这里看纪要</div>}
      <ul>{meetings.items.slice(0, 5).map(x => (
        <li key={x.id} className="prow meeting-row">
          <span className="when">{String(x.started_at).slice(5, 16)}</span>
          <button className="ptxt meeting-open" onClick={() => void toggle(x.id)}
            title="查看纪要">{x.title}{x.mailed_to ? ' ✉' : ''}</button>
          <button className="pdel" title="重发纪要邮件" onClick={() => void resend(x.id)}>✉</button>
        </li>
      ))}</ul>
      {openId !== null && (
        <div className="meeting-detail">
          {!detail && !note ? <div className="empty">读取中…</div> : null}
          {detail ? <pre className="meeting-minutes">{detail.minutes || '（未生成纪要，仅有转写）\n\n' + detail.transcript.slice(0, 2000)}</pre> : null}
        </div>
      )}
      {note ? <div className="empty" role="status">{note}</div> : null}
    </div>
  )
}
