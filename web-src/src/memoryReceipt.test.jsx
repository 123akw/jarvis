import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getHistory: vi.fn(), chatStream: vi.fn(), uploadDocument: vi.fn(), addProfile: vi.fn(), deleteProfile: vi.fn(),
}))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { addProfile, chatStream, deleteProfile, getHistory } from './api.js'
import Chat from './Chat.jsx'
import { setReceipts } from './memoryPrefs.js'

function streamOf(...events) {
  return async function* gen() { for (const e of events) yield e }
}
const REMEMBER = [
  { type: 'tool_start', name: 'profile_remember', id: 'c1' },
  { type: 'tool_result', name: 'profile_remember', id: 'c1', ok: true, ms: 12,
    detail: '记住了（编号 7）：主人不喜欢跑步', memory: { action: 'remember', id: 7, content: '主人不喜欢跑步' } },
  { type: 'token', text: '好的，记住了，以后不给您安排跑步。' },
]

async function ask(text) {
  const box = await screen.findByPlaceholderText(/吩咐一句/)
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

describe('记忆回执', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setReceipts(true)
    getHistory.mockResolvedValue([])
    deleteProfile.mockResolvedValue({ ok: true })
    addProfile.mockResolvedValue({ ok: true, id: 9 })
  })
  afterEach(cleanup)

  it('「记住」后回答下方出现回执，撤销调 deleteProfile(7)', async () => {
    chatStream.mockImplementation(streamOf(...REMEMBER))
    render(<Chat threadId="t1" />)
    await ask('记住我不喜欢跑步')
    const receipt = await screen.findByText('主人不喜欢跑步')
    expect(receipt.closest('.mem-receipt')).toHaveTextContent('已记住：主人不喜欢跑步')
    expect(receipt.closest('.row-jarvis').querySelector('.jbody').compareDocumentPosition(receipt)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()                       // 在回答正文下方
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }))
    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith(7))
    expect(await screen.findByText(/已撤销：/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /撤销/ })).toBeNull()
  })

  it('「忘记」的回执撤销 = 按原文补回', async () => {
    chatStream.mockImplementation(streamOf(
      { type: 'tool_start', name: 'profile_forget', id: 'c2' },
      { type: 'tool_result', name: 'profile_forget', id: 'c2', ok: true, ms: 9, detail: '已忘记编号 3 的画像。',
        memory: { action: 'forget', id: 3, content: '主人住在杭州' } },
      { type: 'token', text: '已经忘了。' },
    ))
    render(<Chat threadId="t1" />)
    await ask('别记着我住杭州了')
    expect(await screen.findByText(/已忘记：/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }))
    await waitFor(() => expect(addProfile).toHaveBeenCalledWith('主人住在杭州'))
    expect(await screen.findByText(/已恢复：/)).toBeInTheDocument()
  })

  it('重复记忆（服务端不带 memory 字段）不出回执', async () => {
    chatStream.mockImplementation(streamOf(
      { type: 'tool_start', name: 'profile_remember', id: 'c1' },
      { type: 'tool_result', name: 'profile_remember', id: 'c1', ok: true, ms: 5, detail: '这条我已经记着了（编号 7）：主人不喜欢跑步' },
      { type: 'token', text: '这个我早就记着了。' },
    ))
    render(<Chat threadId="t1" />)
    await ask('记住我不喜欢跑步')
    await screen.findByText('这个我早就记着了。')
    expect(document.querySelector('.mem-receipt')).toBeNull()
  })

  it('撤销失败给出重试；已被删过（404）也算撤销成功', async () => {
    deleteProfile.mockRejectedValueOnce(Object.assign(new Error('网络错误'), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('未找到画像'), { status: 404 }))
    chatStream.mockImplementation(streamOf(...REMEMBER))
    render(<Chat threadId="t1" />)
    await ask('记住我不喜欢跑步')
    fireEvent.click(await screen.findByRole('button', { name: /撤销/ }))
    expect(await screen.findByText('没撤成，重试')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }))
    expect(await screen.findByText(/已撤销：/)).toBeInTheDocument()
  })

  it('「显示记忆回执」关掉时整行不渲染，打开即恢复', async () => {
    setReceipts(false)
    chatStream.mockImplementation(streamOf(...REMEMBER))
    render(<Chat threadId="t1" />)
    await ask('记住我不喜欢跑步')
    await screen.findByText('好的，记住了，以后不给您安排跑步。')
    expect(document.querySelector('.mem-receipt')).toBeNull()
    act(() => setReceipts(true))
    expect(await screen.findByText(/已记住：/)).toBeInTheDocument()
  })
})
