import { safeNext } from './routes.js'

/* 登录页 /login 的地址栏参数：
 *   ?u=<用户名>  市场生成账号后「去登录」、手机扫二维码都带着它，只用来预填用户名（不碰口令）。
 *               浏览器里已登着别的账号就先让用户确认换号（见 App.jsx），不再悄悄进旧账号。
 *   ?next=<路径> 登录成功后去哪（未登录访问 /app、/flows 时带上）；只认本站路径，见 routes.js 的 safeNext。 */
export const PREFILL_PARAM = 'u'
export const NEXT_PARAM = 'next'

export function readPrefillUser() {
  try { return (new URLSearchParams(window.location.search).get(PREFILL_PARAM) || '').trim().slice(0, 64) } catch { return '' }
}

/** 登录后该去的本站路径；没有或不合格（站外地址、登录页自己）返回 '' */
export function readNextParam() {
  try { return safeNext(new URLSearchParams(window.location.search).get(NEXT_PARAM)) } catch { return '' }
}

/** 把 ?u= 从地址栏清掉（其余参数与 hash 原样保留），不留历史记录 */
export function clearPrefillParam() {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(PREFILL_PARAM)) return
    url.searchParams.delete(PREFILL_PARAM)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  } catch { /* 清不掉不影响登录 */ }
}

/** 用户名是否同一个账号（服务端不分大小写） */
export function sameUser(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
}
