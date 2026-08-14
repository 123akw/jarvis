import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getHistory: vi.fn(), chatStream: vi.fn() }))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { chatStream, getHistory } from './api.js'
import Chat from './Chat.jsx'

async function* streamOk() {
  yield { type: 'token', text: '好的。' }
}
async function* streamBoom() {
  yield { type: 'token', text: '' }
  throw new Error('boom')
}

describe('消息级操作', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(cleanup)

  it('用户消息可编辑重发：点「编辑」把原文填回输入框', async () => {
    getHistory.mockResolvedValue([
      { role: 'user', content: '明天天气怎么样' },
      { role: 'assistant', content: '晴。' },
    ])
    render(<Chat threadId="t1" />)
    const edit = await screen.findByTitle('编辑后重新发送')
    fireEvent.click(edit)
    expect(screen.getByPlaceholderText(/吩咐一句/).value).toBe('明天天气怎么样')
  })

  it('AI 消息可「重新回答」：以同一条提问再次发起流式请求', async () => {
    getHistory.mockResolvedValue([
      { role: 'user', content: '讲个笑话' },
      { role: 'assistant', content: '第一版笑话' },
    ])
    chatStream.mockImplementation(() => streamOk())
    render(<Chat threadId="t1" />)
    const regen = await screen.findByTitle('就同一个问题再答一次')
    fireEvent.click(regen)
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    expect(chatStream.mock.calls[0][0]).toBe('讲个笑话')
  })

  it('链路失败出现「重试」按钮，点击后按原文重发', async () => {
    getHistory.mockResolvedValue([])
    chatStream.mockImplementationOnce(() => streamBoom()).mockImplementation(() => streamOk())
    render(<Chat threadId="t1" />)
    const box = await screen.findByPlaceholderText(/吩咐一句/)
    fireEvent.change(box, { target: { value: '现在几点' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    const retry = await screen.findByText('重试')
    fireEvent.click(retry)
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(2))
    expect(chatStream.mock.calls[1][0]).toBe('现在几点')
  })

  it('用户消息也有「复制」按钮', async () => {
    getHistory.mockResolvedValue([{ role: 'user', content: '记一条备忘' }])
    render(<Chat threadId="t1" />)
    expect(await screen.findByTitle('复制这条消息')).toBeTruthy()
  })
})
