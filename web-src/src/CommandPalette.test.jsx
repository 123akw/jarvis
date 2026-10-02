import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from './CommandPalette.jsx'

const quickCmd = run => ({ id: 'quick', label: '速记…', hint: '待办或日程，写上时间就是日程', icon: 'plus', keywords: '速记 待办 日程', run })
const noSearch = () => new Promise(() => {})   // 默认：历史检索永不返回（只测吩咐组）

function setup(props = {}) {
  const handlers = { onAsk: vi.fn(), onAdd: vi.fn(), onPickThread: vi.fn(), onClose: vi.fn(), onExpired: vi.fn() }
  render(<CommandPalette commands={[]} threads={[]} searchHistory={noSearch} {...handlers} {...props} />)
  const input = screen.getByRole('combobox', { name: '搜索命令' })
  const type = value => fireEvent.change(input, { target: { value } })
  const key = k => fireEvent.keyDown(input, { key: k })
  const options = () => screen.getAllByRole('option')
  const selected = () => options().find(o => o.getAttribute('aria-selected') === 'true')
  return { ...handlers, ...props, input, type, key, options, selected }
}

describe('⌘K 直接吩咐', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 2, 10, 0))
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('没输入时列出「速记…」命令，点了照常执行', () => {
    const run = vi.fn()
    setup({ commands: [quickCmd(run)] })
    fireEvent.click(screen.getByText('速记…'))
    expect(run).toHaveBeenCalled()
  })

  it('没有匹配：第一项是「让贾维斯去办：…」，回车把这句话交给贾维斯', () => {
    const p = setup({ commands: [{ id: 'theme', label: '切换到亮色', icon: 'sun', run: vi.fn() }], threads: [{ id: 'a', title: '周报怎么写' }] })
    p.type('帮我查下明天深圳的天气')
    expect(p.options()[0]).toHaveTextContent('让贾维斯去办：帮我查下明天深圳的天气')
    expect(p.selected()).toBe(p.options()[0])
    expect(screen.getByText('吩咐')).toBeInTheDocument()
    p.key('Enter')
    expect(p.onClose).toHaveBeenCalled()
    expect(p.onAsk).toHaveBeenCalledWith('帮我查下明天深圳的天气')
    expect(p.onAdd).not.toHaveBeenCalled()
  })

  it('带时间的句子：第二项「加到日程」写明 24 小时制时间，↓ 回车直接写入（不走模型）', () => {
    const p = setup()
    p.type('明天下午3点 复盘')
    const add = p.options()[1]
    expect(add).toHaveTextContent('加到日程：复盘')
    expect(add).toHaveTextContent('明天 周六 15:00')
    p.key('ArrowDown')
    expect(p.selected()).toBe(add)
    p.key('Enter')
    expect(p.onAsk).not.toHaveBeenCalled()
    expect(p.onAdd).toHaveBeenCalledWith(expect.objectContaining({ kind: 'schedule', title: '复盘', when: '2026-10-03 15:00' }), '明天下午3点 复盘')
  })

  it('没有时间词：直达项是「加到待办」；只写了时间没写事：不给直达项', () => {
    const p = setup()
    p.type('买猫粮')
    expect(p.options().map(o => o.textContent)).toEqual(['让贾维斯去办：买猫粮', '加到待办：买猫粮'])
    p.type('明天下午3点')
    expect(p.options().map(o => o.textContent)).toEqual(['让贾维斯去办：明天下午3点'])
  })

  it('有会话匹配：会话在前、吩咐垫底，回车仍然打开会话（不误发）', () => {
    const p = setup({ threads: [{ id: 'a', title: '写周报' }] })
    p.type('周报')
    expect(p.options().map(o => o.textContent)).toEqual(['写周报', '让贾维斯去办：周报', '加到待办：周报'])
    p.key('Enter')
    expect(p.onPickThread).toHaveBeenCalledWith('a')
    expect(p.onAsk).not.toHaveBeenCalled()
    expect(p.onAdd).not.toHaveBeenCalled()
  })

  it('命中命令时不给「加到…」直达项，只在末尾留一条吩咐', () => {
    const p = setup({ commands: [quickCmd(vi.fn())] })
    p.type('速记')
    expect(p.options().map(o => o.textContent)).toEqual(['速记…待办或日程，写上时间就是日程', '让贾维斯去办：速记'])
  })

  it('↑↓ 循环选择，鼠标悬停也能换选中项', () => {
    const p = setup()
    p.type('买猫粮')
    p.key('ArrowUp')
    expect(p.selected()).toHaveTextContent('加到待办')
    p.key('ArrowDown')
    expect(p.selected()).toHaveTextContent('让贾维斯去办')
    fireEvent.mouseMove(p.options()[1])
    expect(p.selected()).toHaveTextContent('加到待办')
  })
})

