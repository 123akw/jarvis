import { useEffect, useState } from 'react'

/** 媒体查询订阅：不支持 matchMedia 的环境（测试、老浏览器）按不匹配处理 */
export function useMedia(query) {
  const get = () => {
    try { return !!window.matchMedia?.(query).matches } catch { return false }
  }
  const [on, setOn] = useState(get)
  useEffect(() => {
    let mq
    try { mq = window.matchMedia?.(query) } catch { mq = null }
    if (!mq) return undefined
    const sync = () => setOn(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [query])
  return on
}

export const WIDE = '(min-width: 960px)'
