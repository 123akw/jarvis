import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getHistory: vi.fn(), chatStream: vi.fn(), uploadDocument: vi.fn() }))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { chatStream, getHistory } from './api.js'
import Chat from './Chat.jsx'

/** 可手动放行的流：先挂起，调用 release() 后吐出 token */
function gatedStream(tokens = ['好的。']) {
  let release
  const gate = new Promise(r => { release = r })
  async function* gen(_text, _loc, _tid, signal) {
    await gate
    for (const t of tokens) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      yield { type: 'token', text: t }
    }
  }
  return { gen, release: () => release() }
}

function send(text) {
  const box = screen.getByPlaceholderText(/吩咐一句/)
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

describe('对话体验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getHistory.mockResolvedValue([])
  })
  afterEach(cleanup)

  it('等首个 token 时，回答位置显示「思考中」小光球；首个 token 到达后消失', async () => {
    const s = gatedStream(['第一句'])
    chatStream.mockImplementation(s.gen)
    const { container } = render(<Chat threadId="t1" />)
    await screen.findByPlaceholderText(/吩咐一句/)
    send('你好')
    const thinking = await screen.findByText('思考中…')
    const row = thinking.closest('.row-jarvis')
    expect(row.querySelector('.jv-thinking .jv-presence')).not.toBeNull()
    expect(row.querySelector('.jv-presence')).toHaveAttribute('aria-hidden', 'true')
    await act(async () => { s.release() })
    await waitFor(() => expect(container.querySelector('.jv-thinking')).toBeNull())
    expect(container.querySelector('.row-jarvis .jbody')).toHaveTextContent('第一句')
  })

  it('只有工具调用、还没正文时也不再显示思考占位（chip 已经在表达进度）', async () => {
    async function* toolsOnly() {
      yield { type: 'tool_start', name: 'now', id: 'c1' }
      await new Promise(() => {})
    }
    chatStream.mockImplementation(toolsOnly)
    const { container } = render(<Chat threadId="t1" />)
    await screen.findByPlaceholderText(/吩咐一句/)
    send('几点了')
    await waitFor(() => expect(container.querySelector('.tchip')).not.toBeNull())
    expect(container.querySelector('.jv-thinking')).toBeNull()
  })

  it('回答结束时不抢焦点：用户已在别处输入（如弹窗里填口令）就不把光标拽回输入框', async () => {
    const s = gatedStream(['好'])
    chatStream.mockImplementation(s.gen)
    render(<><Chat threadId="t1" /><input aria-label="弹窗里的口令" /></>)
    await screen.findByPlaceholderText(/吩咐一句/)
    send('你好')
    const other = screen.getByLabelText('弹窗里的口令')
    other.focus()
    await act(async () => { s.release() })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument())
    expect(document.activeElement).toBe(other)
  })

  it('停止生成后，回答末尾标明「已停止」', async () => {
    const s = gatedStream(['半句话'])
    chatStream.mockImplementation(s.gen)
    const { container } = render(<Chat threadId="t1" />)
    await screen.findByPlaceholderText(/吩咐一句/)
    send('讲个长故事')
    fireEvent.click(await screen.findByRole('button', { name: '停止生成' }))
    await act(async () => { s.release() })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument())
    expect(container.querySelector('.row-jarvis .msg-stopped')).toHaveTextContent('已停止')
  })

  it('复制回答后按钮短暂显示「已复制」', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    getHistory.mockResolvedValue([{ role: 'user', content: '问' }, { role: 'assistant', content: '答案原文' }])
    render(<Chat threadId="t1" />)
    const btn = await screen.findByTitle('复制回答原文')
    await act(async () => { fireEvent.click(btn) })
    expect(writeText).toHaveBeenCalledWith('答案原文')
    expect(btn).toHaveTextContent('已复制')
  })

  it('网络中断时用人话说明（不再显示「链路中断：Failed to fetch」）并可重试', async () => {
    // eslint-disable-next-line require-yield
    async function* offline() { throw new TypeError('Failed to fetch') }
    chatStream.mockImplementation(offline)
    render(<Chat threadId="t1" />)
    await screen.findByPlaceholderText(/吩咐一句/)
    send('在吗')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('网络中断')
    expect(alert).not.toHaveTextContent('Failed to fetch')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('本地新建的会话（fresh）不去拉历史：避免每次「新对话」都打一个 404', async () => {
    render(<Chat threadId="t-new" fresh />)
    await screen.findByPlaceholderText(/吩咐一句/)
    expect(getHistory).not.toHaveBeenCalled()
  })
})