describe('⌘K 翻旧账', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date(2026, 9, 2, 10, 0))
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  const hit = (over = {}) => ({
    thread_id: 't1', title: '周末去哪吃', role: 'assistant', pos: 1, at: '2026-09-21T12:00:00+00:00',
    snippet: '推荐「鮨 心」，日料店在静安寺附近', marks: [[8, 10]], ...over,
  })
  const settle = async () => { await act(async () => { vi.advanceTimersByTime(200) }) }

  it('停手后才查一次，过期请求被取消；命中片段高亮，回车跳到那个会话并带上位置', async () => {
    const search = vi.fn((q, _limit, signal) => (q === '日料'
      ? Promise.resolve({ items: [hit()] })
      : new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))))
    const p = setup({ searchHistory: search })
    p.type('日')
    await settle()
    expect(search).not.toHaveBeenCalled()             // 一个字不查
    p.type('日料店')
    await act(async () => { vi.advanceTimersByTime(100) })
    p.type('日料')
    await settle()
    expect(search).toHaveBeenCalledTimes(1)           // 防抖：中间那次没发出去
    expect(search).toHaveBeenCalledWith('日料', 6, expect.any(AbortSignal))

    expect(screen.getByText('历史对话')).toBeInTheDocument()
    const option = screen.getByRole('option', { name: /鮨 心/ })
    expect(option.querySelector('mark')).toHaveTextContent('日料')
    expect(option).toHaveTextContent('周末去哪吃 · 9月21日 · 贾维斯说')
    // 没有命令/会话匹配：吩咐仍是第一项，历史结果挂在下面，不抢回车
    expect(p.options()[0]).toHaveTextContent('让贾维斯去办：日料')
    fireEvent.click(option)
    expect(p.onPickThread).toHaveBeenCalledWith('t1', { pos: 1, q: '日料' })
  })

  it('输入一变就中止上一个请求，旧结果不会盖住新结果', async () => {
    const signals = []
    const resolvers = []
    const search = vi.fn((q, _limit, signal) => {
      signals.push(signal)
      return new Promise(resolve => resolvers.push(() => resolve({ items: [hit({ snippet: `结果：${q}`, marks: [] })] })))
    })
    const p = setup({ searchHistory: search })
    p.type('静安')
    await settle()
    p.type('静安寺')
    expect(signals[0].aborted).toBe(true)
    await settle()
    await act(async () => { resolvers[0](); resolvers[1]() })
    expect(screen.queryByText('结果：静安')).toBeNull()
    expect(screen.getByText('结果：静安寺')).toBeInTheDocument()
  })

  it('结果异步到达时，选中项不跳（按 key 记住）', async () => {
    let resolve
    const search = vi.fn(() => new Promise(r => { resolve = r }))
    const p = setup({ searchHistory: search, threads: [{ id: 'a', title: '日料清单' }] })
    p.type('日料')
    p.key('ArrowDown')
    p.key('ArrowDown')
    expect(p.selected()).toHaveTextContent('加到待办：日料')
    await settle()
    await act(async () => { resolve({ items: [hit()] }) })
    // 历史结果插在会话与吩咐之间，选中的仍是「加到待办」
    expect(p.options().map(o => o.textContent.slice(0, 6))).toEqual(['日料清单', '推荐「鮨 心', '让贾维斯去办', '加到待办：日'])
    expect(p.selected()).toHaveTextContent('加到待办：日料')
  })

  it('检索失败静默；登录过期交给 onExpired', async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error('请求失败')).mockRejectedValueOnce(new Error('401'))
    const p = setup({ searchHistory: search })
    p.type('静安寺')
    await settle()
    expect(p.onExpired).not.toHaveBeenCalled()
    expect(p.options().map(o => o.textContent)).toEqual(['让贾维斯去办：静安寺', '加到待办：静安寺'])
    p.type('静安寺附近')
    await settle()
    expect(p.onExpired).toHaveBeenCalled()
  })
})
