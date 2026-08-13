import { useEffect, useRef, useState } from 'react'
import { currentCsrf, voiceSocketUrl } from './api.js'
import { isMicError, pcmStreamSupported, startMicStream } from './VoiceAudio.js'
import './VoiceCall.css'

const PHASE_LABEL = {
  connecting: '接通中…',
  listening: '请讲，我在听',
  thinking: '思考中…',
  speaking: '回答中…（开口即可打断）',
  closed: '通话已断开',
}

const VAD_RMS_THRESHOLD = 0.04 // 帧级 RMS 高于此视作人声（回声消除后的余量）
const VAD_VOICE_FRAMES = 2     // 连续 2 帧（约 200ms）确认开口 → 打断，远小于 500ms 预算

const speechCtor = () => window.SpeechRecognition || window.webkitSpeechRecognition

/**
 * 语音通话面板：三层输入链路，自动逐级降级。
 * 1) 推流模式：AudioWorklet 采集 PCM16/16kHz 二进制上行 → 服务端百炼流式识别
 *    （asr_partial 灰字字幕 / asr_final 定稿开回合），本地 VAD 开口即打断；
 * 2) 浏览器识别模式：服务端识别不可用（asr_fallback）或推流组件缺失时，退回
 *    window.SpeechRecognition，final 文本走 user_text 上行；
 * 3) 打字通话：识别 API/麦克风都没有时，打字上行、语音+文字下行。
 */
