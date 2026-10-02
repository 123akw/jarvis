import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getThreads: vi.fn(), deleteThread: vi.fn(), renameThread: vi.fn(), getHistory: vi.fn(),
  getProviderSettings: vi.fn(), testLLMSettings: vi.fn(), saveLLMSettings: vi.fn(), restoreLLMSettings: vi.fn(),
  testIntegration: vi.fn(), saveIntegration: vi.fn(), restoreIntegration: vi.fn(),
  getVoiceSettings: vi.fn(() => Promise.resolve({ voice: 'a', speed: 1, catalog: [{ id: 'a', name: 'A' }], scenes: [] })),
  getRadio: vi.fn(() => Promise.resolve({ time: '' })), saveVoiceSettings: vi.fn(), saveRadio: vi.fn(),
  getDesktopSettings: vi.fn(() => Promise.resolve({ ball_visible: true })), saveDesktopSettings: vi.fn(),
  getMeetingSettings: vi.fn(() => Promise.resolve({ mail_to: '', default: '', smtp_configured: true })), saveMeetingSettings: vi.fn(),
  currentCsrf: vi.fn(() => ''), voiceSocketUrl: vi.fn(() => 'ws://x/api/voice/call'),
  login: vi.fn(),
}))
vi.mock('./desktopWake.js', () => ({ pingDesktop: vi.fn(() => Promise.resolve(null)), desktopWindow: vi.fn() }))
vi.mock('./Moss.jsx', () => ({ default: () => null }))

import AccountMenu from './AccountMenu.jsx'
import { getProviderSettings, getThreads, login } from './api.js'
import Login from './Login.jsx'
import Modal, { ModalHead } from './Modal.jsx'
import ProviderSettings from './ProviderSettings.jsx'
import Threads from './Threads.jsx'
import VoiceCall from './VoiceCall.jsx'

function memoryStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: k => { m.delete(k) } }
}

function ModalHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开设置</button>
      <button type="button">背景按钮</button>
      {open ? (
        <Modal label="测试弹窗" onClose={() => setOpen(false)}>
          <ModalHead title="测试弹窗" onClose={() => setOpen(false)} />
          <input aria-label="第一项" />
          <button type="button">最后一项</button>
        </Modal>
      ) : null}
    </>
  )
}

describe('弹窗焦点管理', () => {
  afterEach(cleanup)

  it('打开后焦点移入弹窗，Tab / Shift+Tab 在弹窗内循环，Esc 关闭后焦点回到触发按钮', async () => {
    const user = userEvent.setup()
    render(<ModalHarness />)
    const opener = screen.getByRole('button', { name: '打开设置' })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: '测试弹窗' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    screen.getByRole('button', { name: '最后一项' }).focus()
    await user.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }))
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '最后一项' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('头像菜单键盘', () => {
  afterEach(cleanup)
  const commands = [
    { id: 'a', label: '账户设置', icon: 'user', run: vi.fn() },
    { id: 'b', label: '设置中心', icon: 'sliders', run: vi.fn() },
    { id: 'c', label: '退出登录', icon: 'logout', run: vi.fn() },
  ]

  it('Esc 关闭后焦点回到头像按钮；Home / End 跳到首尾项', async () => {
    const user = userEvent.setup()
    render(<AccountMenu session={{ username: 'owner', role: 'Owner' }} status={{ state: 'online', label: '在线' }} commands={commands} />)
    const avatar = screen.getByRole('button', { name: '账户与设置' })
    await user.click(avatar)
    expect(document.activeElement).toHaveTextContent('账户设置')
    await user.keyboard('{End}')
    expect(document.activeElement).toHaveTextContent('退出登录')
    await user.keyboard('{Home}')
    expect(document.activeElement).toHaveTextContent('账户设置')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(avatar)
  })

  it('点菜单项后焦点先交还头像按钮（随后打开的弹窗关闭时能还回这里）', async () => {
    const user = userEvent.setup()
    render(<AccountMenu session={{ username: 'owner' }} status={{ state: 'online', label: '在线' }} commands={commands} />)
    const avatar = screen.getByRole('button', { name: '账户与设置' })
    await user.click(avatar)
    let focusedAtRun = null
    commands[1].run.mockImplementation(() => { focusedAtRun = document.activeElement })
    await user.click(screen.getByRole('menuitem', { name: '设置中心' }))
    expect(commands[1].run).toHaveBeenCalled()
    expect(focusedAtRun).toBe(avatar)
  })
})

class MockWebSocket {
  static OPEN = 1
  constructor() { this.readyState = 0; this.sent = [] }
  send(d) { this.sent.push(d) }
  close() { this.readyState = 3 }
}
class MockAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
  resume() {}
  close() {}
}

