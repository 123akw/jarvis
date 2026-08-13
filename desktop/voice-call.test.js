const assert = require('node:assert/strict')
const { test } = require('node:test')

const { createVoiceCall, MESSAGES } = require('./voice-call.js')

class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []      // JSON 上行（已解析）
    this.binary = []    // 二进制上行帧
    this.closed = false
  }
  send(data) {
    if (typeof data === 'string') this.sent.push(JSON.parse(data))
    else this.binary.push(data)
  }
  close() { this.closed = true }
  // 测试驱动
  open() { this.readyState = 1; if (this.onopen) this.onopen() }
  emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }) }
  emitBinary(buf) { if (this.onmessage) this.onmessage({ data: buf }) }
  drop(code = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code }) }
}

function fakePlayer() {
  const player = {
    started: [], chunks: [], stops: 0, idle: null, playingFlag: false, closedFlag: false,
    start(rate) { player.started.push(rate) },
    enqueue(buf) { player.chunks.push(buf); player.playingFlag = true },
    stop() { player.playingFlag = false; player.stops += 1 },
    playing() { return player.playingFlag },
    onIdle(cb) { player.idle = cb },
    close() { player.closedFlag = true },
  }
  return player
}

function harness(overrides = {}) {
  const sockets = []
  const player = fakePlayer()
  const events = { phases: [], notices: [], interims: [], heards: [], replies: [], mics: [], modes: [], expired: 0 }
  const call = createVoiceCall({
    url: 'wss://example.test/api/voice/call',
    createWebSocket: u => { const s = new FakeSocket(u); sockets.push(s); return s },
    player,
    on: {
      phase: p => events.phases.push(p),
      notice: n => events.notices.push(n),
      interim: t => events.interims.push(t),
      heard: t => events.heards.push(t),
      reply: r => events.replies.push(r),
      micState: m => events.mics.push(m),
      inputMode: m => events.modes.push(m),
      expired: () => { events.expired += 1 },
    },
    ...overrides,
  })
  return { call, sockets, player, events }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

/** 推流可用的通话：返回已接通、ready、麦克风推流就绪的整套句柄。 */
async function streamingHarness(overrides = {}) {
  const mic = { stopped: 0, onFrame: null, onLevel: null }
  const h = harness({
    pcmSupported: true,
    startMicStream: async ({ onFrame, onLevel }) => {
      mic.onFrame = onFrame
      mic.onLevel = onLevel
      return { stop() { mic.stopped += 1 } }
    },
    ...overrides,
  })
  h.call.start()
  h.sockets[0].open()
  h.sockets[0].emit({ type: 'ready' })
  await tick()
  return { ...h, mic }
}

test('voice call sends the desktop-prefixed init first and becomes listening on ready', () => {
  const { call, sockets } = harness()
  call.start()
  sockets[0].open()
  assert.deepEqual(sockets[0].sent[0], { type: 'init', thread_id: 'desktop-voice' })
  sockets[0].emit({ type: 'ready' })
  assert.equal(call.state().phase, 'listening')
})

test('unauthorized error reports expiry and never reconnects', () => {
  const { call, sockets, events } = harness()
  call.start()
  sockets[0].open()
  sockets[0].emit({ type: 'error', code: 'unauthorized', message: '未登录' })
  assert.equal(events.expired, 1)
  sockets[0].drop(4401)
  assert.equal(sockets.length, 1) // 过期不重连，直接结束
  assert.equal(call.state().phase, 'closed')
})

test('asr_partial streams interim subtitles and asr_final commits the heard text', () => {
  const { call, sockets } = harness()
  call.start()
  sockets[0].open()
  sockets[0].emit({ type: 'ready' })
  sockets[0].emit({ type: 'asr_partial', text: '明' })
  sockets[0].emit({ type: 'asr_partial', text: '明天有什' })
  assert.equal(call.state().interim, '明天有什')
  sockets[0].emit({ type: 'asr_final', text: '明天有什么安排' })
  const s = call.state()
  assert.equal(s.interim, '')
  assert.equal(s.heard, '明天有什么安排')
  assert.equal(s.phase, 'thinking')
})

test('barge-in during playback sends interrupt, stops audio and discards the unfinalized subtitle', async () => {
  const { call, sockets, player, mic } = await streamingHarness()
  sockets[0].emit({ type: 'asr_partial', text: '还没定稿的半句话' })
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emit({ type: 'audio_start', format: 'pcm', sample_rate: 24000, channels: 1 })
  sockets[0].emitBinary(new ArrayBuffer(3200))
  assert.equal(call.state().phase, 'speaking')
  assert.equal(call.state().interim, '还没定稿的半句话') // 播放中旧灰字仍挂着
  const sentBefore = sockets[0].sent.length
  mic.onLevel(0.2)
  mic.onLevel(0.2) // 连续两帧人声 → 打断
  assert.deepEqual(sockets[0].sent[sockets[0].sent.length - 1], { type: 'interrupt' })
  assert.ok(sockets[0].sent.length > sentBefore)
  assert.equal(player.playing(), false)
  assert.equal(call.state().interim, '', '打断后未定稿字幕必须丢弃')
  assert.ok(!sockets[0].sent.some(m => m.type === 'user_text'), '未定稿文字不得进回合')
  assert.equal(call.state().phase, 'listening')
})

test('a single loud frame does not trigger barge-in', async () => {
  const { sockets, mic } = await streamingHarness()
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emitBinary(new ArrayBuffer(320))
  mic.onLevel(0.2)
  mic.onLevel(0.0) // 中断连续帧计数
  mic.onLevel(0.2)
  assert.ok(!sockets[0].sent.some(m => m.type === 'interrupt'))
})

test('tts_error degrades the turn to text while tokens keep streaming', () => {
  const { call, sockets, events } = harness()
  call.start()
  sockets[0].open()
  sockets[0].emit({ type: 'ready' })
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emit({ type: 'tts_error', message: '语音合成暂不可用，本回合降级为纯文字' })
  sockets[0].emit({ type: 'token', text: '现在是' })
  sockets[0].emit({ type: 'token', text: '下午三点。' })
  sockets[0].emit({ type: 'turn_end', interrupted: false })
  assert.ok(events.notices.some(n => n.includes('纯文字')))
  assert.equal(call.state().reply, '现在是下午三点。')
  assert.equal(call.state().phase, 'listening')
})

test('broken streaming component falls back to the built-in recognizer', async () => {
  class FakeRec {
    constructor() { FakeRec.instances.push(this) }
    start() { if (this.onstart) this.onstart() }
    stop() {}
  }
  FakeRec.instances = []
  const h = harness({
    pcmSupported: true,
    startMicStream: async () => { throw new Error('worklet unavailable') },
    speechCtor: () => FakeRec,
  })
  h.call.start()
  h.sockets[0].open()
  h.sockets[0].emit({ type: 'ready' })
  await tick()
  assert.equal(h.call.state().inputMode, 'speech')
  assert.equal(FakeRec.instances.length, 1)
  assert.equal(h.call.state().micState, 'granted')
})

test('with no recognizer available the call degrades to typed input with a plain notice', async () => {
  const h = harness({
    pcmSupported: true,
    startMicStream: async () => { throw new Error('worklet unavailable') },
    speechCtor: () => null,
  })
  h.call.start()
  h.sockets[0].open()
  h.sockets[0].emit({ type: 'ready' })
  await tick()
  const s = h.call.state()
  assert.equal(s.inputMode, 'typing')
  assert.equal(s.micState, 'unsupported')
  assert.ok(s.notice.includes('打字'))
})

test('microphone denial degrades straight to typing with a human-readable notice', async () => {
  const denied = new Error('denied')
  denied.name = 'NotAllowedError'
  const h = harness({
    pcmSupported: true,
    startMicStream: async () => { throw denied },
    isMicError: err => err.name === 'NotAllowedError',
    speechCtor: () => { throw new Error('never used') },
  })
  h.call.start()
  h.sockets[0].open()
  h.sockets[0].emit({ type: 'ready' })
  await tick()
  const s = h.call.state()
  assert.equal(s.micState, 'denied')
  assert.equal(s.inputMode, 'typing')
  assert.ok(s.notice.includes('麦克风权限'))
  assert.ok(s.notice.includes('打字'))
})

test('asr_fallback stops the uplink stream and switches to the built-in recognizer', async () => {
  class FakeRec {
    constructor() { FakeRec.instances.push(this) }
    start() { if (this.onstart) this.onstart() }
    stop() {}
  }
  FakeRec.instances = []
  const { call, sockets, mic } = await streamingHarness({ speechCtor: () => FakeRec })
  mic.onFrame(new ArrayBuffer(3200))
  assert.equal(sockets[0].binary.length, 1)
  sockets[0].emit({ type: 'asr_fallback', message: '服务端语音识别暂不可用，已切换浏览器识别' })
  assert.equal(mic.stopped, 1)
  assert.equal(call.state().inputMode, 'speech')
  mic.onFrame(new ArrayBuffer(3200)) // 降级后到达的残余帧
  assert.equal(sockets[0].binary.length, 1, '降级后不得再上行音频帧')
})

test('an unexpected disconnect reconnects exactly once and then gives up with a notice', () => {
  const { call, sockets, events } = harness()
  call.start()
  sockets[0].open()
  sockets[0].emit({ type: 'ready' })
  sockets[0].drop()
  assert.equal(sockets.length, 2, '第一次断开自动重连')
  sockets[1].open()
  assert.deepEqual(sockets[1].sent[0], { type: 'init', thread_id: 'desktop-voice' })
  sockets[1].emit({ type: 'ready' })
  assert.equal(call.state().phase, 'listening')
  sockets[1].drop()
  assert.equal(sockets.length, 2, '第二次断开不再重连')
  assert.equal(call.state().phase, 'closed')
  assert.ok(events.notices.some(n => n.includes('重连')))
  assert.ok(call.state().notice.includes('断开'))
})

test('typed utterances stop playback and go upstream as user_text', () => {
  const { call, sockets, player } = harness()
  call.start()
  sockets[0].open()
  sockets[0].emit({ type: 'ready' })
  sockets[0].emitBinary(new ArrayBuffer(640))
  assert.equal(player.playing(), true)
  call.sendTyped('  帮我记一条备忘  ')
  assert.deepEqual(sockets[0].sent[sockets[0].sent.length - 1], { type: 'user_text', text: '帮我记一条备忘' })
  assert.equal(player.playing(), false)
  assert.equal(call.state().heard, '帮我记一条备忘')
  assert.equal(call.state().phase, 'thinking')
})

test('audio_start sets the playback rate and the phase returns to listening after drain', () => {
  const { call, sockets, player } = harness()
  call.start()
  sockets[0].open()
  sockets[0].emit({ type: 'ready' })
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emit({ type: 'audio_start', format: 'pcm', sample_rate: 24000, channels: 1 })
  assert.deepEqual(player.started, [24000])
  sockets[0].emitBinary(new ArrayBuffer(4800))
  assert.equal(player.chunks.length, 1)
  assert.equal(call.state().phase, 'speaking')
  sockets[0].emit({ type: 'turn_end', interrupted: false })
  assert.equal(call.state().phase, 'speaking', '音频未放完仍在说')
  player.playingFlag = false
  player.idle() // 播放队列放空
  assert.equal(call.state().phase, 'listening')
})

test('hangup tears everything down and stops reconnecting', async () => {
  const { call, sockets, player, mic } = await streamingHarness()
  call.hangup()
  assert.equal(mic.stopped, 1)
  assert.equal(sockets[0].closed, true)
  assert.equal(player.closedFlag, true)
  assert.equal(call.state().phase, 'closed')
  sockets[0].drop()
  assert.equal(sockets.length, 1, '挂断后不得重连')
})
