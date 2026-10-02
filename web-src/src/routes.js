import { useEffect, useState } from 'react'

/* 页面路由（不引路由库）：按 pathname 分到几个顶层页面，其余一律是主应用。
 *   /market        智能平台市场：挑技能 → 填职业 / 一句话描述 → 推荐 → 生成专属平台（未登录也能逛）
 *   /p/<slug>      某个已生成平台的入口：品牌化登录页 / 装到主屏（PWA）
 *   /flows         流程拼接：输入 → 工具 → 输出（需登录）
 *   其余           主应用（对话 / 今日板），登录后按账号的平台定制
 * 服务端对这些路径都回 index.html（见 jarvis/server.py「静态页」）。 */
export function parseRoute(pathname = '/') {
  const path = (pathname || '/').replace(/\/+$/, '') || '/'
  if (path === '/market') return { name: 'market', params: {} }
  if (path === '/flows') return { name: 'flows', params: {} }
  const m = path.match(/^\/p\/([A-Za-z0-9_-]{3,40})$/)
  if (m) return { name: 'platform', params: { slug: m[1] } }
  return { name: 'app', params: {} }
}

const ROUTE_EVENT = 'jv:route'

/** 站内跳转：改地址栏并通知 useRoute 重渲染（不整页刷新） */
export function navigate(to, { replace = false } = {}) {
  if (typeof window === 'undefined') return
  if (to === window.location.pathname + window.location.search) return
  window.history[replace ? 'replaceState' : 'pushState']({}, '', to)
  window.dispatchEvent(new Event(ROUTE_EVENT))
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname))
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', sync)
    window.addEventListener(ROUTE_EVENT, sync)
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener(ROUTE_EVENT, sync) }
  }, [])
  return route
}

/** 进场动画只在主应用和市场首屏播：别人的品牌平台入口、流程页不该先冒出贾维斯的开场 */
export function introAllowed(pathname) {
  const { name } = parseRoute(pathname)
  return name === 'app' || name === 'market'
}
