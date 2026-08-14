import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getProviderSettings: vi.fn(),
  getVoiceSettings: vi.fn(),
  saveVoiceSettings: vi.fn(),
  getRadio: vi.fn(),
  saveRadio: vi.fn(),
  restoreIntegration: vi.fn(),
  restoreLLMSettings: vi.fn(),
  saveIntegration: vi.fn(),
  saveLLMSettings: vi.fn(),
  testIntegration: vi.fn(),
  testLLMSettings: vi.fn(),
}))

import { getProviderSettings, getRadio, getVoiceSettings, saveRadio, saveVoiceSettings } from './api.js'
import ProviderSettings from './ProviderSettings.jsx'

const SETTINGS = {
  writable: true,
  llm: { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash', key_configured: false, generation: 1 },
  catalog: [{ id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com', editable: false }],
  integrations: {},
}

describe('语音设置页签', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProviderSettings.mockResolvedValue(SETTINGS)
    getVoiceSettings.mockResolvedValue({
      voice: 'male-qn-qingse', speed: 1,
      catalog: [
        { id: 'male-qn-qingse', name: '青涩青年（默认）' },
        { id: 'female-yujie', name: '御姐' },
      ],
    })
    saveVoiceSettings.mockResolvedValue({ ok: true })
    getRadio.mockResolvedValue({ time: '' })
    saveRadio.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('切到「语音」页签可选音色调语速并保存', async () => {
    render(<ProviderSettings session={{ username: 'admin', role: 'Member' }} />)
    fireEvent.click(await screen.findByText('语音'))
    const voiceSel = await screen.findByLabelText('音色')
    fireEvent.change(voiceSel, { target: { value: 'female-yujie' } })
    fireEvent.change(screen.getByLabelText('语速'), { target: { value: '1.2' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(saveVoiceSettings).toHaveBeenCalledWith('female-yujie', 1.2))
    expect(await screen.findByText(/语音设置已保存/)).toBeTruthy()
  })

  it('晨报电台时间随语音设置一起保存', async () => {
    render(<ProviderSettings session={{ username: 'admin', role: 'Member' }} />)
    fireEvent.click(await screen.findByText('语音'))
    const timeInput = await screen.findByLabelText('晨报时间')
    fireEvent.change(timeInput, { target: { value: '08:30' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(saveRadio).toHaveBeenCalledWith('08:30'))
  })
})
