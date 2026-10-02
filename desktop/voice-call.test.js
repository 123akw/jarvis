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

test('场景：ready 带出当前场景，切换事件更新回执并把开场白当回答显示', () => {
  const scenes = []
  const { call, sockets, events } = harness({ on: {
    scene: s => scenes.push(s),
    reply: r => events.replies.push(r),
    phase: () => {}, notice: () => {},
  } })
  call.start()
  const ws = sockets[0]
  ws.open()
  ws.emit({ type: 'ready', scene: 'butler', scene_name: '管家模式', opening: '' })
  assert.deepStrictEqual(scenes[0], { id: 'butler', name: '管家模式', opening: '' })
  call.sendScene('night')
  assert.deepStrictEqual(ws.sent.at(-1), { type: 'scene', scene: 'night' })
  ws.emit({ type: 'scene', scene: 'night', scene_name: '晚安电台', opening: '今天过得还好吗？' })
  assert.deepStrictEqual(scenes[1], { id: 'night', name: '晚安电台', opening: '今天过得还好吗？' })
  assert.strictEqual(events.replies.at(-1), '今天过得还好吗？', '开场白直接显示在回答区')
})

test('情绪：emotion 帧透传给界面回调', () => {
  const emotions = []
  const { call, sockets } = harness({ on: { emotion: e => emotions.push(e), phase: () => {} } })
  call.start()
  const ws = sockets[0]
  ws.open()
  ws.emit({ type: 'ready' })
  ws.emit({ type: 'emotion', emotion: 'sad', label: '低落' })
  assert.deepStrictEqual(emotions, [{ emotion: 'sad', label: '低落' }])
})

test('断线重连的 ready 不得用开场白冲掉正在显示的回答', () => {
  const replies = []
  const { call, sockets } = harness({ on: { reply: r => replies.push(r), phase: () => {}, notice: () => {} } })
  call.start()
  const first = sockets[0]
  first.open()
  first.emit({ type: 'ready', scene: 'night', scene_name: '晚安电台', opening: '今天过得还好吗？' })
  assert.strictEqual(replies.at(-1), '今天过得还好吗？', '首次 ready 显示开场白')
  first.emit({ type: 'turn_start' })
  first.emit({ type: 'token', text: '从前有座山……' })
  assert.strictEqual(replies.at(-1), '从前有座山……')
  first.drop()                      // 触发自动重连
  const second = sockets[1]
  second.open()
  second.emit({ type: 'ready', scene: 'night', scene_name: '晚安电台', opening: '今天过得还好吗？' })
  assert.strictEqual(replies.at(-1), '从前有座山……', '重连 ready 不能重播开场白')
})

test('接通先预热播放器再连网关：首句音频到达时不再现建 AudioContext', () => {
  const order = []
  const { call, player, sockets } = harness({
    createWebSocket: u => { order.push('socket'); const s = new FakeSocket(u); sockets.push(s); return s },
  })
  player.warm = () => order.push('warm')
  call.start()
  assert.deepEqual(order, ['warm', 'socket'])
})

test('播放器预热失败不影响接通（老播放器没有 warm 也照常）', () => {
  const { call, player, sockets } = harness()
  player.warm = () => { throw new Error('no audio device') }
  call.start()
  assert.equal(sockets.length, 1)
})

test('createPcmPlayer.warm 只建一次上下文并 resume，入队复用同一个', () => {
  const { createPcmPlayer, pcm16ToFloat32 } = require('./voice-audio.js')
  const made = []
  const ctxFactory = () => {
    const ctx = {
      state: 'suspended', currentTime: 0, destination: {}, resumed: 0, started: [],
      resume() { ctx.resumed += 1; ctx.state = 'running' },
      createBuffer(_ch, len, rate) {
        const data = new Float32Array(len)
        return { duration: len / rate, getChannelData: () => data }
      },
      createBufferSource() { return { connect() {}, start(at) { ctx.started.push(at) }, stop() {} } },
    }
    made.push(ctx)
    return ctx
  }
  const player = createPcmPlayer({ createContext: ctxFactory })
  player.warm()
  assert.equal(made.length, 1)
  assert.equal(made[0].resumed, 1, '接通时就 resume，首句不再等设备启动')
  player.enqueue(new Int16Array([16384, -32768]).buffer)
  assert.equal(made.length, 1, '入队复用预热好的上下文')
  assert.deepEqual(made[0].started, [0.02])
  assert.deepEqual(Array.from(pcm16ToFloat32(new Int16Array([0, 16384, -32768]))), [0, 0.5, -1])
})

