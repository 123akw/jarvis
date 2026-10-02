/** 网页→桌面悬浮窗联动（纯逻辑，UI 见 DesktopHandoff.jsx）。
 * 桌面主进程监听 127.0.0.1:17789（desktop/wake-server.js）：
 * GET /ping 探活，POST /wake {ticket} 唤起并接管登录态。
 *
 * 浏览器对「公网 https 页面访问本机」的限制（2026 实测 Chrome 149/154）：
 *  - Chrome / Edge 142+（Local Network Access）：要用户授权「此设备上的应用」
 *    （权限名 loopback-network；142~144 叫 local-network-access）。没授权时请求直接被拦，
 *    报 TypeError: Failed to fetch，控制台是「Permission was denied … `loopback` address space」；
 *    授权弹窗出现期间请求挂起，所以「待询问」时探活要给足时间等用户点「允许」。
 *    请求带 targetAddressSpace: 'loopback' 声明目标是本机（写成 'local' 会因地址空间不符被拦）。
 *  - Firefox 153+ 同理（「设备上的应用和服务」）。
 *  - Safari：把 http://127.0.0.1 当混合内容直接拦，没有放行开关 → 只能走 jws:// 协议。
 * 所以探活失败时不立刻弹指引：领票 → 打开 jws://handoff?ticket=… 拉起桌面端 → 轮询 /ping 约 6 秒。 */

export const WAKE_BASE = 'http://127.0.0.1:17789'
export const PROTOCOL_URL = 'jws://handoff'
/** 新名在前：Chrome 145+ / Firefox 153+ 用 loopback-network，Chrome 142~144 只认 local-network-access */
export const LOOPBACK_PERMISSION_NAMES = ['loopback-network', 'local-network-access']

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms))

/* 不认识 targetAddressSpace 取值的旧内核会同步抛 TypeError（…not a valid enum value of type IPAddressSpace），
 * 这种情况去掉声明重发一次；网络失败的 TypeError（Failed to fetch）原样抛出。 */
function isAddressSpaceOptionError(error) {
  return Boolean(error) && error.name === 'TypeError' && /targetAddressSpace|IPAddressSpace/.test(String(error.message))
}

/** 访问本机唤起服务：声明目标在本机（loopback），不支持该声明的浏览器自动退回普通请求。 */
export async function loopbackFetch(fetchImpl, url, init = {}) {
  try {
    return await fetchImpl(url, { ...init, targetAddressSpace: 'loopback' })
  } catch (error) {
    if (isAddressSpaceOptionError(error)) return fetchImpl(url, init)
    throw error
  }
}

/** 浏览器对本网站访问本机的授权：granted / prompt（会弹窗询问）/ denied / unsupported（查不到） */
export async function queryLoopbackPermission(permissions = globalThis.navigator?.permissions) {
  if (!permissions || typeof permissions.query !== 'function') return 'unsupported'
  for (const name of LOOPBACK_PERMISSION_NAMES) {
    try {
      const status = await permissions.query({ name })
      if (status && ['granted', 'prompt', 'denied'].includes(status.state)) return status.state
    } catch { /* 不认识这个权限名，换下一个 */ }
  }
  return 'unsupported'
}

