#!/usr/bin/env node
/* 最小链路验证：desktop 令牌连 /api/voice/call，文字上行 → 统计下行音频字节（node tools/voice-check.js）。 */
'use strict'
const SERVER = process.env.JWS_SERVER || 'https://jws.gkgeek-set.cn'
async function main() {
  const login = await fetch(SERVER + '/api/desktop/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.JWS_USER || 'admin', password: process.env.JWS_PASS || 'admin' }),
  })
  if (!login.ok) throw new Error('desktop login failed: ' + login.status)
  const { access_token } = await login.json()
  console.log('login ok, token length:', access_token.length)
  const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/api/voice/call', { headers: { 'X-JWS-Token': access_token } })
  ws.binaryType = 'arraybuffer'
  let audioBytes = 0
  ws.onopen = () => ws.send(JSON.stringify({ type: 'init', thread_id: 'desktop-voice' }))
  ws.onmessage = e => {
    if (e.data instanceof ArrayBuffer) { audioBytes += e.data.byteLength; return }
    const ev = JSON.parse(e.data)
    console.log('event:', JSON.stringify(ev).slice(0, 160))
    if (ev.type === 'ready') ws.send(JSON.stringify({ type: 'user_text', text: '用一句话报一下现在的时间' }))
    if (ev.type === 'turn_end') { console.log('audio bytes received:', audioBytes); process.exit(audioBytes > 0 ? 0 : 1) }
  }
  ws.onclose = ev => { console.log('closed, code:', ev.code); process.exit(2) }
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(3) })
