import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getHistory: vi.fn(), chatStream: vi.fn(), uploadDocument: vi.fn() }))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { chatStream, getHistory } from './api.js'
import Chat from './Chat.jsx'
import { AWAY_PX, SETTLE_MS, useFollowScroll } from './followScroll.js'

/** jsdom 没有布局：给滚动容器装上可控的 scrollHeight / clientHeight / scrollTop（写入按浏览器规则夹紧） */
function fakeScroller(el, box) {
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.client })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: v => { top = Math.max(0, Math.min(v, box.height - box.client)) },
  })
}

const box = { height: 2000, client: 800 }
const max = () => box.height - box.client

function Harness({ tick }) {
  const ref = useRef(null)
  const f = useFollowScroll(ref)
  useLayoutEffect(f.onContent, [tick])
  return (
    <>
      <div data-testid="log" ref={el => { if (el && !el.dataset.fake) { el.dataset.fake = '1'; fakeScroller(el, box) } ref.current = el }} {...f.handlers} />
      {f.away ? <button type="button" onClick={f.jump}>回到底部</button> : null}
    </>
  )
}

/** 内容长高 dh（模拟流式来了一段 token） */
function grow(rerender, tick, dh = 40) {
  box.height += dh
  rerender(<Harness tick={tick} />)
}

/** 用户自己滚到某处：浏览器先改 scrollTop 再派发 scroll */
function userScroll(log, top) {
  log.scrollTop = top
  fireEvent.scroll(log)
}

describe('贴底跟随 useFollowScroll', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    box.height = 2000
    box.client = 800
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('贴底时内容长高，视口跟到最底', () => {
    const { rerender } = render(<Harness tick={0} />)
    const log = screen.getByTestId('log')
    expect(log.scrollTop).toBe(max())
    grow(rerender, 1)
    expect(log.scrollTop).toBe(max())
  })

  it('手指往下拖（往上翻）立刻松手：哪怕离底不到 80px，新内容也不再把人拽回底部', () => {
    const { rerender } = render(<Harness tick={0} />)
    const log = screen.getByTestId('log')
    fireEvent.touchStart(log, { touches: [{ clientX: 200, clientY: 400 }] })
    fireEvent.touchMove(log, { touches: [{ clientX: 201, clientY: 410 }] })
    userScroll(log, max() - 10)
    const held = log.scrollTop
    for (let i = 2; i < 12; i++) grow(rerender, i)
    expect(log.scrollTop).toBe(held)
    fireEvent.touchEnd(log, { touches: [] })
    act(() => { vi.advanceTimersByTime(SETTLE_MS * 3) })
    grow(rerender, 20)
    expect(log.scrollTop).toBe(held)   // 松手、惯性停了也不回去
  })

  it('手指按在屏上没动时不写 scrollTop；松手、惯性停稳后再补一次贴底', () => {
    const { rerender } = render(<Harness tick={0} />)
    const log = screen.getByTestId('log')
    const before = log.scrollTop
    fireEvent.touchStart(log, { touches: [{ clientX: 200, clientY: 400 }] })
    grow(rerender, 1, 120)
    expect(log.scrollTop).toBe(before)
    fireEvent.touchEnd(log, { touches: [] })
    grow(rerender, 2, 40)
    expect(log.scrollTop).toBe(before)   // 惯性期（SETTLE_MS 内）仍不动
    act(() => { vi.advanceTimersByTime(SETTLE_MS + 20) })
    expect(log.scrollTop).toBe(max())
  })

  it('横向滑代码块/表格（竖向位移不占主导）不算往上翻', () => {
    const { rerender } = render(<Harness tick={0} />)
    const log = screen.getByTestId('log')
    fireEvent.touchStart(log, { touches: [{ clientX: 200, clientY: 400 }] })
    fireEvent.touchMove(log, { touches: [{ clientX: 120, clientY: 407 }] })
    fireEvent.touchEnd(log, { touches: [] })
    act(() => { vi.advanceTimersByTime(SETTLE_MS + 20) })
    grow(rerender, 1)
    expect(log.scrollTop).toBe(max())
  })

  it('滚轮往上立刻松手；用户自己滚回底部后恢复跟随', () => {
    const { rerender } = render(<Harness tick={0} />)
    const log = screen.getByTestId('log')
    fireEvent.wheel(log, { deltaY: -30 })
    userScroll(log, max() - 30)
    grow(rerender, 1)
    expect(log.scrollTop).toBe(max() - 70)
    fireEvent.wheel(log, { deltaY: 100 })
    userScroll(log, max())
    act(() => { vi.advanceTimersByTime(SETTLE_MS + 20) })
    grow(rerender, 2)
    expect(log.scrollTop).toBe(max())
  })

  it('内容变矮时浏览器夹紧 scrollTop 引起的 scroll 不算用户上翻', () => {
    const { rerender } = render(<Harness tick={0} />)
    const log = screen.getByTestId('log')
    box.height -= 60          // 流式视图换成定稿渲染，略矮一点
    log.scrollTop = log.scrollTop   // 浏览器夹紧
    fireEvent.scroll(log)
    grow(rerender, 1, 100)    // 随后记忆回执出现
    expect(log.scrollTop).toBe(max())
  })

  it('不跟随且离底较远时出现「回到底部」，点一下贴底并恢复跟随', () => {
    const { rerender } = render(<Harness tick={0} />)
    const log = screen.getByTestId('log')
    expect(screen.queryByRole('button', { name: '回到底部' })).toBeNull()
    fireEvent.wheel(log, { deltaY: -400 })
    userScroll(log, max() - AWAY_PX - 100)
    const btn = screen.getByRole('button', { name: '回到底部' })
    fireEvent.click(btn)
    expect(log.scrollTop).toBe(max())
    expect(screen.queryByRole('button', { name: '回到底部' })).toBeNull()
    grow(rerender, 1)
    expect(log.scrollTop).toBe(max())
  })
})

