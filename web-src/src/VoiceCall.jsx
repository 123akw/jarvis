import { useEffect, useRef, useState } from 'react'
import { currentCsrf, voiceSocketUrl } from './api.js'
import './VoiceCall.css'

const PHASE_LABEL = {
  connecting: '接通中…',
  listening: '请讲，我在听',
  thinking: '思考中…',
  speaking: '回答中…（开口即可打断）',
  closed: '通话已断开',
}

const speechCtor = () => window.SpeechRecognition || window.webkitSpeechRecognition

/**
 * 语音通话面板：浏览器语音识别 → WebSocket 上行文字 → 边收文字边收 PCM 音频播放。
 * 识别不可用（无 API / 麦克风被拒）时降级为「打字通话」：打字上行，语音+文字下行。
 */
export default function VoiceCall({ threadId = 'voice', onClose, onExpired }) {
  const [phase, setPhase] = useState('connecting')
  const [micState, setMicState] = useState('pending') // pending|granted|denied|unsupported
  const [notice, setNotice] = useState('')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [tools, setTools] = useState([])
  const [typed, setTyped] = useState('')

  const wsRef = useRef(null)
  const recRef = useRef(null)
  const aliveRef = useRef(true)
  const phaseRef = useRef('connecting')
  const micRef = useRef('pending')
  const turnDoneRef = useRef(true)
  const audioRef = useRef({ ctx: null, nextTime: 0, sources: new Set(), sampleRate: 24000 })

  phaseRef.current = phase
  micRef.current = micState

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

  function sendUtterance(text) {
    text = text.trim()
    if (!text) return
    stopPlayback()
    turnDoneRef.current = false
    setHeard(text)
    setReply('')
    setTools([])
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
    } else if (ev.type === 'turn_start') {
      turnDoneRef.current = false
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

  // ---- 语音识别：连续 + interim，说话停顿自动出 final；出错走降级 ----

  function degrade(message) {
    setMicState(prev => (prev === 'unsupported' ? prev : 'denied'))
    setNotice(message)
  }

  function startRecognition() {
    const Ctor = speechCtor()
    if (!Ctor) {
      setMicState('unsupported')
      setNotice('这个浏览器不支持语音识别，已降级为打字通话：输入文字，贾维斯用语音回答；文字聊天不受影响。')
      return
    }
    let rec
    try {
      rec = new Ctor()
    } catch {
      setMicState('unsupported')
      setNotice('这个浏览器不支持语音识别，已降级为打字通话：输入文字，贾维斯用语音回答；文字聊天不受影响。')
      return
    }
    recRef.current = rec
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.onstart = () => { if (aliveRef.current) setMicState('granted') }
    rec.onresult = e => {
      if (!aliveRef.current) return
      let interim = ''
      let final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) final += r[0].transcript
        else interim += r[0].transcript
      }
      if (interim.trim() || final.trim()) bargeIn()
      if (interim.trim()) setHeard(interim.trim())
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
    startRecognition()
    return () => {
      aliveRef.current = false
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
        </div>
        {micState === 'granted' && phase === 'listening' && (
          <div className="voice-hint">说话停顿后自动发送</div>
        )}
        {heard && <div className="voice-heard">「{heard}」</div>}
        {tools.length > 0 && (
          <div className="voice-tools">
            {tools.map((t, i) => (
              <span key={i} className={`voice-tool${t.done ? ' done' : ''}`}>⚙ {t.name}{t.done ? ' ✓' : '…'}</span>
            ))}
          </div>
        )}
        {reply && <div className="voice-reply">{reply}</div>}
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
