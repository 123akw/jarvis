let csrfToken = ''

async function parse(response) {
  if (response.status === 401) throw new Error('401')
  const data = await response.json()
  if (response.ok === false) throw new Error(data.error || '请求失败')
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
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!r.ok) return null
  return getSession()
}

export async function logout() {
  await parse(await fetch('/api/logout', { method: 'POST', headers: csrfHeaders() }))
  csrfToken = ''
}

export async function getDashboard() {
  return parse(await fetch('/api/dashboard'))
}

export async function getThreads() {
  return parse(await fetch('/api/threads'))
}

export async function getHistory(threadId) {
  return parse(await fetch(`/api/history?thread_id=${encodeURIComponent(threadId)}`))
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

/** SSE 流式对话，逐事件产出 {type, ...}；location 为浏览器定位 {lat, lon}，可空 */
export async function* chatStream(message, location = null, threadId = 'web', signal = null) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ message, thread_id: threadId, location }),
    signal,
  })
  if (r.status === 401) throw new Error('401')
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
