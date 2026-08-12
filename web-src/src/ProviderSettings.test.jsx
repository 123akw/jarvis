import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getProviderSettings: vi.fn(), testLLMSettings: vi.fn(), saveLLMSettings: vi.fn(), restoreLLMSettings: vi.fn(),
  testIntegration: vi.fn(), saveIntegration: vi.fn(), restoreIntegration: vi.fn(),
}))
import { getProviderSettings, testLLMSettings } from './api.js'
import ProviderSettings from './ProviderSettings.jsx'

const settings = {
  writable: true,
  catalog: [
    { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', editable: false, key_url: 'https://platform.openai.com/api-keys' },
    { id: 'custom', name: '自定义中转', base_url: '', editable: true, key_url: null },
  ],
  llm: { provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-test', key_configured: true, generation: 1 },
  integrations: { searxng: { enabled: true, base_url: 'http://127.0.0.1:18888', key_configured: false, generation: 1 } },
}

describe('provider settings', () => {
  beforeEach(() => { vi.clearAllMocks(); getProviderSettings.mockResolvedValue(settings) })
  afterEach(() => cleanup())

  it('never reads a key back, clears typed secrets after testing, and isolates official links', async () => {
    testLLMSettings.mockResolvedValue({ ok: true, latency_ms: 3 })
    render(<ProviderSettings session={{ username: 'member', role: 'Member' }} />)
    const key = await screen.findByLabelText('API Key')
    expect(key.value).toBe('')
    expect(screen.queryByRole('button', { name: '联网数据源' })).toBeNull()
    fireEvent.change(key, { target: { value: 'temporary-key' } })
    fireEvent.change(screen.getByLabelText('当前口令'), { target: { value: 'temporary-password' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(testLLMSettings).toHaveBeenCalled())
    expect(key.value).toBe('')
    expect(screen.getByLabelText('当前口令').value).toBe('')
    const link = screen.getByRole('link', { name: '打开官方 API Key 申请页' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('only offers keep-existing for the same provider origin and shows integrations to Owners', async () => {
    render(<ProviderSettings session={{ username: 'owner', role: 'Owner' }} />)
    expect(await screen.findByText('保留同一 Provider 与 Origin 的现有 Key')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'custom' } })
    expect(screen.queryByText('保留同一 Provider 与 Origin 的现有 Key')).toBeNull()
    expect(screen.getByRole('button', { name: '联网数据源' })).toBeTruthy()
  })
})
