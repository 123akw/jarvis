import { useEffect, useRef, useState } from 'react'
import { ensureBrief, getBrief } from './api.js'
import Icon from './Icon.jsx'

const HIDE_KEY = 'jws_brief_hide'

function hiddenOn() {
  try { return localStorage.getItem(HIDE_KEY) || '' } catch { return '' }
}
function hideOn(date) {
  try { localStorage.setItem(HIDE_KEY, date) } catch { /* 隐私模式：只在本次会话里隐藏 */ }
}

/** 今日简报卡：「今日」板顶部，默认一行（AI 写的那句总览），点开看 2–3 行细节。
 *  只有「今日」板真的被看见（active）且当天还没生成时才 POST 一次——每账号每天最多 1 次模型调用；
 *  模型不可用时服务端退回规则摘要（source=fallback），这里照常显示、不报错。 */
export default function Brief({ active = true, refreshKey = 0, onExpired }) {
  const [brief, setBrief] = useState(null)
  const [open, setOpen] = useState(false)
  const [hiddenDate, setHiddenDate] = useState(hiddenOn)
  const posting = useRef(false)
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    alive.current = true
    Promise.resolve().then(() => getBrief())
      .then(b => { if (alive.current && b?.status) setBrief(b) })
      .catch(e => { if (e?.message === '401') onExpired?.() })
  }, [refreshKey])

  const waiting = brief && (brief.status === 'none' || brief.status === 'pending')
  useEffect(() => {
    if (!active || !waiting || posting.current || hiddenDate === brief.date) return
    posting.current = true
    Promise.resolve().then(() => ensureBrief())
      .then(b => { if (alive.current && b?.status) setBrief(b) })
      .catch(e => { if (e?.message === '401') onExpired?.() })
      .finally(() => { posting.current = false })
  }, [active, waiting])

  if (!brief || hiddenDate === brief.date) return null
  if (waiting) {
    return active ? (
      <div className="brief brief--loading" aria-busy="true" aria-label="正在整理今日简报">
        <span className="brief-skel" />
      </div>
    ) : null
  }
  if (brief.status !== 'ready' || !brief.headline) return null

  const ai = brief.source === 'model'
  const details = brief.details || []
  return (
    <section className={`brief${ai ? ' is-ai' : ''}${open ? ' open' : ''}`} aria-label="今日简报">
      <button type="button" className="brief-head" aria-expanded={open} onClick={() => setOpen(v => !v)}
        title={open ? '收起' : '展开简报'}>
        <span className="brief-ico"><Icon name={ai ? 'sparkles' : 'list'} size={15} /></span>
        <span className="brief-line">{brief.headline}</span>
        <Icon name="chevron" size={14} className="brief-chev" />
      </button>
      {open ? (
        <div className="brief-more">
          {details.map(line => <p key={line} className="brief-detail">{line}</p>)}
          <div className="brief-foot">
            <span>{ai ? `AI 整理于 ${brief.at || '今天'}` : '按今天的日程与待办汇总'}</span>
            <button type="button" className="brief-hide"
              onClick={() => { hideOn(brief.date); setHiddenDate(brief.date) }}>今天不再显示</button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
