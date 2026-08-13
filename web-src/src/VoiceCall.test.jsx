import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VoiceCall from './VoiceCall.jsx'

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

function sentTypes(ws) {
  return ws.sent.map(x => JSON.parse(x).type)
}

describe('VoiceCall', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    MockRecognition.instances = []
    MockAudioContext.sources = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('AudioContext', MockAudioContext)
    delete window.SpeechRecognition
    delete window.webkitSpeechRecognition
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('无语音识别 API 时降级为打字通话，输入文字走 user_text 上行', async () => {
    render(<VoiceCall threadId="voice" onClose={() => {}} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('不支持语音识别')
    const ws = lastSocket()
    act(() => { ws.open(); ws.emit({ type: 'ready' }) })
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'init', thread_id: 'voice' })

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('打字通话输入'), '今天天气怎么样{Enter}')
    const uplinks = ws.sent.map(x => JSON.parse(x))
    expect(uplinks).toContainEqual({ type: 'user_text', text: '今天天气怎么样' })
  })

  it('麦克风权限被拒时给出人话降级提示，打字通话仍可用', async () => {
    window.webkitSpeechRecognition = MockRecognition
    render(<VoiceCall onClose={() => {}} />)
    const rec = MockRecognition.instances[0]

    act(() => rec.onerror({ error: 'not-allowed' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('没拿到麦克风权限')
    expect(screen.getByLabelText('打字通话输入')).toBeInTheDocument()
  })

  it('识别到完整一句话就上行，并展示录音中/思考中/播放中状态流转', async () => {
    window.webkitSpeechRecognition = MockRecognition
    render(<VoiceCall onClose={() => {}} />)
    const ws = lastSocket()
    const rec = MockRecognition.instances[0]
    act(() => { ws.open(); ws.emit({ type: 'ready' }) })
    expect(screen.getByText('请讲，我在听')).toBeInTheDocument()

    act(() => rec.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: '记一条备忘' }], { isFinal: true })],
    }))
    expect(sentTypes(ws)).toContain('user_text')
    expect(screen.getByText('思考中…')).toBeInTheDocument()

    act(() => { ws.emit({ type: 'turn_start' }); ws.emit({ type: 'token', text: '好的，' }) })
    act(() => ws.emit({ type: 'token', text: '已记下。' }))
    expect(screen.getByText('好的，已记下。')).toBeInTheDocument()

    act(() => ws.emitBinary(new Int16Array([800, -800, 400, -400]).buffer))
    expect(screen.getByText('回答中…（开口即可打断）')).toBeInTheDocument()
    expect(MockAudioContext.sources).toHaveLength(1)
    expect(MockAudioContext.sources[0].start).toHaveBeenCalled()
  })

  it('播放中开口或点打断：停掉本地播放并上行 interrupt', async () => {
    window.webkitSpeechRecognition = MockRecognition
    render(<VoiceCall onClose={() => {}} />)
    const ws = lastSocket()
    act(() => { ws.open(); ws.emit({ type: 'ready' }) })
    act(() => ws.emitBinary(new Int16Array([1000, -1000]).buffer))
    expect(screen.getByText('回答中…（开口即可打断）')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '打断' }))

    expect(sentTypes(ws)).toContain('interrupt')
    expect(MockAudioContext.sources[0].stop).toHaveBeenCalled()
    expect(screen.getByText('请讲，我在听')).toBeInTheDocument()
  })

  it('TTS 失败降级提示可见，回合结束回到聆听态；挂断触发 onClose', async () => {
    window.webkitSpeechRecognition = MockRecognition
    const onClose = vi.fn()
    render(<VoiceCall onClose={onClose} />)
    const ws = lastSocket()
    act(() => { ws.open(); ws.emit({ type: 'ready' }) })
    act(() => { ws.emit({ type: 'turn_start' }); ws.emit({ type: 'tts_error', message: '语音合成暂不可用，本回合降级为纯文字' }) })
    expect(screen.getByRole('alert')).toHaveTextContent('语音合成暂不可用')

    act(() => ws.emit({ type: 'turn_end', interrupted: false }))
    expect(screen.getByText('请讲，我在听')).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: '挂断' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
