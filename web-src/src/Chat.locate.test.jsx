import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getHistory: vi.fn(), chatStream: vi.fn() }))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { chatStream, getHistory } from './api.js'
import Chat from './Chat.jsx'

const HISTORY = {
  t1: [{ role: 'user', content: '今天天气' }, { role: 'assistant', content: '晴。' }],
  t9: [
    { role: 'user', content: '周末想吃日料' },
    { role: 'assistant', content: '推荐「鮨 心」，在静安寺附近。' },
    { role: 'user', content: '人均多少' },
    { role: 'assistant', content: '人均 400 左右。' },
  ],
}

describe('对话区：⌘K 翻旧账定位与吩咐注入', () => {
  let scrolled
  beforeEach(() => {
    vi.clearAllMocks()
    scrolled = []
    Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this) }
    getHistory.mockImplementation(id => Promise.resolve(HISTORY[id] || []))
  })
  afterEach(() => { cleanup(); delete Element.prototype.scrollIntoView })

  it('切到别的会话：历史回放后滚到命中那条并短暂描边（不会先在旧会话里乱跳）', async () => {
    const { rerender } = render(<Chat threadId="t1" />)
    await screen.findByText('晴。')
    rerender(<Chat threadId="t9" locate={{ seq: 1, threadId: 't9', pos: 1 }} />)
    const target = (await screen.findByText(/鮨 心/)).closest('.row-jarvis')
    await waitFor(() => expect(target).toHaveClass('msg-located'))
    expect(scrolled).toEqual([target])
  })

  it('就在当前会话里：直接定位；同一次跳转只定位一次', async () => {
    const { rerender } = render(<Chat threadId="t9" />)
    await screen.findByText('人均多少')
    rerender(<Chat threadId="t9" locate={{ seq: 2, threadId: 't9', pos: 2 }} />)
    const row = screen.getByText('人均多少').closest('.row-user')
    expect(row).toHaveClass('msg-located')
    rerender(<Chat threadId="t9" locate={{ seq: 2, threadId: 't9', pos: 2 }} userName="x" />)
    expect(scrolled).toHaveLength(1)
  })

  it('位置已过期（那条不在了）：停在会话里，不乱滚', async () => {
    render(<Chat threadId="t1" locate={{ seq: 3, threadId: 't1', pos: 9 }} />)
    await screen.findByText('晴。')
    expect(scrolled).toEqual([])
  })

  it('上一条还在答时注入吩咐：放进输入框，不丢也不抢着发', async () => {
    let finish
    chatStream.mockImplementation(async function* stream() {
      await new Promise(r => { finish = r })
      yield { type: 'token', text: '好。' }
    })
    const { rerender } = render(<Chat threadId="t1" injected={{ seq: 1, text: '第一件事' }} />)
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    rerender(<Chat threadId="t1" injected={{ seq: 2, text: '第二件事' }} />)
    expect(screen.getByLabelText('输入消息').value).toBe('第二件事')
    expect(chatStream).toHaveBeenCalledTimes(1)
    await act(async () => { finish() })
  })
})
