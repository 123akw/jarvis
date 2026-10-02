import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addMemo, addSchedule, deleteMemo, deleteSchedule, deleteTodo,
  emailMeeting, getDashboard, getMeeting, getMeetings, importMeetingTodos, patchTodo,
  renameMeetingSpeaker,
} from './api.js'
import Brief from './Brief.jsx'
import Icon from './Icon.jsx'
import { renderMarkdown } from './markdown.js'
import MemoryNotice from './MemoryNotice.jsx'
import QuickAdd from './QuickAdd.jsx'

const TODO_LIMIT = 8
const MEMO_LIMIT = 5
const pad = n => String(n).padStart(2, '0')
/** 新日程默认时间：下一个整点（datetime-local 格式） */
function nextHour(now = new Date()) {
  const d = new Date(now.getTime() + 60 * 60 * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 今日板：简报卡 + 记忆提示（各一行、可收）；日程 / 待办 / 备忘，可勾选、快速新增、删除；会议纪要卡片。
 *  待办输入框兼做「一句话速记」：写上时间就成日程。
 *  勾选是乐观更新（立即打勾、失败回滚）；任何写操作失败都就地说明并保留草稿。
 *  active：今日板此刻是否可见（简报只在被看见时生成）；quickSeed：⌘K「速记…」带来的草稿。 */
export default function Panels({ refreshKey, onData, onExpired, onAskMeeting, active = true, quickSeed = null, onOpenMemory }) {
  const [d, setD] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [meetings, setMeetings] = useState(null)   // {items, active}
  const [memoDraft, setMemoDraft] = useState('')
  const [schedDraft, setSchedDraft] = useState('')
  const [schedWhen, setSchedWhen] = useState(nextHour)
  const [doneIds, setDoneIds] = useState(() => new Set())   // 已点勾、等服务器确认的待办
  const [showAll, setShowAll] = useState({ todos: false, memos: false })
  const [err, setErr] = useState('')
  const errTimer = useRef(0)
  const aliveRef = useRef(true)

  const load = () => Promise.all([
    getDashboard()
      .then(x => { if (aliveRef.current) { setD(x); setLoadErr(''); onData?.(x) } })
      .catch(e => {
        if (e.message === '401') onExpired?.()
        else if (aliveRef.current) setLoadErr(e.message || '读取失败')
      }),
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
  useEffect(() => () => clearTimeout(errTimer.current), [])

  function flash(text) {
    setErr(text)
    clearTimeout(errTimer.current)
    errTimer.current = setTimeout(() => setErr(''), 5000)
  }

  /** 写操作：成功后刷新；失败（非 401）回滚 + 就地提示，同样刷新一次对齐服务端 */
  async function act(fn, failText, rollback) {
    try {
      await fn()
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return false }
      rollback?.()
      flash(failText)
      await load()
      return false
    }
    await load()
    return true
  }

  function complete(x) {
    setDoneIds(s => new Set(s).add(x.id))
    void act(async () => {
      await patchTodo(x.id, true)
      await sleep(450)   // 让打勾动画播完再从列表里拿掉
    }, `没能完成「${x.content}」，请稍后再试`, () => setDoneIds(s => {
      const n = new Set(s); n.delete(x.id); return n
    }))
  }

  async function submitMemo() {
    const text = memoDraft.trim()
    if (!text) return
    setMemoDraft('')
    await act(() => addMemo(text), '没能记下这条备忘，请稍后再试', () => setMemoDraft(text))
  }

  async function submitSched() {
    const title = schedDraft.trim()
    if (!title) return
    if (!schedWhen) { flash('请先选好日程时间'); return }
    const when = schedWhen.replace('T', ' ')
    setSchedDraft('')
    const ok = await act(() => addSchedule(title, when), '没能添加这条日程，请稍后再试', () => setSchedDraft(title))
    if (ok) setSchedWhen(nextHour())
  }

  const today = d ? d.time.slice(0, 10) : ''
  const sch = useMemo(() => (d ? d.schedule.filter(x => x.when.slice(0, 10) >= today) : []), [d, today])

  if (!d) {
    return loadErr ? (
      <div className="today-state" role="alert">
        <p>暂时读不到今日数据</p>
        <button type="button" className="jv-btn jv-btn--sm" onClick={() => { setLoadErr(''); load() }}>重试</button>
      </div>
    ) : <div className="today-state" role="status"><span className="today-spinner" aria-hidden="true" />正在读取今日…</div>
  }
  const nowMin = d.time.slice(0, 16)
  // 今天的日程只显示时刻，之后几天的带上日期
  const whenText = when => (when.slice(0, 10) === today ? when.slice(11, 16) : when.slice(5, 16))
  const todos = showAll.todos ? d.todos : d.todos.slice(0, TODO_LIMIT)
  const memosAll = d.memos.slice().reverse()
  const memos = showAll.memos ? memosAll : memosAll.slice(0, MEMO_LIMIT)
  // 超出上限不再静默截掉：给出「还有 N 项未显示」，点开看全部
  const more = (key, total, shown, unit, limit) => (total > limit ? (
    <button type="button" className="today-more" onClick={() => setShowAll(v => ({ ...v, [key]: !v[key] }))}>
      {showAll[key] ? '收起' : `还有 ${total - shown} ${unit}未显示`}
    </button>
  ) : null)
  return (
    <>
      {err ? <div className="today-err" role="alert">{err}</div> : null}
      <Brief active={active} refreshKey={refreshKey} onExpired={onExpired} />
      <MemoryNotice onOpenMemory={onOpenMemory} onExpired={onExpired} />
      <section className="today-sec" aria-label="日程">
        <h3 className="today-h">日程 <small>{sch.length ? `${sch.length} 项` : ''}</small></h3>
        {sch.length === 0 && <div className="empty">今日无安排</div>}
        <ul className="today-list">{sch.slice(0, 8).map(x => (
          <li key={x.id} className={`prow sched${x.when < nowMin ? ' past' : ''}`}>
            <span className={`when${x.when < nowMin ? ' over' : ''}`}>{whenText(x.when)}</span>
            <span className="ptxt">{x.title}</span>
            <button type="button" className="pdel" title="删除这条日程" aria-label={`删除日程：${x.title}`}
              onClick={() => act(() => deleteSchedule(x.id), '没能删除这条日程，请稍后再试')}><Icon name="close" size={14} /></button>
          </li>
        ))}</ul>
        <div className={`jv-add-row sched-add${schedDraft.trim() ? ' armed' : ''}`}>
          <input value={schedDraft} placeholder="＋ 添加日程，回车确认" aria-label="新日程"
            onChange={e => setSchedDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitSched() }} />
          {schedDraft.trim() ? (
            <input type="datetime-local" className="sched-when" aria-label="日程时间" value={schedWhen}
              onChange={e => setSchedWhen(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitSched() }} />
          ) : null}
        </div>
      </section>
      <section className="today-sec" aria-label="待办">
        <h3 className="today-h">待办 <small>{d.todos.length ? `${d.todos.length} 项待办` : '已清空'}</small></h3>
        {d.todos.length === 0 && <div className="empty">清单已清空</div>}
        <ul className="today-list">{todos.map(x => {
          const done = doneIds.has(x.id)
          return (
            <li key={x.id} className={`prow${done ? ' done' : ''}`}>
              <input type="checkbox" className="ptick" checked={done} disabled={done}
                aria-label={`完成：${x.content}`}
                onChange={() => complete(x)} />
              <span className="ptxt">{x.content}</span>
              <button type="button" className="pdel" title="删除这条待办" aria-label={`删除待办：${x.content}`}
                onClick={() => act(() => deleteTodo(x.id), '没能删除这条待办，请稍后再试')}><Icon name="close" size={14} /></button>
            </li>
          )
        })}</ul>
        {more('todos', d.todos.length, todos.length, '项', TODO_LIMIT)}
        <QuickAdd seed={quickSeed} onChanged={load} onExpired={onExpired} />
      </section>
      <section className="today-sec" aria-label="备忘">
        <h3 className="today-h">备忘 <small>{d.memos.length ? `${d.memos.length} 条` : ''}</small></h3>
        {d.memos.length === 0 && <div className="empty">暂无备忘</div>}
        <ul className="today-list">{memos.map(x => (
          <li key={x.id} className="prow">
            <span className="tickbox" aria-hidden="true" />
            <span className="ptxt">{x.content}</span>
            <button type="button" className="pdel" title="删除这条备忘" aria-label={`删除备忘：${x.content}`}
              onClick={() => act(() => deleteMemo(x.id), '没能删除这条备忘，请稍后再试')}><Icon name="close" size={14} /></button>
          </li>
        ))}</ul>
        {more('memos', d.memos.length, memos.length, '条', MEMO_LIMIT)}
        <div className="jv-add-row">
          <input value={memoDraft} placeholder="＋ 记一条备忘，回车确认" aria-label="新备忘"
            onChange={e => setMemoDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitMemo() }} />
        </div>
      </section>
      <MeetingsCard meetings={meetings} onExpired={onExpired}
        onAskMeeting={onAskMeeting} onImported={load} />
    </>
  )
}

/** 纪要正文：Markdown 渲染（DOMPurify 消毒），没有纪要时退回转写原文 */
function Minutes({ detail }) {
  const html = useMemo(() => (detail.minutes ? renderMarkdown(detail.minutes) : ''), [detail.minutes])
  if (!html) {
    return <pre className="meeting-minutes is-raw">{'（未生成纪要，仅有转写）\n\n' + String(detail.transcript || '').slice(0, 2000)}</pre>
  }
  return <div className="meeting-minutes jbody" dangerouslySetInnerHTML={{ __html: html }} />
}

/** 会议纪要卡片：列出最近的会议，点开看纪要；可重发邮件、导入待办、就会议追问 */
function MeetingsCard({ meetings, onExpired, onAskMeeting, onImported }) {
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [note, setNote] = useState('')
  const [renFrom, setRenFrom] = useState('')
  const [renName, setRenName] = useState('')
  const speakers = detail
    ? [...new Set(String(detail.transcript || '').match(/对方\d*(?=：)/g) || [])]
    : []
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
  async function importTodos(id) {
    setNote('导入中…')
    try {
      const r = await importMeetingTodos(id)
      setNote(r.imported ? `已把 ${r.imported} 条属于我的待办导入任务台` : '没有需要导入的新待办')
      if (r.imported) onImported?.()
    } catch (e) { if (e.message === '401') onExpired?.(); else setNote(e.message || '导入失败') }
  }
  async function rename() {
    const speaker = renFrom || speakers[0]
    if (!speaker || !renName.trim() || !detail) return
    setNote('改名中…')
    try {
      await renameMeetingSpeaker(detail.id, speaker, renName.trim())
      setDetail(await getMeeting(detail.id))
      setNote(`已把「${speaker}」改为「${renName.trim()}」`)
      setRenName('')
    } catch (e) { if (e.message === '401') onExpired?.(); else setNote(e.message || '改名失败') }
  }
  function ask() {
    if (!detail || !onAskMeeting) return
    onAskMeeting(`以下是我${detail.started_at}的会议《${detail.title}》记录，请先用一句话确认已读，我接下来会就它追问：\n\n${detail.minutes || '（未生成纪要）'}\n\n===== 原始转写（可能截断）=====\n${String(detail.transcript || '').slice(0, 6000)}`)
    setNote('会议记录已发进对话，直接提问即可')
  }
  return (
    <section className="today-sec" aria-label="会议纪要">
      <h3 className="today-h">会议纪要 <small className={meetings.active ? 'live' : ''}>{meetings.active ? '● 监控中' : `${meetings.items.length} 场`}</small></h3>
      {meetings.items.length === 0 && <div className="empty">会议监控中，结束后在这里看纪要</div>}
      <ul className="today-list">{meetings.items.slice(0, 5).map(x => (
        <li key={x.id} className={`prow meeting-row${openId === x.id ? ' on' : ''}`}>
          <span className="when">{String(x.started_at).slice(5, 16)}</span>
          <button type="button" className="ptxt meeting-open" onClick={() => void toggle(x.id)}
            aria-expanded={openId === x.id} title="查看纪要">
            {x.title}{x.mailed_to ? <span className="meeting-mailed" title={`已发送至 ${x.mailed_to}`}> ✉</span> : ''}
          </button>
          <button type="button" className="pdel" title="重发纪要邮件" aria-label="重发纪要邮件" onClick={() => void resend(x.id)}>
            <Icon name="mail" size={14} />
          </button>
        </li>
      ))}</ul>
      {openId !== null && (
        <div className="meeting-detail">
          {!detail && !note ? <div className="empty">读取中…</div> : null}
          {detail ? <Minutes detail={detail} /> : null}
          {detail ? (
            <div className="meeting-actions">
              <button type="button" onClick={() => void importTodos(detail.id)}>导入待办</button>
              <button type="button" onClick={ask}>就这场会议追问</button>
            </div>
          ) : null}
          {detail && speakers.length > 0 ? (
            <div className="meeting-rename">
              <select aria-label="选择说话人" value={renFrom || speakers[0]}
                onChange={e => setRenFrom(e.target.value)}>
                {speakers.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <input aria-label="说话人新名字" value={renName} placeholder="改成谁？如 张三"
                onChange={e => setRenName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void rename() }} />
              <button type="button" onClick={() => void rename()} disabled={!renName.trim()}>改名</button>
            </div>
          ) : null}
        </div>
      )}
      {note ? <div className="empty" role="status">{note}</div> : null}
    </section>
  )
}
