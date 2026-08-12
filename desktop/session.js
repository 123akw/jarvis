/* Main-process-only authenticated API gateway. This module deliberately has no Electron import. */
'use strict'

const OPERATIONS = {
  session: { method: 'GET', path: () => '/api/session' },
  dashboard: { method: 'GET', path: () => '/api/dashboard' },
  history: { method: 'GET', path: body => `/api/history?thread_id=${encodeURIComponent(thread(body).thread_id)}` },
  deleteThread: { method: 'DELETE', path: body => `/api/thread?thread_id=${encodeURIComponent(thread(body).thread_id)}` },
  chat: { method: 'POST', path: () => '/api/chat' },
  coding: { method: 'POST', path: () => '/api/local-status' },
  wechatStatus: { method: 'GET', path: () => '/api/wechat/status' },
  wechatConnect: { method: 'POST', path: () => '/api/wechat/connect' },
  wechatDisconnect: { method: 'POST', path: () => '/api/wechat/disconnect' },
}

function thread(body) {
  if (!body || body.thread_id !== 'desktop') throw new Error('invalid desktop thread')
  return body
}

function isAllowedServer(value, development) {
  try {
    const url = new URL(value)
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return Boolean(development && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]'))
  } catch { return false }
}

function createSessionGateway({ fetchImpl, safeStorage, fs, path, dataDir, server, development = false }) {
  if (!isAllowedServer(server, development)) throw new Error('server URL is not allowed')
  let serverUrl = server.replace(/\/$/, '')
  let token = ''
  const tokenPath = () => path.join(dataDir, 'desktop-session.enc')

  function encryptionReady() {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('secure encryption is unavailable')
  }
  function clear() {
    token = ''
    try { fs.unlinkSync(tokenPath()) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  function persist(value) {
    encryptionReady()
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(tokenPath(), safeStorage.encryptString(value), { mode: 0o600 })
    fs.chmodSync(tokenPath(), 0o600)
  }
  function load() {
    if (token || !fs.existsSync(tokenPath())) return Boolean(token)
    encryptionReady()
    token = safeStorage.decryptString(fs.readFileSync(tokenPath()))
    return Boolean(token)
  }
  async function execute(operation, body, stream = false) {
    const spec = OPERATIONS[operation]
    if (!spec || (stream && operation !== 'chat')) throw new Error('operation is not allowed')
    load()
    const headers = token ? { 'X-JWS-Token': token } : {}
    const init = { method: spec.method, headers }
    if (spec.method !== 'GET' && spec.method !== 'DELETE') {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body || {})
    }
    const response = await fetchImpl(serverUrl + spec.path(body), init)
    if (response.status === 401) clear()
    if (stream) return { status: response.status, ok: response.ok, events: await readEvents(response) }
    const data = await response.json().catch(() => ({}))
    return { status: response.status, ok: response.ok, data }
  }
  async function login(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return { ok: false }
    encryptionReady()
    const response = await fetchImpl(serverUrl + '/api/desktop/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    })
    if (!response.ok) { if (response.status === 401) clear(); return { ok: false, status: response.status } }
    const issued = await response.json()
    if (!issued.access_token || typeof issued.access_token !== 'string') return { ok: false }
    token = issued.access_token
    persist(token)
    return { ok: true }
  }
  function setServer(next) {
    if (!isAllowedServer(next, development)) throw new Error('server URL is not allowed')
    if (next.replace(/\/$/, '') !== serverUrl) clear()
    serverUrl = next.replace(/\/$/, '')
  }
  return { login, request: (operation, body) => execute(operation, body), stream: (operation, body) => execute(operation, body, true), clear, load, setServer, server: () => serverUrl }
}

async function readEvents(response) {
  if (!response.ok) return []
  const text = response.text ? await response.text() : ''
  return text.split('\n\n').flatMap(part => {
    if (!part.startsWith('data: ')) return []
    try { return [JSON.parse(part.slice(6))] } catch { return [] }
  })
}

module.exports = { createSessionGateway, isAllowedServer }