test('回答字幕按帧合并：首字立即回调，同帧 token 合并一次，turn_end 立即补齐，挂断作废', () => {
  const frames = []
  const { call, sockets, events } = harness({
    requestFrame: cb => { frames.push(cb); return frames.length },
    cancelFrame: id => { frames[id - 1] = null },
  })
  call.start()
  sockets[0].open()
  sockets[0].emit({ type: 'ready' })
  sockets[0].emit({ type: 'turn_start' })
  const base = events.replies.length
  sockets[0].emit({ type: 'token', text: '现在' })
  assert.deepEqual(events.replies.slice(base), ['现在'], '本回合首字不等帧')
  sockets[0].emit({ type: 'token', text: '是下午' })
  sockets[0].emit({ type: 'token', text: '三点' })
  assert.equal(events.replies.length, base + 1, '帧没到不逐 token 回调')
  assert.equal(frames.filter(Boolean).length, 1, '两个 token 只排一帧')
  assert.equal(call.state().reply, '现在是下午三点', 'state() 始终是全文')
  frames.splice(0).forEach(cb => cb && cb())
  assert.equal(events.replies.at(-1), '现在是下午三点')
  sockets[0].emit({ type: 'token', text: '整。' })
  sockets[0].emit({ type: 'turn_end', interrupted: false })
  assert.equal(events.replies.at(-1), '现在是下午三点整。', 'turn_end 不等帧直接补齐')
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emit({ type: 'token', text: '好' })
  sockets[0].emit({ type: 'token', text: '的' })
  const pending = frames.filter(Boolean).length
  call.hangup()
  assert.equal(frames.filter(Boolean).length, pending - 1, '挂断作废已排的刷新帧')
})

test('barge-in reports how much audio was actually played when the player can tell', async () => {
  const { call, sockets, player, mic } = await streamingHarness()
  player.playedMs = () => 1840
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emit({ type: 'audio_start', format: 'pcm', sample_rate: 24000, channels: 1 })
  sockets[0].emitBinary(new ArrayBuffer(3200))
  mic.onLevel(0.2)
  mic.onLevel(0.2)
  assert.deepEqual(sockets[0].sent[sockets[0].sent.length - 1], { type: 'interrupt', played_ms: 1840 })
  assert.equal(call.state().phase, 'listening')
})

test('after barge-in late tokens and audio are dropped and the cut frame trims the subtitle', async () => {
  const { call, sockets, player, mic, events } = await streamingHarness()
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emit({ type: 'token', text: '明天上午有两个会，' })
  sockets[0].emit({ type: 'audio_start', format: 'pcm', sample_rate: 24000, channels: 1 })
  sockets[0].emitBinary(new ArrayBuffer(3200))
  sockets[0].emit({ type: 'token', text: '下午三点' })
  mic.onLevel(0.2)
  mic.onLevel(0.2)
  const chunks = player.chunks.length
  sockets[0].emit({ type: 'token', text: '还有一个评审。' })
  sockets[0].emitBinary(new ArrayBuffer(3200))
  assert.equal(player.chunks.length, chunks, '打断后迟到的音频不再播放')
  assert.equal(call.state().reply, '明天上午有两个会，下午三点', '打断后迟到的 token 不再上屏')
  sockets[0].emit({ type: 'cut', heard: '明天上午有两个会，' })
  assert.equal(call.state().reply, '明天上午有两个会， ⋯')
  assert.equal(events.replies[events.replies.length - 1], '明天上午有两个会， ⋯')
  // 新回合恢复正常
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emit({ type: 'token', text: '好的。' })
  assert.equal(call.state().reply, '好的。')
})

test('filler fills the subtitle until the first real token replaces it', () => {
  const { call, sockets, events } = harness()
  call.start()
  sockets[0].open()
  sockets[0].emit({ type: 'ready' })
  sockets[0].emit({ type: 'turn_start' })
  sockets[0].emit({ type: 'filler', text: '好，我查一下。' })
  assert.equal(events.replies[events.replies.length - 1], '好，我查一下。')
  assert.equal(call.state().reply, '', '垫话不进回答正文')
  sockets[0].emit({ type: 'token', text: '明天晴，' })
  assert.equal(events.replies[events.replies.length - 1], '明天晴，')
})

test('cutIndex maps the heard prefix onto the reply ignoring whitespace', () => {
  const { cutIndex } = require('./voice-call.js')
  assert.equal(cutIndex('今天 晴，最高 25 度。', '今天晴，'), 5)
  assert.equal(cutIndex('今天晴。', ''), 0)
  assert.equal(cutIndex('今天晴。', '今天晴。还有'), 4)
})
