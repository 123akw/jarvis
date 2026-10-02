import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getHistory: vi.fn(), chatStream: vi.fn() }))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { chatStream, getHistory } from './api.js'
import Chat from './Chat.jsx'

async function* streamOk() {
  yield { type: 'token', text: '好的。' }
}
async function* streamPieces() {
  for (const t of ['第一段', '。\n\n**加', '粗**收', '尾']) yield { type: 'token', text: t }
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

  it('「编辑」后组件立即卸载，延后的行高回调不抛错', async () => {
    let rafCb = null
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { rafCb = cb; return 1 })
    getHistory.mockResolvedValue([
      { role: 'user', content: '明天天气怎么样' },
      { role: 'assistant', content: '晴。' },
    ])
    render(<Chat threadId="t1" />)
    fireEvent.click(await screen.findByTitle('编辑后重新发送'))
    cleanup()
    expect(rafCb).toBeTypeOf('function')
    expect(() => rafCb()).not.toThrow()
    rafSpy.mockRestore()
  })

  it('用户消息也有「复制」按钮', async () => {
    getHistory.mockResolvedValue([{ role: 'user', content: '记一条备忘' }])
    render(<Chat threadId="t1" />)
    expect(await screen.findByTitle('复制这条消息')).toBeTruthy()
  })

  it('逐 token 到达的回答按帧合并后完整渲染为 Markdown（跨 token 的粗体不丢）', async () => {
    getHistory.mockResolvedValue([])
    chatStream.mockImplementation(() => streamPieces())
    const { container } = render(<Chat threadId="t1" />)
    const box = await screen.findByPlaceholderText(/吩咐一句/)
    fireEvent.change(box, { target: { value: '写两段' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(container.querySelector('.jbody strong')?.textContent).toBe('加粗'))
    await waitFor(() => expect(container.querySelector('.jbody .caret')).toBeNull())
    expect(container.querySelector('.jbody').textContent.trim()).toBe('第一段。\n加粗收尾')
  })
})

describe('新对话空态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getHistory.mockResolvedValue([])
    chatStream.mockImplementation(() => streamOk())
  })
  afterEach(cleanup)

  it('有 AI 动效挂载点、带称呼的问候和 4 条建议', async () => {
    const { container } = render(<Chat threadId="t-new" userName="陈总" />)
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toMatch(/，陈总$/)
    expect(container.querySelector('.chat-empty .jv-presence-slot')).not.toBeNull()
    const chips = container.querySelectorAll('.ce-chip')
    expect([...chips].map(c => c.querySelector('.ce-q').textContent))
      .toEqual(['给我今日晨报', '我在做什么任务？', '今天天气怎么样？', '记一条备忘：'])
  })

  it('以「：」结尾的建议只预填输入框，其余直接发出', async () => {
    render(<Chat threadId="t-new" />)
    fireEvent.click(await screen.findByRole('button', { name: /记一条备忘：/ }))
    expect(screen.getByPlaceholderText(/吩咐一句/).value).toBe('记一条备忘：')
    expect(chatStream).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /给我今日晨报/ }))
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    expect(chatStream.mock.calls[0][0]).toBe('给我今日晨报')
  })

  it('有消息后空态消失', async () => {
    getHistory.mockResolvedValue([{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在。' }])
    const { container } = render(<Chat threadId="t-old" />)
    await screen.findByText('在吗')
    expect(container.querySelector('.chat-empty')).toBeNull()
  })
})
