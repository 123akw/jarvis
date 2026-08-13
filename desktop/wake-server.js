/* 本机唤起监听：只绑 127.0.0.1 的主进程 HTTP 服务。
 * GET /ping 探活、POST /wake 收一次性接管票据并唤起悬浮窗。
 * 网页(https)调 127.0.0.1 走浏览器「本机可信」例外，但 Chrome 私网访问预检（PNA）
 * 要求预检响应带 Access-Control-Allow-Private-Network: true；Origin 白名单只放行
 * 生产域名与 http://localhost:*。票据只在内存转手，不落盘不写日志。
 * 此模块刻意不依赖 Electron，node --test 可直测。 */
'use strict'

const http = require('http')

const WAKE_PORT = 17789
const MAX_WAKE_BODY_BYTES = 4096

function isAllowedWakeOrigin(origin, serverOrigin) {
  if (typeof origin !== 'string' || !origin) return false
  if (serverOrigin && origin === serverOrigin) return true
  return /^http:\/\/localhost(:\d{1,5})?$/.test(origin)
}

/* jws://handoff?ticket=… 与 POST /wake 等价；解析失败一律 null，不猜测。 */
function parseHandoffUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'jws:') return null
  const host = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0]
  if (host !== 'handoff') return null
  const ticket = url.searchParams.get('ticket') || ''
  if (ticket && (ticket.length > 512 || !/^[A-Za-z0-9_-]+$/.test(ticket))) return null
  return { ticket }
}

function createWakeServer({
  serverOrigin = '',          // 生产域名（设置里 server URL 的 origin）
  isLoggedIn = () => false,   // 主进程会话网关是否已持有令牌
  onWake = () => {},          // 亮出悬浮窗/面板置顶
  exchangeTicket = async () => ({ ok: false }),  // 凭票换令牌（主进程网关）
  onUnavailable = () => {},   // 端口被占用等降级通知（面板提示，不崩）
  log = () => {},             // 只记事件名，绝不记票据/令牌
  port = WAKE_PORT,
  host = '127.0.0.1',
} = {}) {
  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => { finish(response, 500, {}, { error: 'internal' }) })
  })

  function corsHeaders(origin) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Private-Network': 'true',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
    }
  }

  function finish(response, status, headers, body) {
    if (response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
    response.end(JSON.stringify(body))
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      request.on('data', chunk => {
        total += chunk.length
        if (total > MAX_WAKE_BODY_BYTES) { request.destroy(); reject(new Error('body too large')); return }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      request.on('error', reject)
    })
  }

  async function handle(request, response) {
    const origin = request.headers.origin
    if (!isAllowedWakeOrigin(origin, serverOrigin)) {
      log('wake-origin-denied')
      finish(response, 403, {}, { error: 'origin is not allowed' })
      return
    }
    const cors = corsHeaders(origin)
    const path = (request.url || '').split('?')[0]
    if (request.method === 'OPTIONS') {  // Chrome PNA/CORS 预检
      finish(response, 204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '600',
      }, {})
      return
    }
    if (request.method === 'GET' && path === '/ping') {
      finish(response, 200, cors, { app: 'jws-desktop', loggedIn: Boolean(safeLoggedIn()) })
      return
    }
    if (request.method === 'POST' && path === '/wake') {
      let ticket = ''
      try {
        const raw = await readBody(request)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && typeof parsed.ticket === 'string' && parsed.ticket.length <= 512) {
            ticket = parsed.ticket
          }
        }
      } catch { finish(response, 400, cors, { error: 'invalid body' }); return }
      log('wake')
      try { onWake() } catch { /* 唤起失败不影响响应 */ }
      if (ticket && !safeLoggedIn()) {
        try {
          const result = await exchangeTicket(ticket)
          log(result && result.ok ? 'wake-exchange-ok' : 'wake-exchange-failed')
        } catch { log('wake-exchange-failed') }
      }
      finish(response, 200, cors, { ok: true, loggedIn: Boolean(safeLoggedIn()) })
      return
    }
    finish(response, 404, cors, { error: 'not found' })
  }

  function safeLoggedIn() {
    try { return Boolean(isLoggedIn()) } catch { return false }
  }

  function start() {
    return new Promise(resolve => {
      server.once('error', error => {
        const reason = error && error.code === 'EADDRINUSE' ? 'port-in-use' : 'listen-failed'
        log(`wake-server-${reason}`)
        try { onUnavailable(reason) } catch {}
        resolve({ ok: false, reason })
      })
      server.listen(port, host, () => {
        log('wake-server-listening')
        resolve({ ok: true, port: server.address().port })
      })
    })
  }

  function stop() {
    return new Promise(resolve => server.close(() => resolve()))
  }

  return { start, stop, port: () => (server.address() ? server.address().port : null) }
}

module.exports = { createWakeServer, isAllowedWakeOrigin, parseHandoffUrl, WAKE_PORT }
