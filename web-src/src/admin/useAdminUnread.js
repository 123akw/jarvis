import { useEffect, useState } from 'react'
import { getUnreadAlerts } from './api.js'

/** 管理后台入口的小红点：Owner 打开主应用 / 市场时取一次未读告警数（/api/admin/alerts?limit=1）。
 *  不是 Owner 不取；任何失败都当 0，入口照常显示。 */
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
