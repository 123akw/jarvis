import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getProviderSettings: vi.fn(),
  getVoiceSettings: vi.fn(),
  saveVoiceSettings: vi.fn(),
  getRadio: vi.fn(),
  saveRadio: vi.fn(),
  getDelivery: vi.fn(),
  saveDelivery: vi.fn(),
  restoreIntegration: vi.fn(),
  restoreLLMSettings: vi.fn(),
  saveIntegration: vi.fn(),
  saveLLMSettings: vi.fn(),
  testIntegration: vi.fn(),
  testLLMSettings: vi.fn(),
}))

import { getDelivery, getProviderSettings, getRadio, getVoiceSettings, saveDelivery } from './api.js'
import DeliverySettings from './DeliverySettings.jsx'
import ProviderSettings from './ProviderSettings.jsx'

const DELIVERY = {
  channels: [
    { id: 'web', label: '网页', available: true, enabled: true },
    { id: 'desktop', label: '桌面', available: true, enabled: true },
    { id: 'wechat', label: '微信', available: true, enabled: true },
    { id: 'feishu', label: '飞书', available: false, enabled: true },
  ],
  dnd: { enabled: false, start: '22:30', end: '08:00' },
}

describe('设置中心 › 语音 › 主动找你', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDelivery.mockResolvedValue(structuredClone(DELIVERY))
    saveDelivery.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('只显示已绑定的渠道，未绑定的给一句提示', async () => {
    render(<DeliverySettings />)
    expect(await screen.findByText('主动找你')).toBeTruthy()
    expect(screen.getByLabelText('网页').checked).toBe(true)
    expect(screen.getByLabelText('微信')).toBeTruthy()
    expect(screen.queryByLabelText('飞书')).toBeNull()
    expect(screen.getByText(/飞书绑定后也会出现在这里/)).toBeTruthy()
    expect(screen.getByText(/日程提醒和晨报照常送达/)).toBeTruthy()
  })

  it('取消一个渠道、打开免打扰并改时间后保存', async () => {
    const onMessage = vi.fn()
    render(<DeliverySettings onMessage={onMessage} />)
    fireEvent.click(await screen.findByLabelText('桌面'))
    expect(screen.queryByLabelText('免打扰开始')).toBeNull()
    fireEvent.click(screen.getByLabelText('免打扰'))
    fireEvent.change(screen.getByLabelText('免打扰开始'), { target: { value: '23:00' } })
    fireEvent.click(screen.getByText('保存送达设置'))
    await waitFor(() => expect(saveDelivery).toHaveBeenCalledWith({
      channels: ['web', 'wechat', 'feishu'], dnd_enabled: true, dnd_start: '23:00', dnd_end: '08:00',
    }))
    expect(onMessage).toHaveBeenCalledWith('送达设置已保存。')
  })

  it('保存失败把服务端的话原样告诉用户', async () => {
    saveDelivery.mockRejectedValue(new Error('免打扰的开始和结束不能相同'))
    const onMessage = vi.fn()
    render(<DeliverySettings onMessage={onMessage} />)
    fireEvent.click(await screen.findByText('保存送达设置'))
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('免打扰的开始和结束不能相同'))
  })

  it('读不到设置时整节不出现', async () => {
    getDelivery.mockRejectedValue(new Error('请求失败'))
    const { container } = render(<DeliverySettings />)
    await waitFor(() => expect(getDelivery).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('挂在「语音」页签里，不新增页签', async () => {
    getProviderSettings.mockResolvedValue({
      writable: true, integrations: {},
      llm: { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'm', key_configured: false, generation: 1 },
      catalog: [{ id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com', editable: false }],
    })
    getVoiceSettings.mockResolvedValue({ voice: 'v', speed: 1, catalog: [{ id: 'v', name: '默认' }] })
    getRadio.mockResolvedValue({ time: '' })
    render(<ProviderSettings session={{ username: 'admin', role: 'Owner' }} />)
    expect(screen.queryByText('主动找你')).toBeNull()
    fireEvent.click(await screen.findByText('语音'))
    expect(await screen.findByText('主动找你')).toBeTruthy()
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['模型 API', '语音', '桌面与会议', '联网数据源'])
  })
})
