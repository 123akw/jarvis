/* 桌面语音通话核心状态机（纯逻辑，无 DOM、无 Electron）。
 * 行为对齐来源：web-src/src/VoiceCall.jsx（接通/听/想/说状态机、字幕增量与定稿、
 * 本地 VAD 开口打断、三层输入逐级降级）。协议以 jarvis/voice/gateway.py 实读为准。
 * 依赖全部注入（WebSocket 工厂/播放器/麦克风推流/识别器），node --test 可直跑。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSVoiceCall = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  const VAD_RMS_THRESHOLD = 0.04 // 帧级 RMS 高于此视作人声（与网页端一致）
  const VAD_VOICE_FRAMES = 2     // 连续 2 帧（约 200ms）确认开口 → 打断
  const WS_OPEN = 1

  const MESSAGES = {
    micDenied: '没拿到麦克风权限。语音识别已停用，可以在下面打字通话（贾维斯照样语音回答）；关掉本面板后文字聊天完全不受影响。',
    speechUnsupported: '这个环境不支持语音识别，已降级为打字通话：输入文字，贾维斯用语音回答；文字聊天不受影响。',
    speechBroken: '语音识别暂不可用（找不到麦克风或识别服务不可达），已降级为打字通话：输入文字，贾维斯用语音回答。',
    reconnecting: '通话连接断开，正在自动重连…',
    dead: '通话连接已断开，自动重连也失败了。请挂断后重新拨打；打字聊天不受影响。',
    linkError: '通话链路出错',
    connectFailed: '无法建立通话连接',
  }

  /**
   * 一通语音通话。返回 { start, hangup, sendTyped, bargeIn, state }。
   * on 回调：phase/micState/inputMode/notice/interim/heard/reply/tools/expired。
   */
  function createVoiceCall({
    url,
    threadId = 'desktop-voice',
    createWebSocket,
    player,
    pcmSupported = false,
    startMicStream = null,
    isMicError = () => false,
    speechCtor = () => null,
    on = {},
    maxReconnects = 1,
  }) {
    const state = {
      phase: 'connecting',   // connecting|listening|thinking|speaking|closed
      micState: 'pending',   // pending|granted|denied|unsupported
      inputMode: 'none',     // none|stream|speech|typing
      heard: '', interim: '', reply: '', notice: '', tools: [],
      turnDone: true, serverAsr: true, alive: true, expired: false,
      reconnectsLeft: maxReconnects,
    }
    let ws = null
    let micHandle = null
    let rec = null
    let vadRun = 0

    const emit = (name, payload) => { if (on[name]) on[name](payload) }
    function setPhase(p) { if (state.alive && state.phase !== p) { state.phase = p; emit('phase', p) } }
    function setNotice(m) { state.notice = m; emit('notice', m) }
    function setInterim(t) { if (state.interim !== t) { state.interim = t; emit('interim', t) } }
    function setHeard(t) { state.heard = t; emit('heard', t) }
    function setMicState(m) { if (state.micState !== m) { state.micState = m; emit('micState', m) } }
    function setInputMode(m) { if (state.inputMode !== m) { state.inputMode = m; emit('inputMode', m) } }

    // ---- 上行 ----

    function wsSend(obj) { if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj)) }
    function wsSendBinary(buf) { if (ws && ws.readyState === WS_OPEN) ws.send(buf) }

    function sendUtterance(text) {
      text = String(text || '').trim()
      if (!text) return
      player.stop()
      state.turnDone = false
      setHeard(text)
      setInterim('')
      setPhase('thinking')
      wsSend({ type: 'user_text', text })
    }

    /** 开口打断：停播 + 通知网关取消在途回合；未定稿的识别文字一并丢弃（不进回合）。 */
    function bargeIn() {
      if (state.phase === 'speaking' || player.playing()) {
        wsSend({ type: 'interrupt' })
        player.stop()
        setInterim('') // 打断丢弃未定稿：与网关 interrupt→discard_pending 语义对齐
        setPhase('listening')
      }
    }

    /** 本地音量 VAD：播放中连续两帧检测到人声（约 200ms）→ 立即停播 + 通知取消。 */
    function onMicLevel(rms) {
      const playing = state.phase === 'speaking' || player.playing()
      if (!playing || rms < VAD_RMS_THRESHOLD) {
        vadRun = 0
        return
      }
      vadRun += 1
      if (vadRun >= VAD_VOICE_FRAMES) {
        vadRun = 0
        bargeIn()
      }
    }

    // ---- 下行事件 ----

    function handleEvent(ev) {
      if (!ev || typeof ev !== 'object') return
      if (ev.type === 'ready') {
        setPhase('listening')
        startVoiceInput()
      } else if (ev.type === 'asr_partial') {
        setInterim(ev.text || '')
        if ((ev.text || '').trim()) bargeIn() // 服务端听到人声：本地 VAD 之外的兜底打断
      } else if (ev.type === 'asr_final') {
        setInterim('')
        const text = (ev.text || '').trim()
        if (text) {
          player.stop()
          state.turnDone = false
          setHeard(text)
          setPhase('thinking')
        }
      } else if (ev.type === 'asr_fallback') {
        degradeToSpeech(ev.message || '服务端语音识别暂不可用，已切换本地识别')
      } else if (ev.type === 'turn_start') {
        state.turnDone = false
        state.reply = ''
        emit('reply', '')
        state.tools = []
        emit('tools', [])
        setPhase('thinking')
      } else if (ev.type === 'token') {
        state.reply += ev.text || ''
        emit('reply', state.reply)
      } else if (ev.type === 'tool_start') {
        state.tools.push({ name: ev.name, done: false })
        emit('tools', state.tools.slice())
      } else if (ev.type === 'tool_result') {
        const i = state.tools.findIndex(t => t.name === ev.name && !t.done)
        if (i >= 0) state.tools[i] = { name: ev.name, done: true }
        emit('tools', state.tools.slice())
      } else if (ev.type === 'audio_start') {
        player.start(ev.sample_rate || 24000)
      } else if (ev.type === 'tts_error') {
        setNotice(ev.message || '语音合成暂不可用，本回合降级为纯文字')
      } else if (ev.type === 'turn_end') {
        state.turnDone = true
        if (ev.interrupted || !player.playing()) setPhase('listening')
      } else if (ev.type === 'error') {
        if (ev.code === 'unauthorized' || ev.code === 'csrf') {
          state.expired = true
          emit('expired')
          return
        }
        setNotice(ev.message || MESSAGES.linkError)
        if (state.turnDone) setPhase('listening')
      }
    }

    function onAudioChunk(buf) {
      player.enqueue(buf)
      setPhase('speaking')
    }

    if (player.onIdle) {
      player.onIdle(() => {
        if (state.alive && state.turnDone && state.phase === 'speaking') setPhase('listening')
      })
    }

    // ---- 输入链路与逐级降级 ----

    function degradeToTyping(message) {
      if (state.micState !== 'unsupported') setMicState('denied')
      setInputMode('typing')
      setNotice(message)
    }

    function markUnsupported() {
      setMicState('unsupported')
      setInputMode('typing')
      setNotice(MESSAGES.speechUnsupported)
    }

    /** 服务端识别不可用：停推流，退内建识别（再不行退打字）。 */
    function degradeToSpeech(message) {
      state.serverAsr = false
      if (micHandle) {
        try { micHandle.stop() } catch { /* 已停 */ }
        micHandle = null
      }
      setInterim('')
      setNotice(message)
      startRecognition()
    }

    function startRecognition() {
      if (rec) return // 已在内建识别模式
      let Ctor = null
      try { Ctor = speechCtor() } catch { Ctor = null }
      if (!Ctor) { markUnsupported(); return }
      let r
      try { r = new Ctor() } catch { markUnsupported(); return }
      rec = r
      setInputMode('speech')
      r.lang = 'zh-CN'
      r.continuous = true
      r.interimResults = true
      r.onstart = () => { if (state.alive) setMicState('granted') }
      r.onresult = e => {
        if (!state.alive) return
        let interimText = ''
        let finalText = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const item = e.results[i]
          if (item.isFinal) finalText += item[0].transcript
          else interimText += item[0].transcript
        }
        if (interimText.trim() || finalText.trim()) bargeIn()
        if (interimText.trim()) setInterim(interimText.trim())
        if (finalText.trim()) sendUtterance(finalText)
      }
      r.onerror = e => {
        if (!state.alive) return
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') degradeToTyping(MESSAGES.micDenied)
        else if (e.error === 'audio-capture' || e.error === 'network') degradeToTyping(MESSAGES.speechBroken)
      }
      r.onend = () => {
        // 静音一段时间识别会自动停，通话没挂就重启（说话停顿断句由 isFinal 承担）
        if (state.alive && state.micState !== 'denied' && state.micState !== 'unsupported') {
          try { r.start() } catch { /* 已在跑 */ }
        }
      }
      try { r.start() } catch { degradeToTyping(MESSAGES.speechBroken) }
    }

    /** 推流模式：麦克风 → PCM16/16kHz 帧上行；失败按原因逐级退。 */
    async function startStreaming() {
      try {
        const handle = await startMicStream({
          onFrame: buf => { if (state.alive && state.serverAsr) wsSendBinary(buf) },
          onLevel: rms => { if (state.alive) onMicLevel(rms) },
        })
        if (!state.alive || !state.serverAsr) { handle.stop(); return }
        micHandle = handle
        setMicState('granted')
        setInputMode('stream')
      } catch (err) {
        if (!state.alive) return
        if (isMicError(err)) degradeToTyping(MESSAGES.micDenied)
        else startRecognition() // 推流组件不可用（非麦克风问题）→ 内建识别兜底
      }
    }

    function startVoiceInput() {
      if (state.inputMode !== 'none') return // 重连后的 ready 不重复起链路
      if (pcmSupported && startMicStream) void startStreaming()
      else startRecognition()
    }

    // ---- 连接与断线重连（自动重连一次，再断放弃并提示） ----

    function connect() {
      let socket
      try {
        socket = createWebSocket(url)
      } catch {
        setPhase('closed')
        setNotice(MESSAGES.connectFailed)
        return
      }
      try { socket.binaryType = 'arraybuffer' } catch { /* fake 可不支持 */ }
      ws = socket
      socket.onopen = () => {
        if (ws === socket) socket.send(JSON.stringify({ type: 'init', thread_id: threadId }))
      }
      socket.onmessage = e => {
        if (!state.alive || ws !== socket) return
        if (typeof e.data === 'string') {
          let ev
          try { ev = JSON.parse(e.data) } catch { return } // 非法帧忽略
          handleEvent(ev)
        } else {
          onAudioChunk(e.data)
        }
      }
      socket.onclose = () => { if (ws === socket) handleClose() }
      socket.onerror = () => { if (state.alive && ws === socket) setNotice(MESSAGES.linkError) }
    }

    function handleClose() {
      if (!state.alive || state.expired) {
        setPhase('closed')
        return
      }
      player.stop()
      if (state.reconnectsLeft > 0) {
        state.reconnectsLeft -= 1
        setNotice(MESSAGES.reconnecting)
        setPhase('connecting')
        connect()
      } else {
        setPhase('closed')
        setNotice(MESSAGES.dead)
      }
    }

    function hangup() {
      if (!state.alive) return
      state.alive = false
      if (micHandle) {
        try { micHandle.stop() } catch { /* 已停 */ }
        micHandle = null
      }
      if (rec) {
        try { rec.stop() } catch { /* 已停 */ }
        rec = null
      }
      try { player.stop() } catch { /* 已停 */ }
      if (player.close) { try { player.close() } catch { /* 已关 */ } }
      const socket = ws
      ws = null
      if (socket) { try { socket.close() } catch { /* 已关 */ } }
      state.phase = 'closed'
      emit('phase', 'closed')
    }

    return {
      start: connect,
      hangup,
      sendTyped: text => sendUtterance(text),
      bargeIn,
      state: () => ({ ...state, tools: state.tools.slice() }),
    }
  }

  return { createVoiceCall, MESSAGES, VAD_RMS_THRESHOLD, VAD_VOICE_FRAMES }
})
