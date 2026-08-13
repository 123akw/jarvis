import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VoiceCall from './VoiceCall.jsx'

// 推流采集模块打桩：测试直接驱动 onFrame/onLevel，覆盖「推流+字幕+VAD 打断+降级」链路
const audioMock = vi.hoisted(() => ({
  handlers: null, stopped: false, supported: true, failWith: null,
}))

vi.mock('./VoiceAudio.js', () => ({
  pcmStreamSupported: () => audioMock.supported,
  isMicError: err => ['NotAllowedError', 'NotFoundError', 'NotReadableError',
    'SecurityError', 'OverconstrainedError'].includes(err?.name),
  startMicStream: async handlers => {
    if (audioMock.failWith) throw audioMock.failWith
    audioMock.handlers = handlers
    return { stop: () => { audioMock.stopped = true } }
  },
}))

class MockWebSocket {
  static OPEN = 1
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.binaryType = ''
    MockWebSocket.instances.push(this)
  }
  send(data) { this.sent.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }) }
  emitBinary(buf) { this.onmessage?.({ data: buf }) }
}

class MockRecognition {
  static instances = []
  constructor() { MockRecognition.instances.push(this) }
  start() { this.onstart?.() }
  stop() {}
}

class MockAudioContext {
  static sources = []
  constructor() {
    this.currentTime = 0
    this.destination = {}
    this.state = 'running'
  }
  createBuffer(_ch, len, rate) {
    return { duration: len / rate, getChannelData: () => new Float32Array(len) }
  }
  createBufferSource() {
    const src = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), buffer: null }
    MockAudioContext.sources.push(src)
    return src
  }
  resume() {}
  close() {}
}

function lastSocket() {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

function jsonUplinks(ws) {
  return ws.sent.filter(x => typeof x === 'string').map(x => JSON.parse(x))
}

async function startCall() {
  render(<VoiceCall threadId="voice" onClose={() => {}} />)
  const ws = lastSocket()
  await act(async () => { ws.open(); ws.emit({ type: 'ready' }) })
  return ws
}

describe('VoiceCall 推流模式', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    MockRecognition.instances = []
    MockAudioContext.sources = []
    audioMock.handlers = null
    audioMock.stopped = false
    audioMock.supported = true
    audioMock.failWith = null
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('AudioContext', MockAudioContext)
    delete window.SpeechRecognition
    delete window.webkitSpeechRecognition
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('推流建立后麦克风帧走二进制上行', async () => {
    const ws = await startCall()
    expect(audioMock.handlers).toBeTruthy()
    expect(screen.getByText('实时识别中，直接说话即可')).toBeInTheDocument()

    const frame = new ArrayBuffer(3200)
    act(() => audioMock.handlers.onFrame(frame))
    expect(ws.sent).toContain(frame)
  })

  it('字幕增量：asr_partial 灰字逐步刷新，asr_final 变实字并清掉灰字', async () => {
    const ws = await startCall()

    act(() => ws.emit({ type: 'asr_partial', text: '今天' }))
    expect(screen.getByTestId('voice-interim')).toHaveTextContent('今天')
    act(() => ws.emit({ type: 'asr_partial', text: '今天天气' }))
    expect(screen.getByTestId('voice-interim')).toHaveTextContent('今天天气')

    act(() => ws.emit({ type: 'asr_final', text: '今天天气怎么样' }))
    expect(screen.queryByTestId('voice-interim')).not.toBeInTheDocument()
    expect(screen.getByText('「今天天气怎么样」')).toBeInTheDocument()
    expect(screen.getByText('思考中…')).toBeInTheDocument()
  })

  it('VAD 打断：播放中连续两帧人声 → 停播 + 上行 interrupt（≈200ms）', async () => {
    const ws = await startCall()
    act(() => ws.emitBinary(new Int16Array([1000, -1000]).buffer))
    expect(screen.getByText('回答中…（开口即可打断）')).toBeInTheDocument()

    act(() => audioMock.handlers.onLevel(0.2)) // 第一帧：还不动手
    expect(jsonUplinks(ws).map(x => x.type)).not.toContain('interrupt')
    act(() => audioMock.handlers.onLevel(0.2)) // 第二帧：确认开口，立即打断

    expect(jsonUplinks(ws).map(x => x.type)).toContain('interrupt')
    expect(MockAudioContext.sources[0].stop).toHaveBeenCalled()
    expect(screen.getByText('请讲，我在听')).toBeInTheDocument()
  })

  it('VAD 静音或未在播放时不误触发打断', async () => {
    const ws = await startCall()
    act(() => { audioMock.handlers.onLevel(0.2); audioMock.handlers.onLevel(0.2) }) // 没在播放
    act(() => ws.emitBinary(new Int16Array([1000, -1000]).buffer))
    act(() => { audioMock.handlers.onLevel(0.01); audioMock.handlers.onLevel(0.01) }) // 播放中但是静音
    expect(jsonUplinks(ws).map(x => x.type)).not.toContain('interrupt')
  })

  it('asr_fallback 降级：停推流、给提示、自动切浏览器识别', async () => {
    window.webkitSpeechRecognition = MockRecognition
    const ws = await startCall()

    await act(async () => ws.emit({ type: 'asr_fallback', message: '服务端语音识别暂不可用，已切换浏览器识别' }))

    expect(audioMock.stopped).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent('已切换浏览器识别')
    expect(MockRecognition.instances).toHaveLength(1)
    // 降级后麦克风帧不再上行
    const before = ws.sent.length
    audioMock.handlers.onFrame(new ArrayBuffer(4))
    expect(ws.sent.length).toBe(before)
  })

  it('推流模式麦克风被拒 → 打字通话降级', async () => {
    audioMock.failWith = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    render(<VoiceCall threadId="voice" onClose={() => {}} />)
    const ws = lastSocket()
    await act(async () => { ws.open(); ws.emit({ type: 'ready' }) })

    expect(await screen.findByRole('alert')).toHaveTextContent('没拿到麦克风权限')
    expect(screen.getByLabelText('打字通话输入')).toBeInTheDocument()
  })

  it('状态机：听（ready）→ 想（asr_final/turn_start）→ 说（音频）→ 打断回到听', async () => {
    const ws = await startCall()
    expect(screen.getByText('请讲，我在听')).toBeInTheDocument()

    act(() => ws.emit({ type: 'asr_final', text: '现在几点了' }))
    expect(screen.getByText('思考中…')).toBeInTheDocument()

    act(() => { ws.emit({ type: 'turn_start' }); ws.emit({ type: 'token', text: '三点整。' }) })
    expect(screen.getByText('三点整。')).toBeInTheDocument()

    act(() => ws.emitBinary(new Int16Array([500, -500]).buffer))
    expect(screen.getByText('回答中…（开口即可打断）')).toBeInTheDocument()

    act(() => ws.emit({ type: 'turn_end', interrupted: true }))
    expect(screen.getByText('请讲，我在听')).toBeInTheDocument()
  })
})
