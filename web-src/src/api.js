export async function getSession() {
  return (await fetch('/api/session')).json()
}

export async function login(username, password) {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return r.ok
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST' })
}

export async function getDashboard() {
  const r = await fetch('/api/dashboard')
  if (r.status === 401) throw new Error('401')
  return r.json()
}

export async function getThreads() {
  const r = await fetch('/api/threads')
  if (r.status === 401) throw new Error('401')
  return r.json()
}

export async function getHistory(threadId) {
  const r = await fetch(`/api/history?thread_id=${encodeURIComponent(threadId)}`)
  if (r.status === 401) throw new Error('401')
  return r.json()
}

export async function deleteThread(threadId) {
  await fetch(`/api/thread?thread_id=${encodeURIComponent(threadId)}`, { method: 'DELETE' })
}

/** SSE 流式对话，逐事件产出 {type, ...}；location 为浏览器定位 {lat, lon}，可空 */
export async function* chatStream(message, location = null, threadId = 'web', signal = null) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, thread_id: threadId, location }),
    signal,
  })
  if (r.status === 401) throw new Error('401')
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
