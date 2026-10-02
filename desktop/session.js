/* Main-process-only authenticated API gateway. This module deliberately has no Electron import. */
'use strict'

const { MAX_DOWNLOAD_BYTES, filenameFromDisposition } = require('./file-download.js')

const MAX_EVENT_BYTES = 64 * 1024
const MAX_STREAM_BYTES = 2 * 1024 * 1024
const MAX_STREAM_EVENTS = 4096

const OPERATIONS = {
  session: { method: 'GET', path: () => '/api/session', validate: emptyBody },
  dashboard: { method: 'GET', path: () => '/api/dashboard', validate: emptyBody },
  remindersPending: { method: 'GET', path: () => '/api/reminders/pending', validate: emptyBody },
  reminderSnooze: { method: 'POST', path: body => `/api/reminders/${body.id}/snooze`, validate: reminderActBody, requestBody: body => ({ at: body.at, minutes: body.minutes }) },
  reminderDone: { method: 'POST', path: body => `/api/reminders/${body.id}/done`, validate: reminderActBody, requestBody: body => ({ at: body.at }) },
  todoPatch: { method: 'PATCH', path: body => `/api/todos/${body.id}`, validate: todoPatchBody, requestBody: body => ({ done: body.done }) },
  desktopCommands: { method: 'GET', path: () => '/api/desktop/commands', validate: emptyBody },
  voiceWakeCheck: { method: 'POST', path: () => '/api/voice/wake', validate: wakeCheckBody },
  voiceSettingsGet: { method: 'GET', path: () => '/api/voice/settings', validate: emptyBody },
  voiceSettingsPut: { method: 'PUT', path: () => '/api/voice/settings', validate: voiceSettingsBody },
  radioGet: { method: 'GET', path: () => '/api/radio', validate: emptyBody },
  radioPut: { method: 'PUT', path: () => '/api/radio', validate: radioBody },
  history: { method: 'GET', path: () => '/api/history?thread_id=desktop', validate: desktopThread },
  deleteThread: { method: 'DELETE', path: () => '/api/thread?thread_id=desktop', validate: desktopThread },
  chat: { method: 'POST', path: () => '/api/chat', validate: chatBody },
  coding: { method: 'POST', path: () => '/api/local-status', validate: codingBody },
  wechatStatus: { method: 'GET', path: () => '/api/wechat/status', validate: emptyBody },
  wechatConnect: { method: 'POST', path: () => '/api/wechat/connect', validate: emptyBody },
  wechatDisconnect: { method: 'POST', path: () => '/api/wechat/disconnect', validate: emptyBody },
  providerSettings: { method: 'GET', path: () => '/api/settings/providers', validate: emptyBody },
  providerTest: { method: 'POST', path: () => '/api/settings/llm/test', validate: llmSettingsBody },
  providerSave: { method: 'PUT', path: () => '/api/settings/llm', validate: llmSettingsBody },
  providerRestore: { method: 'DELETE', path: () => '/api/settings/llm', validate: settingsDeleteBody, requestBody: true },
  integrationTest: { method: 'POST', path: body => `/api/settings/integrations/${body.name}/test`, validate: integrationSettingsBody, requestBody: withoutName },
  integrationSave: { method: 'PUT', path: body => `/api/settings/integrations/${body.name}`, validate: integrationSettingsBody, requestBody: withoutName },
  integrationRestore: { method: 'DELETE', path: body => `/api/settings/integrations/${body.name}`, validate: integrationDeleteBody, requestBody: withoutName },
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
    // 钥匙串暂时打不开（例如首次以打包版「贾维斯.app」启动、系统询问还没点「允许」）不是密文坏了：
    // 保留文件当作未登录，钥匙串可用后照常读出，不让用户白白掉登录
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false
    try {
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
    if (spec.method !== 'GET' && (spec.method !== 'DELETE' || spec.requestBody)) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(typeof spec.requestBody === 'function' ? spec.requestBody(body) : body)
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
  /* 桌面接管：凭一次性票据换桌面令牌（服务端 /api/desktop/handoff/exchange）。
     与 login 同一条落盘链，但全程没有密码；票据用后即焚，不留在任何字段里。 */
  async function exchange(ticket) {
    if (typeof ticket !== 'string' || !ticket || ticket.length > 512) return { ok: false }
    encryptionReady()
    const response = await fetchImpl(serverUrl + '/api/desktop/handoff/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
    })
    if (!response.ok) return { ok: false, status: response.status }
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
  /* 语音通话 WebSocket：仅主进程使用。authToken 给 webRequest 握手头注入，
     令牌不经过渲染进程；voiceCallUrl 是唯一允许注入的精确地址。 */
  function authToken() { load(); return token }
  /* 文件空间下载（对话里的 /api/files/<id>）：只收已校验的 id，带桌面令牌取回内容，令牌不出主进程 */
  async function downloadFile(fileId) {
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(fileId)) throw new Error('file id is not allowed')
    load()
    if (!token) return { ok: false, status: 401 }
    const response = await fetchImpl(`${serverUrl}/api/files/${fileId}`, { method: 'GET', headers: { 'X-JWS-Token': token } })
    if (response.status === 401) { clear(); return { ok: false, status: 401 } }
    if (!response.ok) return { ok: false, status: response.status }
    const header = name => (response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : '') || ''
    if (Number(header('content-length')) > MAX_DOWNLOAD_BYTES) return { ok: false, status: 413 }
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > MAX_DOWNLOAD_BYTES) return { ok: false, status: 413 }
    return { ok: true, status: response.status, data, filename: filenameFromDisposition(header('content-disposition')) }
  }
  function voiceCallUrl() { return serverUrl.replace(/^http/, 'ws') + '/api/voice/call' }
  function meetingStreamUrl() { return serverUrl.replace(/^http/, 'ws') + '/api/meeting/stream' }
  return { login, exchange, request, stream, clear, load, setServer, server: () => serverUrl, authToken, voiceCallUrl, meetingStreamUrl, downloadFile }
}