describe('语音通话层是模态', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('AudioContext', MockAudioContext)
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('aria-modal、焦点移入通话层、Esc 挂断', async () => {
    const onClose = vi.fn()
    render(<VoiceCall onClose={onClose} />)
    const dialog = await screen.findByRole('dialog', { name: '语音通话' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('会话栏键盘可达', () => {
  beforeEach(() => {
    getThreads.mockResolvedValue([
      { id: 'a', title: '深圳天气', updated: '2026-08-14 09:00' },
      { id: 'b', title: '写周报', updated: '2026-08-14 08:00' },
    ])
  })
  afterEach(cleanup)

  it('每条会话本身是按钮：Tab 可达、回车切换，当前项标 aria-current', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Threads current="a" onSelect={onSelect} onNew={() => {}} refreshKey={0} />)
    const item = await screen.findByRole('button', { name: '写周报' })
    item.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(screen.getByRole('button', { name: '深圳天气' })).toHaveAttribute('aria-current', 'true')
  })

  it('改名输入框里按 Esc 只取消改名，不往外冒泡（抽屉模式不会被一起关掉）', async () => {
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    try {
      render(<Threads current="a" onSelect={() => {}} onNew={() => {}} refreshKey={0} />)
      await screen.findByRole('button', { name: '深圳天气' })
      fireEvent.click(screen.getAllByTitle('重命名')[0])
      const input = screen.getByDisplayValue('深圳天气')
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByDisplayValue('深圳天气')).toBeNull()
      expect(outer.mock.calls.filter(([e]) => e.key === 'Escape')).toHaveLength(0)
    } finally {
      window.removeEventListener('keydown', outer)
    }
  })
})

describe('设置中心页签语义', () => {
  beforeEach(() => {
    getProviderSettings.mockResolvedValue({
      writable: true,
      catalog: [{ id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', editable: false }],
      llm: { provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'm', key_configured: false, generation: 1 },
      integrations: { searxng: { enabled: false, base_url: '', key_configured: false, generation: 1 } },
    })
  })
  afterEach(cleanup)

  it('页签是 role=tab 并标 aria-selected，←/→ 键切换', async () => {
    render(<ProviderSettings session={{ username: 'owner', role: 'Owner' }} />)
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['模型 API', '语音', '桌面与会议', '联网数据源'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByRole('tab', { name: '语音' })).toHaveAttribute('aria-selected', 'true'))
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '语音' }))
    expect(screen.getByRole('tabpanel')).toBeInTheDocument()
  })
})

describe('登录失败后的焦点', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); login.mockReset() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('口令错误：焦点回到口令框，直接重输', async () => {
    login.mockResolvedValue(null)
    const user = userEvent.setup()
    render(<Login onAuthed={() => {}} />)
    await user.type(screen.getByLabelText('用户名'), 'owner')
    await user.type(screen.getByLabelText('口令'), 'bad')
    await user.click(screen.getByRole('button', { name: '接入系统' }))
    await screen.findByText('身份未确认，请重试')
    expect(document.activeElement).toBe(screen.getByLabelText('口令'))
  })

  it('用户名或口令为空时不发请求，提示并聚焦空着的那一栏', async () => {
    const user = userEvent.setup()
    render(<Login onAuthed={() => {}} />)
    await user.type(screen.getByLabelText('用户名'), 'owner')
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: '登录' })) })
    expect(login).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByLabelText('口令'))
    expect(screen.getByText('请输入口令')).toBeInTheDocument()
  })
})

describe('语音通话：麦克风授权中的状态', () => {
  let ws
  beforeEach(() => {
    vi.stubGlobal('WebSocket', class extends MockWebSocket { constructor(u) { super(u); ws = this } })
    vi.stubGlobal('AudioContext', MockAudioContext)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    delete window.webkitSpeechRecognition
    delete navigator.mediaDevices
  })

  it('还没拿到麦克风授权时不说「我在听」，而是提示等待授权', async () => {
    window.webkitSpeechRecognition = class { start() {} stop() {} }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true, value: { getUserMedia: vi.fn(() => new Promise(() => {})) },
    })
    render(<VoiceCall onClose={() => {}} />)
    act(() => { ws.readyState = 1; ws.onopen?.(); ws.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }) })
    expect(screen.getByText('等待麦克风授权…')).toBeInTheDocument()
    expect(screen.queryByText('请讲，我在听')).toBeNull()
  })
})
