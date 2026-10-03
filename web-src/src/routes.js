import { useEffect, useState } from 'react'

/* 页面路由（不引路由库）。第十五轮的路径约定（见 docs/proposals/2026-10-round15-market.md）：
 *   /              智能体市场（主域名首页，未登录也能逛）
 *   /login         登录页（?u=<用户名> 预填；?next= 登录后去哪，只接受站内路径）
 *   /app           主应用（对话 / 今日板，需登录）
 *   /flows         我的流程：流程列表、模板、一句话生成（需登录）
 *   /flows/<id>    流程画布（第十八轮，节点图编辑与运行；<id> 为 new 时是新建）
 *   /approve/<id>  关键动作同意页（第二十一轮起通用：后台任务 / 对话里要你同意的动作；通知里的链接点开就是这里；需登录）
 *   /admin         管理后台（第二十轮，用量、配额、告警；仅 Owner）
 *   /p/<slug>      某个已生成平台的入口：品牌化登录页 / 装到主屏（PWA）
 * 旧链接兼容（redirectFor，地址栏原地替换、不留历史）：
 *   /market        → /（查询参数保留）
 *   /?u=<用户名>    → /login?u=<用户名>（第十四轮市场结果页的二维码、旧分享链接）
 *   其它未知路径     → /（服务端只对上面这些路径回 index.html，走到这里的多半是手误，回首页比死胡同有用）
 * 服务端对这些路径都回 index.html（见 jarvis/server.py「静态页」）。
 * 站内链接一律用下面的常量与函数，不要再手写 '/'、'/?u='。 */
export const MARKET_PATH = '/'
export const LOGIN_PATH = '/login'
export const APP_PATH = '/app'

const cleanPath = pathname => (String(pathname || '/').replace(/\/+$/, '') || '/')

export function parseRoute(pathname = '/') {
  const path = cleanPath(pathname)
  if (path === MARKET_PATH) return { name: 'market', params: {} }
  if (path === LOGIN_PATH) return { name: 'login', params: {} }
  if (path === APP_PATH) return { name: 'app', params: {} }
  if (path === '/flows') return { name: 'flows', params: {} }
  if (path === '/admin') return { name: 'admin', params: {} }
  const a = path.match(/^\/approve\/([A-Za-z0-9_-]{6,64})$/)
  if (a) return { name: 'approve', params: { id: a[1] } }
  const f = path.match(/^\/flows\/([A-Za-z0-9_-]{1,40})$/)
  if (f) return { name: 'flows', params: { id: f[1] } }
  const m = path.match(/^\/p\/([A-Za-z0-9_-]{3,40})$/)
  if (m) return { name: 'platform', params: { slug: m[1] } }
  if (path === '/market') return { name: 'legacy-market', params: {} }
  return { name: 'notfound', params: {} }
}

/** 旧链接 / 未知路径该原地换去的地址（含查询参数）；不用换时返回 '' */
export function redirectFor(pathname = '/', search = '') {
  const { name } = parseRoute(pathname)
  const qs = String(search || '').replace(/^\?/, '')
  if (name === 'legacy-market') return redirectFor(MARKET_PATH, qs) || (qs ? `${MARKET_PATH}?${qs}` : MARKET_PATH)
  if (name === 'notfound') return MARKET_PATH
  if (name === 'market' && new URLSearchParams(qs).has('u')) return `${LOGIN_PATH}?${qs}`
  return ''
}

/** 登录后去哪：只接受本站路径（拒绝 //host、/\host、完整网址、控制字符），也不回登录页自己；不合格返回 '' */
export function safeNext(raw) {
  const s = String(raw || '').trim()
  if (!s.startsWith('/') || s.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(s)) return ''
  let url
  try { url = new URL(s, 'http://jv.invalid') } catch { return '' }
  if (url.origin !== 'http://jv.invalid') return ''
  if (parseRoute(url.pathname).name === 'login') return ''
  return url.pathname + url.search + url.hash
}

/** 登录页地址：username 预填账号，next 登录成功后跳去哪（只接受站内路径） */
export function loginHref(username = '', next = '') {
  const q = new URLSearchParams()
  if (username) q.set('u', String(username))
  const to = safeNext(next)
  if (to) q.set('next', to)
  const qs = q.toString()
  return qs ? `${LOGIN_PATH}?${qs}` : LOGIN_PATH
}

/** 页面标题：市场与登录页各有自己的；主应用沿用 index.html 的；流程页 / 平台入口自己设，这里返回 '' 不管 */
export const APP_TITLE = 'J.A.R.V.I.S. · 私人管家'
export function pageTitle(name) {
  if (name === 'market') return '贾维斯 · 智能体市场'
  if (name === 'login') return '登录 · 贾维斯'
  if (name === 'app') return APP_TITLE
  if (name === 'admin') return '管理后台 · 贾维斯'
  if (name === 'approve') return '等你确认 · 贾维斯'
  return ''
}

const ROUTE_EVENT = 'jv:route'

/** 站内跳转：改地址栏并通知 useRoute 重渲染（不整页刷新） */
export function navigate(to, { replace = false } = {}) {
  if (typeof window === 'undefined') return
  if (to === window.location.pathname + window.location.search) return
  window.history[replace ? 'replaceState' : 'pushState']({}, '', to)
  window.dispatchEvent(new Event(ROUTE_EVENT))
}

/** 读当前地址；是旧链接 / 未知路径就先原地换成新地址（hash 保留），再解析 */
function currentRoute() {
  const { pathname, search, hash } = window.location
  const to = redirectFor(pathname, search)
  if (to) window.history.replaceState(window.history.state, '', to + hash)
  return parseRoute(window.location.pathname)
}

export function useRoute() {
  const [route, setRoute] = useState(currentRoute)
  useEffect(() => {
    const sync = () => setRoute(currentRoute())
    window.addEventListener('popstate', sync)
    window.addEventListener(ROUTE_EVENT, sync)
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener(ROUTE_EVENT, sync) }
  }, [])
  return route
}

/** 进场动画每次打开 / 刷新都播（市场、登录页、主应用、流程页都播）；
 *  只有别人的品牌智能体入口 /p/<slug> 不播——那里是对方的名字和配色，不该冒出「我是贾维斯」 */
export function introAllowed(pathname = '/', search = '') {
  const to = redirectFor(pathname, search)
  return parseRoute(to ? to.split('?')[0] : pathname).name !== 'platform'
}

/** 流程画布地址（第十八轮）：flowHref() 是列表，flowHref('new') 新建，flowHref(id) 打开某条 */
export function flowHref(id = '') {
  return id ? `/flows/${encodeURIComponent(id)}` : '/flows'
}
