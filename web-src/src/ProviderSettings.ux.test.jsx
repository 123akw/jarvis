import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getProviderSettings: vi.fn(), testLLMSettings: vi.fn(), saveLLMSettings: vi.fn(), restoreLLMSettings: vi.fn(),
  testIntegration: vi.fn(), saveIntegration: vi.fn(), restoreIntegration: vi.fn(),
}))
import { getProviderSettings, testIntegration, testLLMSettings } from './api.js'
import ProviderSettings from './ProviderSettings.jsx'

const SETTINGS = {
  writable: true,
  catalog: [{ id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', editable: false }],
  llm: { provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-test', key_configured: true, generation: 1 },
  integrations: { searxng: { enabled: true, base_url: 'http://127.0.0.1:18888', key_configured: false, generation: 1 } },
}
const pending = () => new Promise(() => {})

describe('设置中心：进行中的反馈', () => {
  beforeEach(() => { vi.clearAllMocks(); getProviderSettings.mockResolvedValue(SETTINGS) })
  afterEach(cleanup)

  it('测试连接进行中：按钮显示「测试中…」并禁用全部操作（测试会花钱，防连点）', async () => {
    testLLMSettings.mockImplementation(pending)
    render(<ProviderSettings session={{ username: 'owner', role: 'Owner' }} />)
    fireEvent.change(await screen.findByLabelText('当前口令'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(screen.getByRole('button', { name: '测试中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存并应用' })).toBeDisabled()
  })

  it('联网数据源测试进行中同样禁用按钮', async () => {
    testIntegration.mockImplementation(pending)
    render(<ProviderSettings session={{ username: 'owner', role: 'Owner' }} />)
    fireEvent.click(await screen.findByRole('tab', { name: '联网数据源' }))
    fireEvent.change(screen.getByLabelText('Owner 当前口令'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(screen.getByRole('button', { name: '测试中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })
})