function replaceSessionGateway({ currentGateway, previousSettings, nextSettings, createGateway, persistSettings }) {
  if (previousSettings.server === nextSettings.server) {
    persistSettings(nextSettings)
    return currentGateway
  }
  if (currentGateway) currentGateway.clear()
  const replacement = createGateway(nextSettings.server)
  replacement.clear()
  persistSettings(nextSettings)
  return replacement
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
function reminderActBody(body) {
  if (!record(body)) throw new Error('invalid reminder body')
  exact(body, 'minutes' in body ? ['id', 'at', 'minutes'] : ['id', 'at'])
  if (!Number.isInteger(body.id) || body.id < 1) throw new Error('invalid reminder id')
  if (typeof body.at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(body.at)) throw new Error('invalid reminder time')
  if ('minutes' in body && (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 180)) throw new Error('invalid snooze minutes')
  return 'minutes' in body ? { id: body.id, at: body.at, minutes: body.minutes } : { id: body.id, at: body.at }
}
function desktopThread(body) { exact(body, ['thread_id']); if (body.thread_id !== 'desktop') throw new Error('invalid desktop thread'); return { thread_id: 'desktop' } }
function todoPatchBody(body) {
  exact(body, ['id', 'done'])
  if (!Number.isInteger(body.id) || body.id < 1) throw new Error('invalid todo id')
  if (typeof body.done !== 'boolean') throw new Error('invalid todo done')
  return { id: body.id, done: body.done }
}
function voiceSettingsBody(body) {
  exact(body, ['voice', 'speed'])
  if (typeof body.voice !== 'string' || !body.voice || body.voice.length > 64) throw new Error('invalid voice')
  if (typeof body.speed !== 'number' || !(body.speed >= 0.5 && body.speed <= 2)) throw new Error('invalid speed')
  return { voice: body.voice, speed: body.speed }
}
function wakeCheckBody(body) {
  exact(body, ['audio_b64'])
  if (typeof body.audio_b64 !== 'string' || !body.audio_b64 || body.audio_b64.length > 1_400_000) {
    throw new Error('invalid wake audio')
  }
  return { audio_b64: body.audio_b64 }
}
function radioBody(body) {
  exact(body, ['time'])
  if (typeof body.time !== 'string' || (body.time !== '' && !/^\d{2}:\d{2}$/.test(body.time))) throw new Error('invalid radio time')
  return { time: body.time }
}
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

function requiredString(value, label, max = 2048) {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`invalid ${label}`)
  return value
}
function optionalSecret(value, label) {
  if (value !== null && (typeof value !== 'string' || value.length > 4096)) throw new Error(`invalid ${label}`)
  return value
}
function generation(value) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('invalid generation')
  return value
}
function llmSettingsBody(body) {
  exact(body, ['provider', 'base_url', 'model', 'api_key', 'keep_existing_key', 'admin_password', 'expected_generation'])
  if (!['openai', 'deepseek', 'bailian', 'siliconflow', 'custom'].includes(body.provider)) throw new Error('invalid provider')
  if (typeof body.base_url !== 'string' || body.base_url.length > 2048) throw new Error('invalid base url')
  requiredString(body.model, 'model', 200); optionalSecret(body.api_key, 'api key')
  if (typeof body.keep_existing_key !== 'boolean') throw new Error('invalid keep flag')
  requiredString(body.admin_password, 'password', 1024); generation(body.expected_generation)
  return { ...body }
}
function settingsDeleteBody(body) {
  exact(body, ['admin_password', 'expected_generation'])
  requiredString(body.admin_password, 'password', 1024); generation(body.expected_generation)
  return { ...body }
}
function integrationSettingsBody(body) {
  exact(body, ['name', 'enabled', 'base_url', 'api_key', 'keep_existing_key', 'admin_password', 'expected_generation'])
  if (!['searxng', 'tavily', 'pandascore'].includes(body.name)) throw new Error('invalid integration')
  if (typeof body.enabled !== 'boolean' || typeof body.base_url !== 'string' || body.base_url.length > 2048) throw new Error('invalid integration body')
  optionalSecret(body.api_key, 'api key')
  if (typeof body.keep_existing_key !== 'boolean') throw new Error('invalid keep flag')
  requiredString(body.admin_password, 'password', 1024); generation(body.expected_generation)
  return { ...body }
}
function integrationDeleteBody(body) {
  exact(body, ['name', 'admin_password', 'expected_generation'])
  if (!['searxng', 'tavily', 'pandascore'].includes(body.name)) throw new Error('invalid integration')
  return { name: body.name, ...settingsDeleteBody({ admin_password: body.admin_password, expected_generation: body.expected_generation }) }
}
function withoutName(body) { const { name: _name, ...rest } = body; return rest }

module.exports = { createSessionGateway, isAllowedServer, readEvents, replaceSessionGateway }
