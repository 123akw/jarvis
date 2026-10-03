import { useEffect, useState } from 'react'

/* 管理后台入口的小红点。这个文件会被主应用（Hud）和市场的首屏包引进去，
 * 所以只直接 fetch 一个数，不引 ./api.js（那边的字段补齐逻辑只在后台页里用）。 */

/** 只要未读告警数（GET /api/admin/alerts?limit=1 的 unread）；任何失败都当 0（旧服务端没有、不是 Owner 都静默） */
export async function getUnreadAlerts({ signal } = {}) {
  try {
    const r = await fetch('/api/admin/alerts?limit=1', { signal })
    if (!r.ok) return 0
    const data = await r.json()
    const n = Number(data?.unread)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** Owner 打开主应用 / 市场时取一次未读告警数；不是 Owner 不取 */
export function useAdminUnread(enabled) {
  const [unread, setUnread] = useState(0)
  useEffect(() => {
    if (!enabled) { setUnread(0); return undefined }
    const ctrl = new AbortController()
    getUnreadAlerts({ signal: ctrl.signal }).then(n => { if (!ctrl.signal.aborted) setUnread(n) })
    return () => ctrl.abort()
  }, [enabled])
  return unread
}

/** 菜单里的人话：「3 条未读告警」；没有就空 */
export const unreadText = n => (n > 0 ? `${n > 99 ? '99+' : n} 条未读告警` : '')
