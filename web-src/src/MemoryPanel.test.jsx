import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getProfile: vi.fn(),
  addProfile: vi.fn(),
  deleteProfile: vi.fn(),
  getPersona: vi.fn(),
  savePersona: vi.fn(),
  getMemoryState: vi.fn(),
  saveMemoryPrefs: vi.fn(),
}))

import { addProfile, deleteProfile, getMemoryState, getPersona, getProfile, saveMemoryPrefs, savePersona } from './api.js'
import { receiptsOn, setReceipts } from './memoryPrefs.js'
import MemoryPanel from './MemoryPanel.jsx'

describe('记忆面板：回执开关与昨晚新增', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setReceipts(true)
    getProfile.mockResolvedValue({ items: [{ id: 1, content: '领导喝咖啡只喝美式' }, { id: 4, content: '领导周五不排会' }] })
    getPersona.mockResolvedValue({ style: 'jarvis', address: '', flavor: '' })
    getMemoryState.mockResolvedValue({ receipts: true, fresh: { count: 0, ids: [] } })
    saveMemoryPrefs.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('「显示记忆回执」默认开，关掉即保存并同步给对话区', async () => {
    render(<MemoryPanel onClose={() => {}} />)
    const sw = await screen.findByRole('switch', { name: /显示记忆回执/ })
    expect(sw).toBeChecked()
    fireEvent.click(sw)
    await waitFor(() => expect(saveMemoryPrefs).toHaveBeenCalledWith(false))
    expect(sw).not.toBeChecked()
    expect(receiptsOn()).toBe(false)
  })

  it('保存失败回滚并说明', async () => {
    saveMemoryPrefs.mockRejectedValue(new Error('请求失败'))
    render(<MemoryPanel onClose={() => {}} />)
    const sw = await screen.findByRole('switch', { name: /显示记忆回执/ })
    fireEvent.click(sw)
    expect(await screen.findByRole('alert')).toHaveTextContent('没能保存')
    expect(sw).toBeChecked()
    expect(receiptsOn()).toBe(true)
  })

  it('打开时以服务端为准（别的设备关过）', async () => {
    getMemoryState.mockResolvedValue({ receipts: false, fresh: { count: 0, ids: [] } })
    render(<MemoryPanel onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('switch', { name: /显示记忆回执/ })).not.toBeChecked())
  })

  it('从「昨晚整理了 N 条 · 查看」进来：这批条目标「新」', async () => {
    render(<MemoryPanel onClose={() => {}} highlight={[4]} />)
    const fresh = (await screen.findByText('领导周五不排会')).closest('li')
    expect(fresh.className).toContain('fresh')
    expect(fresh.textContent).toContain('新')
    expect(screen.getByText('领导喝咖啡只喝美式').closest('li').className).not.toContain('fresh')
  })
})

describe('记忆面板', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProfile.mockResolvedValue({ items: [{ id: 1, content: '领导喝咖啡只喝美式' }] })
    addProfile.mockResolvedValue({ ok: true, id: 2 })
    deleteProfile.mockResolvedValue({ ok: true })
    getPersona.mockResolvedValue({ style: 'jarvis', address: '', flavor: '' })
    savePersona.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('列出画像条目并可「忘记」', async () => {
    render(<MemoryPanel onClose={() => {}} />)
    expect(await screen.findByText('领导喝咖啡只喝美式')).toBeTruthy()
    fireEvent.click(screen.getByTitle('忘记这条'))
    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith(1))
  })

  it('可手动补一条画像', async () => {
    render(<MemoryPanel onClose={() => {}} />)
    const input = await screen.findByPlaceholderText('＋ 手动补一条画像，回车确认')
    fireEvent.change(input, { target: { value: '领导周五不排会' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(addProfile).toHaveBeenCalledWith('领导周五不排会'))
  })

  it('空态给出「记住我…」的用法引导', async () => {
    getProfile.mockResolvedValue({ items: [] })
    render(<MemoryPanel onClose={() => {}} />)
    expect(await screen.findByText(/记住我喝咖啡只喝美式/)).toBeTruthy()
  })

  it('人设区可切 MOSS、改称呼并保存', async () => {
    getPersona.mockResolvedValue({ style: 'jarvis', address: '', flavor: '' })
    render(<MemoryPanel onClose={() => {}} />)
    const styleSel = await screen.findByLabelText('人格')
    fireEvent.change(styleSel, { target: { value: 'moss' } })
    fireEvent.change(screen.getByLabelText('称呼'), { target: { value: '陈总' } })
    fireEvent.change(screen.getByLabelText('语气'), { target: { value: '多点冷幽默' } })
    fireEvent.click(screen.getByText('保存人设'))
    await waitFor(() => expect(savePersona).toHaveBeenCalledWith('moss', '陈总', '多点冷幽默'))
    expect(await screen.findByText(/已保存/)).toBeTruthy()
  })
})
