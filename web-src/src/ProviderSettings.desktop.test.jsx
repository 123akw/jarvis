import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getProviderSettings: vi.fn(), testLLMSettings: vi.fn(), saveLLMSettings: vi.fn(), restoreLLMSettings: vi.fn(),
  testIntegration: vi.fn(), saveIntegration: vi.fn(), restoreIntegration: vi.fn(),
  getVoiceSettings: vi.fn(), saveVoiceSettings: vi.fn(), getRadio: vi.fn(), saveRadio: vi.fn(),
  getDesktopSettings: vi.fn(), saveDesktopSettings: vi.fn(),
  getMeetingSettings: vi.fn(), saveMeetingSettings: vi.fn(),
}))
vi.mock('./desktopWake.js', () => ({
  pingDesktop: vi.fn(),
  desktopWindow: vi.fn(),
}))
import {
  getDesktopSettings, getMeetingSettings, getProviderSettings,
  saveDesktopSettings, saveMeetingSettings,
} from './api.js'
import { desktopWindow, pingDesktop } from './desktopWake.js'
import ProviderSettings from './ProviderSettings.jsx'

const settings = {
  writable: true,
  catalog: [{ id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', editable: false, key_url: null }],
  llm: { provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-test', key_configured: false, generation: 1 },
  integrations: {},
}

async function openDesktopTab() {
  render(<ProviderSettings session={{ username: 'member', role: 'Member' }} />)
  fireEvent.click(await screen.findByRole('tab', { name: '桌面与会议' }))
}

describe('「桌面与会议」页签', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProviderSettings.mockResolvedValue(settings)
    pingDesktop.mockResolvedValue({ loggedIn: true })
    getDesktopSettings.mockResolvedValue({ ball_visible: true })
    getMeetingSettings.mockResolvedValue({ mail_to: '', default: '1539598168@qq.com', smtp_configured: false })
    saveDesktopSettings.mockResolvedValue({ ok: true, ball_visible: false })
    saveMeetingSettings.mockResolvedValue({ ok: true, mail_to: 'boss@corp.cn' })
    desktopWindow.mockResolvedValue({ status: 'done' })
  })
  afterEach(cleanup)

  it('隐藏悬浮球：先写服务端偏好，再走本机快路径', async () => {
    await openDesktopTab()
    expect(await screen.findByText(/在这台电脑上运行中/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '隐藏悬浮球' }))
    await waitFor(() => expect(saveDesktopSettings).toHaveBeenCalledWith(false))
    await waitFor(() => expect(desktopWindow).toHaveBeenCalledWith('hide'))
    expect((await screen.findByText(/悬浮球已隐藏/)).textContent).toContain('托盘')
  })

  it('彻底关闭需二次确认才发 quit', async () => {
    await openDesktopTab()
    const quit = await screen.findByRole('button', { name: '彻底关闭桌面端' })
    fireEvent.click(quit)
    expect(desktopWindow).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '再点一次确认关闭' }))
    await waitFor(() => expect(desktopWindow).toHaveBeenCalledWith('quit'))
    expect(await screen.findByText(/桌面端已彻底关闭/)).toBeTruthy()
  })

  it('保存会议纪要收件邮箱；SMTP 未配置时给出提示', async () => {
    await openDesktopTab()
    expect(await screen.findByText(/还没配置 SMTP/)).toBeTruthy()
    const input = screen.getByLabelText('会议纪要收件邮箱')
    expect(input.placeholder).toContain('1539598168@qq.com')
    fireEvent.change(input, { target: { value: 'boss@corp.cn' } })
    fireEvent.click(screen.getByRole('button', { name: '保存收件邮箱' }))
    await waitFor(() => expect(saveMeetingSettings).toHaveBeenCalledWith('boss@corp.cn'))
    expect((await screen.findByText(/将发送至 boss@corp.cn/)).textContent).toBeTruthy()
  })

  it('桌面端不在本机：动作退化为服务器下发提示', async () => {
    pingDesktop.mockResolvedValue(null)
    desktopWindow.mockResolvedValue({ status: 'not-running' })
    await openDesktopTab()
    expect(await screen.findByText(/未运行/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '显示悬浮球' }))
    await waitFor(() => expect(saveDesktopSettings).toHaveBeenCalledWith(true))
    expect((await screen.findByText(/10 秒内显示悬浮球/)).textContent).toBeTruthy()
  })
})
