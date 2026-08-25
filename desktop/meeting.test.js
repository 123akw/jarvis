const { test } = require('node:test')
const assert = require('node:assert')
const { createMeetingSession, MESSAGES, CHANNEL_ME, CHANNEL_OTHERS } = require('./meeting.js')

function fakeWs() {
  const ws = {
    sent: [], readyState: 1, closed: false,
    send(data) { this.sent.push(data) },
    close() { this.closed = true; if (this.onclose) this.onclose() },
    open() { this.onopen && this.onopen() },
    message(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }) },
  }
  return ws
}

function newSession(overrides = {}) {
  const ws = fakeWs()
  const events = { phases: [], captions: [], notices: [], minutes: [], mails: [], expired: 0 }
  const session = createMeetingSession({
    url: 'wss://x/api/meeting/stream',
    title: '周会',
    createWebSocket: () => ws,
    on: {
      phase: p => events.phases.push(p),
      caption: c => events.captions.push(c),
      notice: n => events.notices.push(n),
      minutes: m => events.minutes.push(m),
      mail: m => events.mails.push(m),
      expired: () => { events.expired += 1 },
      ...overrides,
    },
  })
  return { ws, events, session }
}

test('init 带会议主题；双路帧各自带声道头上行', () => {
  const { ws, session } = newSession()
  session.start()
  ws.open()
  assert.deepStrictEqual(JSON.parse(ws.sent[0]), { type: 'init', title: '周会' })
  ws.message({ type: 'ready', meeting_id: 'm1' })
  session.feedMic(new Int16Array([7, 7]).buffer)
  session.feedSystem(new Int16Array([9]).buffer)
  const mic = new Uint8Array(ws.sent[1])
  const sys = new Uint8Array(ws.sent[2])
  assert.strictEqual(mic[0], CHANNEL_ME)
  assert.strictEqual(mic.byteLength, 1 + 4)
  assert.strictEqual(sys[0], CHANNEL_OTHERS)
  assert.strictEqual(session.state().phase, 'recording')
})

test('字幕：partial 灰字、segment 定稿计数；stop 后收 stopped→minutes→mail', () => {
  const { ws, events, session } = newSession()
  session.start(); ws.open()
  ws.message({ type: 'ready', meeting_id: 'm1' })
  ws.message({ type: 'partial', speaker: '对方', text: '这个方' })
  ws.message({ type: 'segment', speaker: '对方', ts: '10:00:01', text: '这个方案可以。' })
  assert.deepStrictEqual(events.captions[0], { speaker: '对方', text: '这个方', final: false })
  assert.strictEqual(events.captions[1].final, true)
  session.stop()
  assert.deepStrictEqual(JSON.parse(ws.sent.at(-1)), { type: 'stop' })
  assert.strictEqual(session.state().phase, 'summarizing')
  session.feedMic(new Int16Array([1]).buffer)
  assert.ok(!(ws.sent.at(-1) instanceof ArrayBuffer), 'stop 之后不再上行音频')
  ws.message({ type: 'stopped', segments: 1, empty: false })
  ws.message({ type: 'minutes', meeting_id: 1, text: '# 会议纪要', message: '' })
  ws.message({ type: 'mail', ok: true, to: '1539598158@qq.com', message: '' })
  assert.strictEqual(session.state().phase, 'done')
  assert.deepStrictEqual(events.minutes, [{ text: '# 会议纪要', message: '' }])
  assert.deepStrictEqual(events.mails, [{ ok: true, to: '1539598158@qq.com', message: '' }])
})

test('空会议：stopped(empty) 直接完成并给人话提示', () => {
  const { ws, events, session } = newSession()
  session.start(); ws.open()
  ws.message({ type: 'ready' })
  session.stop()
  ws.message({ type: 'stopped', segments: 0, empty: true })
  assert.strictEqual(session.state().phase, 'done')
  assert.ok(events.notices.includes(MESSAGES.empty))
})

test('busy 冲突与登录过期各走各的收场', () => {
  const a = newSession()
  a.session.start(); a.ws.open()
  a.ws.message({ type: 'error', code: 'busy', message: '已有一场会议在监控中' })
  assert.strictEqual(a.session.state().phase, 'error')
  assert.ok(a.events.notices.includes(MESSAGES.busy))
  const b = newSession()
  b.session.start(); b.ws.open()
  b.ws.message({ type: 'error', code: 'unauthorized' })
  assert.strictEqual(b.events.expired, 1)
})

test('录制中断线：提示已录内容服务端照常整理，纪要送达后断线不算错', () => {
  const a = newSession()
  a.session.start(); a.ws.open()
  a.ws.message({ type: 'ready' })
  a.ws.close()
  assert.strictEqual(a.session.state().phase, 'error')
  assert.ok(a.events.notices.includes(MESSAGES.dead))
  const b = newSession()
  b.session.start(); b.ws.open()
  b.ws.message({ type: 'ready' })
  b.session.stop()
  b.ws.message({ type: 'stopped', segments: 1, empty: false })
  b.ws.message({ type: 'minutes', text: 'x', message: '' })
  b.ws.close()
  assert.strictEqual(b.session.state().phase, 'closed')
  assert.ok(!b.events.notices.includes(MESSAGES.dead))
})

test('识别彻底不可用：提示并自动停止采集', () => {
  const { ws, events, session } = newSession()
  session.start(); ws.open()
  ws.message({ type: 'ready' })
  ws.message({ type: 'asr_unavailable', message: '服务端语音识别不可用' })
  assert.ok(events.notices.some(n => n.includes('识别不可用')))
  assert.deepStrictEqual(JSON.parse(ws.sent.at(-1)), { type: 'stop' }, '转不出字就别录了')
})

test('dispose 彻底收摊：关连接、不再回调', () => {
  const { ws, session } = newSession()
  session.start(); ws.open()
  ws.message({ type: 'ready' })
  session.dispose()
  assert.ok(ws.closed)
  assert.strictEqual(session.state().phase, 'closed')
})

test('实时要点：live_points 帧透传给界面回调', () => {
  const points = []
  const { ws, session } = newSession({ livePoints: t => points.push(t) })
  session.start(); ws.open()
  ws.message({ type: 'ready' })
  ws.message({ type: 'live_points', text: '· 首屏用动效\n· 九月第二周上线' })
  assert.deepStrictEqual(points, ['· 首屏用动效\n· 九月第二周上线'])
})

test('连接建立前喊停：整个收摊，onopen 不再发 init、ready 不能复活会话', () => {
  const { ws, session } = newSession()
  session.start()                 // readyState 仍是 0（未 open）
  ws.readyState = 0
  session.stop()
  assert.strictEqual(session.state().phase, 'closed')
  assert.ok(ws.closed, '未建立的连接必须直接关掉')
  ws.open()                       // 迟到的 onopen
  assert.strictEqual(ws.sent.length, 0, '不得再发 init 把服务端会议开起来')
  ws.message({ type: 'ready', meeting_id: 'zombie' })
  assert.strictEqual(session.state().phase, 'closed', 'ready 不能把已关闭的会话复活')
})
