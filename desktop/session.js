/* Main-process-only authenticated API gateway. This module deliberately has no Electron import. */
'use strict'

const MAX_EVENT_BYTES = 64 * 1024
const MAX_STREAM_BYTES = 2 * 1024 * 1024
const MAX_STREAM_EVENTS = 4096

const OPERATIONS = {
  session: { method: 'GET', path: () => '/api/session', validate: emptyBody },
  dashboard: { method: 'GET', path: () => '/api/dashboard', validate: emptyBody },
  history: { method: 'GET', path: () => '/api/history?thread_id=desktop', validate: desktopThread },
  deleteThread: { method: 'DELETE', path: () => '/api/thread?thread_id=desktop', validate: desktopThread },
  chat: { method: 'POST', path: () => '/api/chat', validate: chatBody },
  coding: { method: 'POST', path: () => '/api/local-status', validate: codingBody },
  wechatStatus: { method: 'GET', path: () => '/api/wechat/status', validate: emptyBody },
  wechatConnect: { method: 'POST', path: () => '/api/wechat/connect', validate: emptyBody },
  wechatDisconnect: { method: 'POST', path: () => '/api/wechat/disconnect', validate: emptyBody },
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
  function discard() {
    token = ''
    try { fs.unlinkSync(tokenPath()) } catch (error) {
      if (error.code !== 'ENOENT') {
        try { fs.writeFileSync(tokenPath(), Buffer.alloc(0), { mode: 0o600 }); fs.unlinkSync(tokenPath()) } catch {}
      }
    }
  }
  function persist(value) {
    encryptionReady()
    const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, origin: serverUrl, token: value }))
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const temp = `${tokenPath()}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    try {
      fs.writeFileSync(temp, encrypted, { mode: 0o600, flag: 'wx' })
      fs.chmodSync(temp, 0o600)
      fs.renameSync(temp, tokenPath())
    } catch (error) {
      try { fs.unlinkSync(temp) } catch {}
      throw error
    }
  }
  function load() {
    if (token || !fs.existsSync(tokenPath())) return Boolean(token)
    try {
      encryptionReady()
      const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(tokenPath())))
      if (stored.version !== 1 || stored.origin !== serverUrl || typeof stored.token !== 'string' || !stored.token || stored.token.length > 8192) {
        clear(); return false
      }
      token = stored.token
      return true
    } catch { discard(); return false }
  }
  function validated(operation, body, stream = false) {
    const spec = OPERATIONS[operation]
    if (!spec || (stream && operation !== 'chat')) throw new Error('operation is not allowed')
    return { spec, body: spec.validate(body) }
  }
  function requestInit(spec, body, signal) {
    const headers = token ? { 'X-JWS-Token': token } : {}
    const init = { method: spec.method, headers, ...(signal ? { signal } : {}) }
    if (spec.method !== 'GET' && spec.method !== 'DELETE') {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    return init
  }
  async function request(operation, suppliedBody) {
    const { spec, body } = validated(operation, suppliedBody)
    load()
    const response = await fetchImpl(serverUrl + spec.path(body), requestInit(spec, body))
    if (response.status === 401) clear()
    const data = await response.json().catch(() => ({}))
    return { status: response.status, ok: response.ok, data }
  }
  async function stream(operation, suppliedBody, { onEvent = () => {}, signal } = {}) {
    const { spec, body } = validated(operation, suppliedBody, true)
    load()
    try {
      const response = await fetchImpl(serverUrl + spec.path(body), requestInit(spec, body, signal))
      if (response.status === 401) { clear(); return { status: 401, ok: false } }
      if (!response.ok) return { status: response.status, ok: false }
      await readEvents(response, onEvent, signal)
      return { status: response.status, ok: true }
    } catch (error) {
      if (signal && signal.aborted) return { status: 0, ok: false, cancelled: true }
      throw error
    }
  }
  async function login(username, password) {
    if (typeof username !== 'string' || !username.trim() || username.length > 128 || typeof password !== 'string' || !password || password.length > 1024) {
      return { ok: false }
    }
    encryptionReady()
    const response = await fetchImpl(serverUrl + '/api/desktop/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    })
    if (!response.ok) { if (response.status === 401) clear(); return { ok: false, status: response.status } }
    const issued = await response.json()
    if (!issued.access_token || typeof issued.access_token !== 'string' || issued.access_token.length > 8192) return { ok: false }
    try { persist(issued.access_token) } catch (error) { discard(); throw error }
    token = issued.access_token
    return { ok: true }
  }
  function setServer(next) {
    if (!isAllowedServer(next, development)) throw new Error('server URL is not allowed')
    const normalized = next.replace(/\/$/, '')
    if (normalized === serverUrl) return
    clear()
    serverUrl = normalized
  }
  return { login, request, stream, clear, load, setServer, server: () => serverUrl }
}

async function readEvents(response, onEvent, signal) {
  if (!response.body) throw new Error('stream body is unavailable')
  const reader = response.body.getReader ? response.body.getReader() : null
  const iterator = !reader && response.body[Symbol.asyncIterator] ? response.body[Symbol.asyncIterator]() : null
  if (!reader && !iterator) throw new Error('stream body is unreadable')
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  let count = 0
  while (true) {
    if (signal && signal.aborted) throw abortError()
    const part = reader ? await reader.read() : await iterator.next()
    if (part.done) break
    const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value)
    total += bytes.byteLength
    if (total > MAX_STREAM_BYTES) throw new Error('stream byte limit exceeded')
    buffer += decoder.decode(bytes, { stream: true })
    if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES && !buffer.includes('\n\n')) throw new Error('stream event limit exceeded')
    const pieces = buffer.split('\n\n')
    buffer = pieces.pop()
    for (const piece of pieces) {
      if (Buffer.byteLength(piece) > MAX_EVENT_BYTES) throw new Error('stream event limit exceeded')
      const data = piece.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      if (!data) continue
      count += 1
      if (count > MAX_STREAM_EVENTS) throw new Error('stream event count limit exceeded')
      let parsed
      try { parsed = JSON.parse(data) } catch { throw new Error('invalid stream event') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid stream event')
      onEvent(parsed)
    }
  }
}

function abortError() { const error = new Error('stream cancelled'); error.name = 'AbortError'; return error }
function record(body) { return body !== null && typeof body === 'object' && !Array.isArray(body) }
function exact(body, allowed, label = 'body') {
  if (!record(body)) throw new Error(`invalid ${label}`)
  const keys = Object.keys(body)
  if (keys.some(key => !allowed.includes(key)) || allowed.some(key => !keys.includes(key))) throw new Error(`invalid ${label} field`)
  return body
}
function emptyBody(body) {
  if (body === undefined) return {}
  if (!record(body) || Object.keys(body).length) throw new Error('invalid empty body')
  return {}
}
function desktopThread(body) { exact(body, ['thread_id']); if (body.thread_id !== 'desktop') throw new Error('invalid desktop thread'); return { thread_id: 'desktop' } }
function chatBody(body) {
  exact(body, ['thread_id', 'message'])
  if (body.thread_id !== 'desktop') throw new Error('invalid desktop thread')
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 12000) throw new Error('invalid message')
  return { thread_id: 'desktop', message: body.message }
}
function codingBody(body) {
  exact(body, ['coding'])
  if (!Array.isArray(body.coding) || body.coding.length > 5) throw new Error('invalid coding body')
  return { coding: body.coding.map(item => codingItem(item)) }
}
function codingItem(item) {
  const fields = ['project', 'active', 'last_active', 'task', 'step', 'files', 'branch', 'dirty', 'commits_today', 'last_commit']
  if (!record(item) || Object.keys(item).some(key => !fields.includes(key))) throw new Error('invalid coding field')
  for (const key of ['project', 'last_active', 'task', 'step', 'branch', 'last_commit']) {
    if (key in item && (typeof item[key] !== 'string' || item[key].length > 256)) throw new Error(`invalid coding ${key}`)
  }
  if ('active' in item && typeof item.active !== 'boolean') throw new Error('invalid coding active')
  for (const key of ['dirty', 'commits_today']) if (key in item && (!Number.isInteger(item[key]) || item[key] < 0 || item[key] > 100000)) throw new Error(`invalid coding ${key}`)
  if ('files' in item && (!Array.isArray(item.files) || item.files.length > 3 || item.files.some(file => typeof file !== 'string' || file.length > 128))) throw new Error('invalid coding files')
  return item
}

module.exports = { createSessionGateway, isAllowedServer, readEvents }
