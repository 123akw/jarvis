import { useEffect, useRef, useState } from 'react'
import { completeReminder, getPendingReminders, snoozeReminder } from './api.js'
import Icon from './Icon.jsx'

const SNOOZE_MINUTES = 10
const RECEIPT_MS = 2400

/** 日程主动提醒：每 30 秒领取一次到点日程（服务端按通道只发一次），顶栏下方弹出玻璃提示条。
 *  日程提醒可「稍后 10 分」或「完成」（任一渠道处理过，其他渠道不再催）；巡检消息只有「知道了」。 */
export default function Reminders({ onExpired }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef([])

  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const r = await getPendingReminders()
        if (alive && Array.isArray(r.items) && r.items.length) {
          setToasts(ts => {
            const seen = new Set(ts.map(t => t.key))
            const fresh = []
            for (const i of r.items) {
              const key = `${i.id}@${i.at || i.when}`
              if (!seen.has(key)) { seen.add(key); fresh.push({ ...i, key }) }
            }
            return fresh.length ? [...ts, ...fresh] : ts
          })
        }
      } catch (e) {
        if (e.message === '401') onExpired?.()
      }
    }
    poll()
    const t = setInterval(poll, 30000)
    return () => { alive = false; clearInterval(t); timers.current.forEach(clearTimeout) }
  }, [])

  const drop = key => setToasts(ts => ts.filter(x => x.key !== key))
  const patch = (key, change) => setToasts(ts => ts.map(x => (x.key === key ? { ...x, ...change } : x)))

  async function act(t, action) {
    patch(t.key, { busy: true, note: '' })
    try {
      const r = action === 'snooze' ? await snoozeReminder(t.id, t.at, SNOOZE_MINUTES) : await completeReminder(t.id, t.at)
      if (r.status === 'snoozed') {
        patch(t.key, { busy: false, note: `好的，${String(r.until || '').slice(11)} 再提醒你` })
        timers.current.push(setTimeout(() => drop(t.key), RECEIPT_MS))
      } else {
        drop(t.key)
      }
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      if (e.status === 404 || e.status === 409) { drop(t.key); return }   // 日程已删或已改期：这条提醒作废
      patch(t.key, { busy: false, note: '没成功，再试一次' })
    }
  }

  if (!toasts.length) return null
  return (
    <div className="reminder-stack" role="alert">
      {toasts.map(t => {
        const actionable = typeof t.id === 'number' && Boolean(t.at)
        const settled = t.note && t.note.startsWith('好的')
        return (
          <div key={t.key} className="reminder-toast">
            <span className="rt-icon"><Icon name="today" size={16} /></span>
            <span className="rt-body">
              {settled ? t.note : <><b>{t.when.slice(11)}</b>　{t.title}</>}
              {t.note && !settled ? <span className="jv-muted">　{t.note}</span> : null}
            </span>
            {settled ? null : actionable ? (
              <>
                <button className="rt-ok" disabled={t.busy} onClick={() => act(t, 'snooze')}>稍后 {SNOOZE_MINUTES} 分</button>
                <button className="rt-ok" disabled={t.busy} onClick={() => act(t, 'done')}>完成</button>
              </>
            ) : (
              <button className="rt-ok" onClick={() => drop(t.key)}>知道了</button>
            )}
          </div>
        )
      })}
    </div>
  )
}
