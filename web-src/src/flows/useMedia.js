import { useEffect, useState } from 'react'

/** 媒体查询订阅：jsdom / 老浏览器没有 matchMedia 时恒为 false（按桌面、有动效处理） */
export function useMedia(query) {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [match, setMatch] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [query])
  return match
}

export const NARROW = '(max-width: 760px)'
export const REDUCED = '(prefers-reduced-motion: reduce)'
