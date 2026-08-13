/** 网页→桌面悬浮窗联动（纯逻辑，UI 见 DesktopHandoff.jsx）。
 * 桌面主进程监听 127.0.0.1:17789（desktop/wake-server.js）：
 * GET /ping 探活（800ms 超时），POST /wake {ticket} 唤起并接管登录态。
 * https 页面调 127.0.0.1 属浏览器「本机可信」例外；Chrome 私网预检由监听端应答。 */

export const WAKE_BASE = 'http://127.0.0.1:17789'
export const PROTOCOL_URL = 'jws://handoff'

/** 探活：悬浮窗在跑返回 { loggedIn }，不在跑 / 不是本应用返回 null。 */
export async function pingDesktop({ fetchImpl = fetch, timeoutMs = 800 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${WAKE_BASE}/ping`, { signal: controller.signal })
    if (!response.ok) return null
    const data = await response.json().catch(() => null)
    return data && data.app === 'jws-desktop' ? { loggedIn: Boolean(data.loggedIn) } : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 一键唤起：探活 → 领票 → /wake。返回四态之一：
 *  awakened（已亮出悬浮窗）/ not-running（未启动，附 jws:// 地址与指引）
 *  / ticket-failed（领票失败）/ wake-failed（唤起请求失败）。 */
export async function summonDesktop({ fetchTicket, fetchImpl = fetch, timeoutMs = 800 } = {}) {
  const alive = await pingDesktop({ fetchImpl, timeoutMs })
  if (!alive) {
    // 未启动：把票带进 jws://（应用若被协议拉起可直接接管）；领不到票也照样给指引
    let protocolUrl = PROTOCOL_URL
    try {
      const issued = await fetchTicket()
      if (issued && typeof issued.ticket === 'string' && issued.ticket) {
        protocolUrl = `${PROTOCOL_URL}?ticket=${encodeURIComponent(issued.ticket)}`
      }
    } catch { /* 指引照弹 */ }
    return { status: 'not-running', protocolUrl }
  }
  let ticket = ''
  try {
    const issued = await fetchTicket()
    if (!issued || typeof issued.ticket !== 'string' || !issued.ticket) throw new Error('no ticket')
    ticket = issued.ticket
  } catch {
    return { status: 'ticket-failed' }
  }
  try {
    const response = await fetchImpl(`${WAKE_BASE}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })
    if (!response.ok) return { status: 'wake-failed' }
    const data = await response.json().catch(() => ({}))
    return { status: 'awakened', loggedIn: Boolean(data.loggedIn) }
  } catch {
    return { status: 'wake-failed' }
  }
}
