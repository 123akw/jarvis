import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getProfile: vi.fn(),
  addProfile: vi.fn(),
  deleteProfile: vi.fn(),
  getPersona: vi.fn(),
  savePersona: vi.fn(),
}))

import { addProfile, deleteProfile, getPersona, getProfile, savePersona } from './api.js'
import MemoryPanel from './MemoryPanel.jsx'

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
