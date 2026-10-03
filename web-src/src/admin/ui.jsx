import { useEffect, useState } from 'react'

/* 管理后台里几处共用的小件：分段切换、窄屏判断、出错重试。 */

/** 分段切换（范围、排序）：一组按钮，选中的 aria-pressed=true */
export function Segmented({ label, options, value, onChange, size = 'md' }) {
  return (
    <div className={`ad-seg is-${size}`} role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.id} type="button" className={value === o.id ? 'on' : ''} aria-pressed={value === o.id}
          onClick={() => { if (value !== o.id) onChange(o.id) }}>
          {o.short ? <><span className="ad-seg-long">{o.label}</span><span className="ad-seg-short" aria-hidden="true">{o.short}</span></> : o.label}
        </button>
      ))}
    </div>
  )
}

/** 窄屏（≤720）：账号表换成卡片。没有 matchMedia 的环境（测试）按宽屏 */
export function useNarrow(query = '(max-width: 720px)') {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false)
  const [narrow, setNarrow] = useState(get)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(query)
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [query])
  return narrow
}

/** 一块内容没加载出来：说清楚怎么了，给「重试」 */
export function ErrorBox({ message, onRetry, compact = false }) {
  return (
    <div className={`ad-error${compact ? ' is-compact' : ''}`} role="alert">
      <span>{message || '没加载出来'}</span>
      {onRetry ? <button type="button" className="jv-btn jv-btn--sm" onClick={onRetry}>重试</button> : null}
    </div>
  )
}
