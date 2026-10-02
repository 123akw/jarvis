import { useEffect, useState } from 'react'
import { dismissFreshMemory, getMemoryState } from './api.js'
import Icon from './Icon.jsx'
import { setReceipts } from './memoryPrefs.js'

/** 「今日」板一行：夜间蒸馏写进了新画像时提示「昨晚为你整理了 N 条记忆 · 查看」。
 *  N 为 0 时不渲染；「查看」打开记忆面板并高亮这批条目，看过或点 × 都不再提示。
 *  顺带把「显示记忆回执」开关同步给对话区（同一个接口，不多一次请求）。 */
export default function MemoryNotice({ onOpenMemory, onExpired }) {
  const [fresh, setFresh] = useState(null)

  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => getMemoryState())
      .then(s => {
        if (!alive || !s) return
        setReceipts(s.receipts !== false)
        setFresh(s.fresh || null)
      })
      .catch(e => { if (e?.message === '401') onExpired?.() })
    return () => { alive = false }
  }, [])   // 蒸馏一夜一次：挂载时读一次就够

  if (!fresh?.count) return null
  const when = (fresh.at || '00:00') < '12:00' ? '昨晚' : '今天'

  function dismiss() {
    setFresh(null)
    Promise.resolve().then(() => dismissFreshMemory()).catch(() => {})   // 失败只是明天不再提示，不打扰
  }

  return (
    <div className="mem-notice">
      <Icon name="sparkles" size={14} />
      <span className="mn-text">{when}为你整理了 {fresh.count} 条记忆</span>
      <button type="button" className="mn-open" onClick={() => { onOpenMemory?.(fresh.ids || []); dismiss() }}>查看</button>
      <button type="button" className="mn-x" aria-label="不再提示" title="不再提示" onClick={dismiss}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
