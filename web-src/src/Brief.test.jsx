import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getBrief: vi.fn(), ensureBrief: vi.fn() }))

import { ensureBrief, getBrief } from './api.js'
import Brief from './Brief.jsx'

const READY = {
  status: 'ready', date: '2026-10-02', source: 'model', at: '08:12',
  headline: '今天 3 个日程，15:00 项目周会前还有 2 个待办没完成；外面 26°C 多云',
  details: ['先把季度汇报材料收个尾', '明早 09:30 体检，今晚早点睡'],
}

function memoryStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: k => { m.delete(k) } }
}
const settle = () => act(async () => {})

describe('今日简报卡', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', memoryStorage())
    getBrief.mockResolvedValue({ status: 'none', date: '2026-10-02' })
    ensureBrief.mockResolvedValue(READY)
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('当天还没生成：可见时自动 POST 一次，先骨架后一行', async () => {
    let release
    ensureBrief.mockImplementation(() => new Promise(r => { release = () => r(READY) }))
    const { container } = render(<Brief active />)
    await waitFor(() => expect(ensureBrief).toHaveBeenCalledTimes(1))
    expect(container.querySelector('.brief--loading')).toBeInTheDocument()   // 骨架，不转圈
    await act(async () => release())
    const head = screen.getByRole('button', { name: /今天 3 个日程/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.brief')).toHaveClass('is-ai')
    expect(screen.queryByText('先把季度汇报材料收个尾')).toBeNull()        // 默认只有一行
  })

  it('点开看细节与来源，再点收起', async () => {
    getBrief.mockResolvedValue(READY)
    render(<Brief active />)
    const head = await screen.findByRole('button', { name: /今天 3 个日程/ })
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('先把季度汇报材料收个尾')).toBeInTheDocument()
    expect(screen.getByText('AI 整理于 08:12')).toBeInTheDocument()
    fireEvent.click(head)
    expect(screen.queryByText('先把季度汇报材料收个尾')).toBeNull()
    expect(ensureBrief).not.toHaveBeenCalled()                          // 已有缓存不再 POST
  })

  it('今日板没打开（active=false）不生成、不渲染', async () => {
    const { container } = render(<Brief active={false} />)
    await settle()
    expect(getBrief).toHaveBeenCalled()
    expect(ensureBrief).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it('05:00 之前（early）不渲染也不生成', async () => {
    getBrief.mockResolvedValue({ status: 'early', date: '2026-10-02' })
    const { container } = render(<Brief active />)
    await settle()
    expect(ensureBrief).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it('规则摘要（模型不可用）照常显示，不标 AI', async () => {
    getBrief.mockResolvedValue({ ...READY, source: 'fallback', headline: '今天 3 个日程，下一项 15:00 项目周会；2 个待办未完成', details: [] })
    const { container } = render(<Brief active />)
    fireEvent.click(await screen.findByRole('button', { name: /下一项 15:00/ }))
    expect(container.querySelector('.brief')).not.toHaveClass('is-ai')
    expect(screen.getByText('按今天的日程与待办汇总')).toBeInTheDocument()
  })

  it('「今天不再显示」：同日重新挂载也不再出现', async () => {
    getBrief.mockResolvedValue(READY)
    render(<Brief active />)
    fireEvent.click(await screen.findByRole('button', { name: /今天 3 个日程/ }))
    fireEvent.click(screen.getByRole('button', { name: '今天不再显示' }))
    expect(screen.queryByText(/今天 3 个日程/)).toBeNull()
    expect(localStorage.getItem('jws_brief_hide')).toBe('2026-10-02')
    cleanup()
    const { container } = render(<Brief active />)
    await settle()
    expect(container).toBeEmptyDOMElement()
    cleanup()
    getBrief.mockResolvedValue({ ...READY, date: '2026-10-03' })        // 第二天照常
    render(<Brief active />)
    expect(await screen.findByRole('button', { name: /今天 3 个日程/ })).toBeInTheDocument()
  })

  it('当天隐藏了就连生成都省掉', async () => {
    localStorage.setItem('jws_brief_hide', '2026-10-02')
    render(<Brief active />)
    await settle()
    expect(ensureBrief).not.toHaveBeenCalled()
  })

  it('localStorage 抛异常（隐私模式）卡片照常显示、隐藏照常生效', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') },
    })
    getBrief.mockResolvedValue(READY)
    render(<Brief active />)
    fireEvent.click(await screen.findByRole('button', { name: /今天 3 个日程/ }))
    fireEvent.click(screen.getByRole('button', { name: '今天不再显示' }))
    expect(screen.queryByText(/今天 3 个日程/)).toBeNull()
  })

  it('读取失败静默不渲染；401 交给上层', async () => {
    const expired = vi.fn()
    getBrief.mockRejectedValue(new Error('401'))
    const { container } = render(<Brief active onExpired={expired} />)
    await settle()
    expect(expired).toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })
})