/** 粗分浏览器，只用于提示文案与「Safari 必拦」的判断 */
export function browserFamily(userAgent = globalThis.navigator?.userAgent || '') {
  const ua = String(userAgent)
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox'
  if (/Edg\//.test(ua)) return 'edge'
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

/** 本页访问本机唤起服务的通行情况：
 *  open（已授权或查不到权限，直接试）/ prompt（会弹授权框）/ denied（用户拒过）/ mixed-content（Safari 的 https 页必拦） */
export async function loopbackAccess({ permissions, userAgent, secure } = {}) {
  const isSecure = secure ?? (globalThis.location?.protocol === 'https:')
  if (isSecure && browserFamily(userAgent) === 'safari') return 'mixed-content'
  const state = await queryLoopbackPermission(permissions)
  if (state === 'denied') return 'denied'
  if (state === 'prompt') return 'prompt'
  return 'open'
}

/** 探活：悬浮窗在跑返回 { loggedIn }，不在跑 / 被浏览器拦 / 不是本应用返回 null。 */
export async function pingDesktop({ fetchImpl = fetch, timeoutMs = 800 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await loopbackFetch(fetchImpl, `${WAKE_BASE}/ping`, { signal: controller.signal })
    if (!response.ok) return null
    const data = await response.json().catch(() => null)
    return data && data.app === 'jws-desktop' ? { loggedIn: Boolean(data.loggedIn) } : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 悬浮窗控制：show 显示 / hide 隐藏 / quit 彻底退出桌面端。
 *  返回 { status: 'done' | 'not-running' | 'failed' }。 */
export async function desktopWindow(action, { fetchImpl = fetch, timeoutMs = 800 } = {}) {
  const alive = await pingDesktop({ fetchImpl, timeoutMs })
  if (!alive) return { status: 'not-running' }
  try {
    const response = await loopbackFetch(fetchImpl, `${WAKE_BASE}/window`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    return response.ok ? { status: 'done' } : { status: 'failed' }
  } catch {
    return { status: 'failed' }
  }
}

async function issueTicket(fetchTicket) {
  try {
    const issued = await fetchTicket()
    return issued && typeof issued.ticket === 'string' && issued.ticket ? issued.ticket : ''
  } catch {
    return ''
  }
}

/* 已确认在跑：领票 → POST /wake（桌面端已登录时不会换票，只亮出悬浮窗） */
async function wakeRunning({ fetchTicket, fetchImpl }) {
  const ticket = await issueTicket(fetchTicket)
  if (!ticket) return { status: 'ticket-failed' }
  try {
    const response = await loopbackFetch(fetchImpl, `${WAKE_BASE}/wake`, {
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

/** 一键唤起。返回：
 *  awakened（已亮出悬浮窗；launched=true 表示是刚通过 jws:// 拉起的）
 *  / blocked（浏览器不让本页连本机：reason=denied|mixed-content，已用 jws:// 带票唤起，结果无法确认）
 *  / not-running（jws:// 拉起后约 6 秒仍探不到：多半没安装或没注册协议）
 *  / ticket-failed（领票失败）/ wake-failed（唤起请求失败）。
 *  onProgress 依次报 checking / permission-prompt / launching，供界面提示。 */
export async function summonDesktop({
  fetchTicket,
  fetchImpl = fetch,
  openProtocol = () => {},
  permissions,
  userAgent,
  secure,
  timeoutMs = 800,
  promptTimeoutMs = 30000,   // 浏览器授权弹窗挂起请求期间，给用户留够点「允许」的时间
  launchWaitMs = 6000,
  pollIntervalMs = 500,
  sleep = sleepFor,
  now = () => Date.now(),
  onProgress = () => {},
} = {}) {
  const progress = step => { try { onProgress(step) } catch { /* 提示失败不影响流程 */ } }
  const access = await loopbackAccess({ permissions, userAgent, secure })
  const pingTimeout = access === 'prompt' ? promptTimeoutMs : timeoutMs
  progress(access === 'prompt' ? 'permission-prompt' : 'checking')

  if (access === 'open' || access === 'prompt') {
    const alive = await pingDesktop({ fetchImpl, timeoutMs: pingTimeout })
    if (alive) return wakeRunning({ fetchTicket, fetchImpl })
  }

  // 探不到（没启动 / 被浏览器拦）：带票打开 jws://，应用被拉起或已在跑都能凭票接管登录
  const ticket = await issueTicket(fetchTicket)
  const protocolUrl = ticket ? `${PROTOCOL_URL}?ticket=${encodeURIComponent(ticket)}` : PROTOCOL_URL
  progress('launching')
  try { openProtocol(protocolUrl) } catch { /* 尽力而为 */ }
  if (access === 'denied' || access === 'mixed-content') {
    return { status: 'blocked', reason: access, browser: browserFamily(userAgent), protocolUrl }
  }

  const deadline = now() + launchWaitMs
  for (;;) {
    await sleep(pollIntervalMs)
    const alive = await pingDesktop({ fetchImpl, timeoutMs: pingTimeout })
    if (alive) {
      // 协议里的票可能已被冷启动的应用用掉：换一张新票走 /wake，已登录时桌面端会跳过换票
      const woke = await wakeRunning({ fetchTicket, fetchImpl })
      if (woke.status === 'awakened') return { ...woke, launched: true }
      if (woke.status === 'ticket-failed' && alive.loggedIn) return { status: 'awakened', loggedIn: true, launched: true }
      return woke
    }
    if (now() >= deadline) break
  }
  // 等完仍探不到：若是用户刚在授权弹窗里点了「阻止」，按浏览器拦截处理
  if (await queryLoopbackPermission(permissions) === 'denied') {
    return { status: 'blocked', reason: 'denied', browser: browserFamily(userAgent), protocolUrl }
  }
  return { status: 'not-running', protocolUrl }
}
