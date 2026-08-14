let csrfToken = ''

async function parse(response) {
  if (response.status === 401) { csrfToken = ''; throw new Error('401') }
  const data = await response.json()
  if (response.ok === false) {
    const error = new Error(data.error || '请求失败')
    error.code = data.code || ''
    error.status = response.status
    throw error
  }
  return data
}

export async function getSession() {
  const session = await parse(await fetch('/api/session'))
  csrfToken = session.csrf_token || ''
  return session
}

export function csrfHeaders() {
  return csrfToken ? { 'X-JWS-CSRF': csrfToken } : {}
}

export async function login(username, password) {
  csrfToken = ''
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!r.ok) return null
  return getSession()
}

export async function logout() {
  try { await parse(await fetch('/api/logout', { method: 'POST', headers: csrfHeaders() })) }
  finally { csrfToken = '' }
}

export async function getDashboard() {
  return parse(await fetch('/api/dashboard'))
}

export async function getPendingReminders() {
  return parse(await fetch('/api/reminders/pending'))
}

/* ---- 任务台写接口 ---- */
function jsonHeaders() { return { 'Content-Type': 'application/json', ...csrfHeaders() } }
export async function addTodo(content) {
  return parse(await fetch('/api/todos', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ content }) }))
}
export async function patchTodo(id, done) {
  return parse(await fetch(`/api/todos/${id}`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ done }) }))
}
export async function deleteTodo(id) {
  return parse(await fetch(`/api/todos/${id}`, { method: 'DELETE', headers: csrfHeaders() }))
}
export async function addMemo(content) {
  return parse(await fetch('/api/memos', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ content }) }))
}
export async function deleteMemo(id) {
  return parse(await fetch(`/api/memos/${id}`, { method: 'DELETE', headers: csrfHeaders() }))
}
export async function addSchedule(title, when) {
  return parse(await fetch('/api/schedule', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ title, when }) }))
}
export async function deleteSchedule(id) {
  return parse(await fetch(`/api/schedule/${id}`, { method: 'DELETE', headers: csrfHeaders() }))
}

/* ---- 语音音色 / 语速 ---- */
export async function getVoiceSettings() {
  return parse(await fetch('/api/voice/settings'))
}
export async function saveVoiceSettings(voice, speed) {
  return parse(await fetch('/api/voice/settings', { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ voice, speed }) }))
}

/* ---- 文档上传解析 ---- */
export async function uploadDocument(name, contentB64) {
  return parse(await fetch('/api/upload', {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ name, content_b64: contentB64 }),
  }))
}

/* ---- 晨报电台 ---- */
export async function getRadio() {
  return parse(await fetch('/api/radio'))
}
export async function saveRadio(time) {
  return parse(await fetch('/api/radio', { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ time }) }))
}

/* ---- 人设工坊 ---- */
export async function getPersona() {
  return parse(await fetch('/api/persona'))
}
export async function savePersona(style, address, flavor) {
  return parse(await fetch('/api/persona', { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ style, address, flavor }) }))
}

/* ---- 长期记忆画像 ---- */
export async function getProfile() {
  return parse(await fetch('/api/profile'))
}
export async function addProfile(content) {
  return parse(await fetch('/api/profile', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ content }) }))
}
export async function deleteProfile(id) {
  return parse(await fetch(`/api/profile/${id}`, { method: 'DELETE', headers: csrfHeaders() }))
}

export async function getThreads() {
  return parse(await fetch('/api/threads'))
}

export async function getHistory(threadId) {
  return parse(await fetch(`/api/history?thread_id=${encodeURIComponent(threadId)}`))
}

export async function renameThread(threadId, title) {
  return parse(await fetch(`/api/thread?thread_id=${encodeURIComponent(threadId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ title }),
  }))
}

export async function deleteThread(threadId) {
  return parse(await fetch(`/api/thread?thread_id=${encodeURIComponent(threadId)}`, {
    method: 'DELETE', headers: csrfHeaders(),
  }))
}

export async function changePassword(currentPassword, newPassword) {
  return parse(await fetch('/api/account/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  }))
}

export async function getUsers() {
  return parse(await fetch('/api/admin/users'))
}

export async function createUser(user) {
  return parse(await fetch('/api/admin/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(user),
  }))
}

export async function updateUser(id, patch) {
  return parse(await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(patch),
  }))
}

export async function getProviderSettings() { return parse(await fetch('/api/settings/providers')) }
export async function testLLMSettings(body) { return parse(await fetch('/api/settings/llm/test', { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body) })) }
export async function saveLLMSettings(body) { return parse(await fetch('/api/settings/llm', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body) })) }
export async function restoreLLMSettings(body) { return parse(await fetch('/api/settings/llm', { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body) })) }
export async function testIntegration(name, body) { return parse(await fetch(`/api/settings/integrations/${encodeURIComponent(name)}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body) })) }
export async function saveIntegration(name, body) { return parse(await fetch(`/api/settings/integrations/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body) })) }
export async function restoreIntegration(name, body) { return parse(await fetch(`/api/settings/integrations/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body) })) }

/** 桌面接管：领一次性票据（60 秒时效，桌面端凭它免密码换桌面令牌） */
export async function desktopHandoffTicket() {
  return parse(await fetch('/api/desktop/handoff', { method: 'POST', headers: csrfHeaders() }))
}

/** 语音通话 WebSocket 地址；连接后第一条 init 消息带 currentCsrf() */
export function voiceSocketUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/api/voice/call`
}

export function currentCsrf() {
  return csrfToken
}

/** SSE 流式对话，逐事件产出 {type, ...}；location 为浏览器定位 {lat, lon}，可空 */
export async function* chatStream(message, location = null, threadId = 'web', signal = null) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ message, thread_id: threadId, location }),
    signal,
  })
  if (r.status === 401) { csrfToken = ''; throw new Error('401') }
  if (!r.ok) throw new Error('请求失败')
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop()
    for (const p of parts) {
      if (p.startsWith('data: ')) yield JSON.parse(p.slice(6))
    }
  }
}