export default function VoiceCall({ threadId = 'voice', onClose, onExpired }) {
  const [phase, setPhase] = useState('connecting')
  const [micState, setMicState] = useState('pending') // pending|granted|denied|unsupported
  const [inputMode, setInputMode] = useState('none')  // none|stream|speech|typing
  const [notice, setNotice] = useState('')
  const [heard, setHeard] = useState('')       // 定稿实字
  const [interim, setInterim] = useState('')   // 识别中灰字
  const [reply, setReply] = useState('')
  const [tools, setTools] = useState([])
  const [typed, setTyped] = useState('')

  const wsRef = useRef(null)
  const recRef = useRef(null)
  const streamRef = useRef(null)   // 推流句柄 {stop}
  const aliveRef = useRef(true)
  const phaseRef = useRef('connecting')
  const micRef = useRef('pending')
  const turnDoneRef = useRef(true)
  const serverAsrRef = useRef(true) // 收到 asr_fallback 置 false，二进制停发
  const vadRef = useRef(0)
  const replyRef = useRef(null)
  const audioRef = useRef({ ctx: null, nextTime: 0, sources: new Set(), sampleRate: 24000 })

  phaseRef.current = phase
  micRef.current = micState

  useEffect(() => {  // 回答字幕跟随滚动
    if (replyRef.current) replyRef.current.scrollTop = replyRef.current.scrollHeight
  }, [reply])

  function setPhaseSafe(p) {
    if (aliveRef.current) setPhase(p)
  }

  // ---- 音频播放：PCM16 小端单声道，按块排队，打断时全部停掉 ----

  function ensureCtx() {
    const a = audioRef.current
    if (!a.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return null
      a.ctx = new Ctx()
    }
    if (a.ctx.state === 'suspended') a.ctx.resume?.()
    return a.ctx
  }

  function playChunk(buf) {
    const a = audioRef.current
    const ctx = ensureCtx()
    if (!ctx) return
    const usable = buf.byteLength - (buf.byteLength % 2)
    if (!usable) return
    const pcm = new Int16Array(buf, 0, usable / 2)
    const f32 = Float32Array.from(pcm, v => v / 32768)
    const buffer = ctx.createBuffer(1, f32.length, a.sampleRate || 24000)
    buffer.getChannelData(0).set(f32)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    const at = Math.max(ctx.currentTime + 0.02, a.nextTime || 0)
    src.start(at)
    a.nextTime = at + buffer.duration
    a.sources.add(src)
    src.onended = () => {
      a.sources.delete(src)
      if (!a.sources.size && turnDoneRef.current && phaseRef.current === 'speaking') {
        setPhaseSafe('listening')
      }
    }
    setPhaseSafe('speaking')
  }

  function stopPlayback() {
    const a = audioRef.current
    for (const s of a.sources) { try { s.stop() } catch { /* 已停 */ } }
    a.sources.clear()
    a.nextTime = 0
  }

  // ---- 上行 ----

  function wsSend(obj) {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }

  function wsSendBinary(buf) {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf)
  }

  function sendUtterance(text) {
    text = text.trim()
    if (!text) return
    stopPlayback()
    turnDoneRef.current = false
    setHeard(text)
    setInterim('')
    setPhaseSafe('thinking')
    wsSend({ type: 'user_text', text })
  }

  function bargeIn() {
    if (phaseRef.current === 'speaking' || audioRef.current.sources.size > 0) {
      wsSend({ type: 'interrupt' })
      stopPlayback()
      setPhaseSafe('listening')
    }
  }

  /** 本地音量 VAD：播放中连续两帧检测到人声（约 200ms）→ 立即停播 + 通知取消 TTS。 */
  function onMicLevel(rms) {
    const playing = phaseRef.current === 'speaking' || audioRef.current.sources.size > 0
    if (!playing || rms < VAD_RMS_THRESHOLD) {
      vadRef.current = 0
      return
    }
    vadRef.current += 1
    if (vadRef.current >= VAD_VOICE_FRAMES) {
      vadRef.current = 0
      bargeIn()
    }
  }

  function sendTyped() {
    const text = typed.trim()
    if (!text) return
    setTyped('')
    sendUtterance(text)
  }

  // ---- 下行事件 ----

  function handleEvent(ev) {
    if (ev.type === 'ready') {
      setPhaseSafe('listening')
    } else if (ev.type === 'asr_partial') {
      setInterim(ev.text || '')
      if ((ev.text || '').trim()) bargeIn() // 服务端听到人声：本地 VAD 之外的兜底打断
    } else if (ev.type === 'asr_final') {
      setInterim('')
      const text = (ev.text || '').trim()
      if (text) {
        stopPlayback()
        turnDoneRef.current = false
        setHeard(text)
        setPhaseSafe('thinking')
      }
    } else if (ev.type === 'asr_fallback') {
      degradeToSpeech(ev.message || '服务端语音识别暂不可用，已切换浏览器识别')
    } else if (ev.type === 'turn_start') {
      turnDoneRef.current = false
      setReply('')
      setTools([])
      setPhaseSafe('thinking')
    } else if (ev.type === 'token') {
      setReply(r => r + ev.text)
    } else if (ev.type === 'tool_start') {
      setTools(ts => [...ts, { name: ev.name, done: false }])
    } else if (ev.type === 'tool_result') {
      setTools(ts => {
        const out = [...ts]
        const i = out.findIndex(t => t.name === ev.name && !t.done)
        if (i >= 0) out[i] = { ...out[i], done: true }
        return out
      })
    } else if (ev.type === 'audio_start') {
      audioRef.current.sampleRate = ev.sample_rate || 24000
    } else if (ev.type === 'tts_error') {
      setNotice(ev.message || '语音合成暂不可用，本回合降级为纯文字')
    } else if (ev.type === 'turn_end') {
      turnDoneRef.current = true
      if (ev.interrupted || audioRef.current.sources.size === 0) setPhaseSafe('listening')
    } else if (ev.type === 'error') {
      if (ev.code === 'unauthorized' || ev.code === 'csrf') { onExpired?.(); return }
      setNotice(ev.message || '通话链路出错')
      if (turnDoneRef.current) setPhaseSafe('listening')
    }
  }

  // ---- 输入链路与逐级降级 ----

  function degrade(message) {
    setMicState(prev => (prev === 'unsupported' ? prev : 'denied'))
    setInputMode('typing')
    setNotice(message)
  }

  /** 服务端识别不可用：停推流，退回浏览器识别（再不行退打字）。 */
  function degradeToSpeech(message) {
    serverAsrRef.current = false
    streamRef.current?.stop()
    streamRef.current = null
    setInterim('')
    setNotice(message)
    startRecognition()
  }

  function startRecognition() {
    if (recRef.current) return // 已在浏览器识别模式
    const Ctor = speechCtor()
    if (!Ctor) {
      setMicState('unsupported')
      setInputMode('typing')
      setNotice('这个浏览器不支持语音识别，已降级为打字通话：输入文字，贾维斯用语音回答；文字聊天不受影响。')
      return
    }
    let rec
    try {
      rec = new Ctor()
    } catch {
      setMicState('unsupported')
      setInputMode('typing')
      setNotice('这个浏览器不支持语音识别，已降级为打字通话：输入文字，贾维斯用语音回答；文字聊天不受影响。')
      return
    }
    recRef.current = rec
    setInputMode('speech')
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.onstart = () => { if (aliveRef.current) setMicState('granted') }
    rec.onresult = e => {
      if (!aliveRef.current) return
      let interimText = ''
      let final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) final += r[0].transcript
        else interimText += r[0].transcript
      }
      if (interimText.trim() || final.trim()) bargeIn()
      if (interimText.trim()) setInterim(interimText.trim())
      if (final.trim()) sendUtterance(final)
    }
    rec.onerror = e => {
      if (!aliveRef.current) return
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        degrade('没拿到麦克风权限。语音识别已停用，可以在下面打字通话（贾维斯照样语音回答）；关掉本面板后文字聊天完全不受影响。')
      } else if (e.error === 'audio-capture' || e.error === 'network') {
        degrade('语音识别暂不可用（找不到麦克风或识别服务不可达），已降级为打字通话：输入文字，贾维斯用语音回答。')
      }
    }
    rec.onend = () => {
      // Chrome 静音一段时间会自动停，通话没挂就重启（说话停顿自动断句由 isFinal 承担）
      if (aliveRef.current && micRef.current !== 'denied' && micRef.current !== 'unsupported') {
        try { rec.start() } catch { /* 已在跑 */ }
      }
    }
    try {
      rec.start()
    } catch {
      degrade('麦克风启动失败，已降级为打字通话：输入文字，贾维斯用语音回答。')
    }
  }

  /** 推流模式：麦克风 → PCM16/16kHz 帧上行；失败按原因逐级退。 */
  async function startStreaming() {
    try {
      const handle = await startMicStream({
        onFrame: buf => {
          if (aliveRef.current && serverAsrRef.current) wsSendBinary(buf)
        },
        onLevel: rms => { if (aliveRef.current) onMicLevel(rms) },
      })
      if (!aliveRef.current || !serverAsrRef.current) { handle.stop(); return }
      streamRef.current = handle
      setMicState('granted')
      setInputMode('stream')
    } catch (err) {
      if (!aliveRef.current) return
      if (isMicError(err)) {
        degrade('没拿到麦克风权限。语音识别已停用，可以在下面打字通话（贾维斯照样语音回答）；关掉本面板后文字聊天完全不受影响。')
      } else {
        startRecognition() // 推流组件不可用（非麦克风问题）→ 浏览器识别兜底
      }
    }
  }

  /** 老识别路径进入前先探麦克风权限：被拒立即人话降级，拿到了再开识别。 */
  function probeThenRecognize() {
    if (!navigator.mediaDevices?.getUserMedia) {
      startRecognition() // 无法探测的老浏览器交给识别自身报错
      return
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      stream.getTracks().forEach(t => t.stop()) // 只探权限，采音交给语音识别
      if (aliveRef.current) startRecognition()
    }).catch(() => {
      if (!aliveRef.current) return
      degrade('没拿到麦克风权限。语音识别已停用，可以在下面打字通话（贾维斯照样语音回答）；关掉本面板后文字聊天完全不受影响。')
    })
  }

  function startVoiceInput() {
    if (pcmStreamSupported()) startStreaming()
    else probeThenRecognize()
  }

  useEffect(() => {
    aliveRef.current = true
    let ws
    try {
      ws = new WebSocket(voiceSocketUrl())
    } catch {
      setPhase('closed')
      setNotice('无法建立通话连接')
      return () => { aliveRef.current = false }
    }
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'init', csrf: currentCsrf(), thread_id: threadId }))
    ws.onmessage = e => {
      if (!aliveRef.current) return
      if (e.data instanceof ArrayBuffer) playChunk(e.data)
      else { try { handleEvent(JSON.parse(e.data)) } catch { /* 非法帧忽略 */ } }
    }
    ws.onclose = () => { if (aliveRef.current) setPhase('closed') }
    ws.onerror = () => { if (aliveRef.current) setNotice('通话链路出错') }
    startVoiceInput()
    return () => {
      aliveRef.current = false
      try { streamRef.current?.stop() } catch { /* 已停 */ }
      streamRef.current = null
      try { recRef.current?.stop() } catch { /* 已停 */ }
      recRef.current = null
      stopPlayback()
      try { audioRef.current.ctx?.close() } catch { /* 已关 */ }
      try { ws.close() } catch { /* 已关 */ }
    }
  }, [])

  const degraded = micState === 'denied' || micState === 'unsupported'

  return (
    <div className="voice-overlay" role="dialog" aria-label="语音通话">
      <div className="voice-panel">
        <div className="voice-status">
          <span className={`voice-orb ${phase}`} data-testid="voice-orb" />
          <span className="voice-phase">{PHASE_LABEL[phase] || phase}</span>
          {phase === 'thinking' && <span className="voice-dots" aria-hidden="true"><i /><i /><i /></span>}
          {phase === 'speaking' && <span className="voice-eq" aria-hidden="true"><i /><i /><i /><i /></span>}
        </div>
        {micState === 'granted' && phase === 'listening' && (
          <div className="voice-hint">
            {inputMode === 'stream' ? '实时识别中，直接说话即可' : '说话停顿后自动发送'}
          </div>
        )}
        {(heard || interim) && (
          <div className="voice-heard">
            {heard && !interim && <span className="vh-final">「{heard}」</span>}
            {interim && <span className="vh-interim" data-testid="voice-interim">{interim}</span>}
          </div>
        )}
        {tools.length > 0 && (
          <div className="voice-tools">
            {tools.map((t, i) => (
              <span key={i} className={`voice-tool${t.done ? ' done' : ''}`}>⚙ {t.name}{t.done ? ' ✓' : '…'}</span>
            ))}
          </div>
        )}
        {reply && <div className="voice-reply" ref={replyRef}>{reply}</div>}
        {notice && <div className="voice-notice" role="alert">⚠ {notice}</div>}
        {degraded && (
          <div className="voice-typebar">
            <input
              value={typed}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') sendTyped() }}
              placeholder="打字说话，语音答复…"
              aria-label="打字通话输入"
            />
            <button onClick={sendTyped} disabled={!typed.trim()}>发送</button>
          </div>
        )}
        <div className="voice-actions">
          {phase === 'speaking' && (
            <button className="voice-btn" onClick={bargeIn}>打断</button>
          )}
          <button className="voice-btn hangup" onClick={onClose}>挂断</button>
        </div>
      </div>
    </div>
  )
}
