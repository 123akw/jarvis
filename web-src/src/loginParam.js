/* 地址栏 ?u=<用户名>：市场生成账号后「去登录」、手机扫二维码都带着它，只用来预填用户名（不碰口令）。
 * App 启动时据此判断：浏览器里已登着别的账号就先让用户确认换号（见 App.jsx），不再悄悄进旧账号。 */
export const PREFILL_PARAM = 'u'

export function readPrefillUser() {
  try { return (new URLSearchParams(window.location.search).get(PREFILL_PARAM) || '').trim().slice(0, 64) } catch { return '' }
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