describe('对话区接入', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getHistory.mockResolvedValue([])
    box.height = 2000
    box.client = 800
  })
  afterEach(cleanup)

  it('超长的用户消息折叠显示、可展开，不再做成会吃掉滑动手势的内部滚动框', async () => {
    const long = '很长的一段文档内容。'.repeat(80)
    getHistory.mockResolvedValue([{ role: 'user', content: long }, { role: 'assistant', content: '收到。' }, { role: 'user', content: '短消息' }])
    const { container } = render(<Chat threadId="t1" />)
    await screen.findByText('短消息')
    const [big, small] = container.querySelectorAll('.ubox')
    expect(big).toHaveClass('clamped')
    expect(small).not.toHaveClass('clamped')
    const more = screen.getByRole('button', { name: '展开全文' })
    fireEvent.click(more)
    expect(big).not.toHaveClass('clamped')
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('流式回答进行中往上翻，后续 token 不会把视口拽回底部', async () => {
    let push
    async function* stream() {
      while (true) {
        const t = await new Promise(r => { push = r })
        if (t === null) return
        yield { type: 'token', text: t }
      }
    }
    chatStream.mockImplementation(stream)
    const { container } = render(<Chat threadId="t1" />)
    const log = container.querySelector('.log')
    fakeScroller(log, box)
    const boxEl = await screen.findByPlaceholderText(/吩咐一句/)
    fireEvent.change(boxEl, { target: { value: '说说今天' } })
    fireEvent.keyDown(boxEl, { key: 'Enter' })
    await waitFor(() => expect(push).toBeTypeOf('function'))
    await act(async () => { box.height += 50; push('第一段。') })
    await waitFor(() => expect(log.scrollTop).toBe(max()))
    // 用户手指往下拖 12px（离底远小于旧阈值 80px）
    fireEvent.touchStart(log, { touches: [{ clientX: 200, clientY: 400 }] })
    fireEvent.touchMove(log, { touches: [{ clientX: 200, clientY: 412 }] })
    log.scrollTop = max() - 12
    fireEvent.scroll(log)
    fireEvent.touchEnd(log, { touches: [] })
    const held = log.scrollTop
    for (const t of ['第二段。', '第三段。', '第四段。']) {
      await act(async () => { box.height += 60; push(t) })
    }
    await new Promise(r => setTimeout(r, SETTLE_MS + 40))
    expect(log.scrollTop).toBe(held)
    await act(async () => { push(null) })
  })
})
