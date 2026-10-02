import { useEffect, useState } from 'react'
import { getDelivery, saveDelivery } from './api.js'
import './Delivery.css'

const errorText = error => error?.message === '401' ? '登录已失效，请重新登录。' : (error?.message || '操作失败。')

/** 设置中心 › 语音里的一小节「主动找你」：提醒、晨报、巡检走哪些渠道，几点免打扰。
 *  只显示已绑定的渠道；读取失败就整节不出现，不打扰其他设置。 */
export default function DeliverySettings({ onMessage, onExpired }) {
  const [data, setData] = useState(null)
  const [enabled, setEnabled] = useState({})
  const [dnd, setDnd] = useState({ enabled: false, start: '22:30', end: '08:00' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const d = await getDelivery()
        if (!alive) return
        setData(d)
        setEnabled(Object.fromEntries(d.channels.map(c => [c.id, c.enabled])))
        setDnd(d.dnd)
      } catch (error) {
        if (error?.message === '401') onExpired?.()
      }
    })()
    return () => { alive = false }
  }, [])

  async function save() {
    setBusy(true)
    try {
      await saveDelivery({
        channels: Object.keys(enabled).filter(id => enabled[id]),
        dnd_enabled: dnd.enabled, dnd_start: dnd.start, dnd_end: dnd.end,
      })
      onMessage?.('送达设置已保存。')
    } catch (error) {
      if (error.message === '401') onExpired?.()
      onMessage?.(errorText(error))
    } finally { setBusy(false) }
  }

  if (!data) return null
  const shown = data.channels.filter(c => c.available)
  const missing = data.channels.filter(c => !c.available).map(c => c.label)
  return <div className="provider-pane delivery-pane" role="group" aria-labelledby="delivery-title">
    <h3 className="delivery-title" id="delivery-title">主动找你</h3>
    <fieldset className="delivery-channels">
      <legend>日程提醒、晨报和巡检送达到</legend>
      {shown.map(c => (
        <label key={c.id} className="provider-check">
          <input type="checkbox" checked={Boolean(enabled[c.id])}
            onChange={event => setEnabled(v => ({ ...v, [c.id]: event.target.checked }))} />{c.label}
        </label>
      ))}
    </fieldset>
    <label className="provider-check">
      <input type="checkbox" checked={dnd.enabled} onChange={event => setDnd(v => ({ ...v, enabled: event.target.checked }))} />免打扰
    </label>
    {dnd.enabled ? <div className="delivery-dnd">
      <input aria-label="免打扰开始" type="time" value={dnd.start} onChange={event => setDnd(v => ({ ...v, start: event.target.value }))} />
      <span aria-hidden="true">–</span>
      <input aria-label="免打扰结束" type="time" value={dnd.end} onChange={event => setDnd(v => ({ ...v, end: event.target.value }))} />
    </div> : null}
    <p className="provider-risk">
      免打扰只拦巡检这类消息：先攒着，结束后合并成一条发你；你亲手设的日程提醒和晨报照常送达。
      {missing.length ? `${missing.join('、')}绑定后也会出现在这里。` : ''}
    </p>
    <div className="provider-actions"><button className="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存送达设置'}</button></div>
  </div>
}
