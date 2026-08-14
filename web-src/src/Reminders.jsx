import { useEffect, useState } from 'react'
import { getPendingReminders } from './api.js'

/** 日程主动提醒：每 30 秒领取一次到点日程（服务端按通道只发一次），顶栏下方弹金色提示条 */
export default function Reminders({ onExpired }) {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const r = await getPendingReminders()
        if (alive && Array.isArray(r.items) && r.items.length) {
          setToasts(ts => [...ts, ...r.items.map(i => ({ ...i, key: `${i.id}@${i.when}` }))])
        }
      } catch (e) {
        if (e.message === '401') onExpired?.()
      }
    }
    poll()
    const t = setInterval(poll, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (!toasts.length) return null
  return (
    <div className="reminder-stack" role="alert">
      {toasts.map(t => (
        <div key={t.key} className="reminder-toast">
          <span className="rt-icon">⏰</span>
          <span className="rt-body"><b>{t.when.slice(11)}</b>　{t.title}</span>
          <button className="rt-ok"
            onClick={() => setToasts(ts => ts.filter(x => x.key !== t.key))}>知道了</button>
        </div>
      ))}
    </div>
  )
}
