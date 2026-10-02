import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getDashboard: vi.fn(), getMeetings: vi.fn(), getMeeting: vi.fn(), emailMeeting: vi.fn(),
  importMeetingTodos: vi.fn(), renameMeetingSpeaker: vi.fn(),
  addTodo: vi.fn(), patchTodo: vi.fn(), deleteTodo: vi.fn(), addMemo: vi.fn(), deleteMemo: vi.fn(),
  addSchedule: vi.fn(), deleteSchedule: vi.fn(),
  getBrief: vi.fn(), ensureBrief: vi.fn(), getMemoryState: vi.fn(), dismissFreshMemory: vi.fn(),
}))

import {
  addSchedule, addTodo, deleteSchedule, deleteTodo, dismissFreshMemory, ensureBrief, getBrief, getDashboard,
  getMeetings, getMemoryState,
} from './api.js'
import Panels from './Panels.jsx'

const DASH = {
  time: '2026-10-02 10:00:00',
  schedule: [{ id: 1, title: '项目周会', when: '2026-10-02 15:00' }],
  todos: [{ id: 7, content: '整理会议材料', done: false }],
  memos: [],
}
const PLACEHOLDER = '＋ 待办或日程，写上时间就是日程'

async function typeInto(text) {
  const input = await screen.findByPlaceholderText(PLACEHOLDER)
  fireEvent.change(input, { target: { value: text } })
  return input
}

describe('一句话速记（今日板待办输入框）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 2, 10, 0))   // 周五 10:00
    vi.clearAllMocks()
    getDashboard.mockResolvedValue(DASH)
    getMeetings.mockResolvedValue({ items: [], active: false })
    getBrief.mockResolvedValue({ status: 'early', date: '2026-10-02' })
    getMemoryState.mockResolvedValue({ receipts: true, fresh: { count: 0, ids: [] } })
    addSchedule.mockResolvedValue({ ok: true, id: 41 })
    addTodo.mockResolvedValue({ ok: true, id: 8 })
    deleteSchedule.mockResolvedValue({ ok: true })
    deleteTodo.mockResolvedValue({ ok: true })
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('带时间的句子：实时预览 → 回车走 addSchedule → 可撤销的 toast', async () => {
    render(<Panels refreshKey={0} />)
    const input = await typeInto('明天下午3点 复盘')
    const preview = document.querySelector('.qa-preview')
    expect(preview).toHaveTextContent('将创建日程')
    expect(preview).toHaveTextContent('明天 周六 15:00')
    expect(preview).toHaveTextContent('复盘')
    expect(addSchedule).not.toHaveBeenCalled()             // 预览零网络
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(addSchedule).toHaveBeenCalledWith('复盘', '2026-10-03 15:00'))
    expect(addTodo).not.toHaveBeenCalled()
    expect(input.value).toBe('')
    const toast = await screen.findByText('已添加日程：明天 15:00 复盘')
    fireEvent.click(within(toast.closest('.jv-toast')).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(deleteSchedule).toHaveBeenCalledWith(41))
    expect(await screen.findByText('已撤销')).toBeInTheDocument()
  })

  it('普通文本照旧走 addTodo，没有预览；toast 撤销调 deleteTodo', async () => {
    render(<Panels refreshKey={0} />)
    const input = await typeInto('买咖啡豆')
    expect(document.querySelector('.qa-preview')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(addTodo).toHaveBeenCalledWith('买咖啡豆'))
    expect(addSchedule).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    await waitFor(() => expect(deleteTodo).toHaveBeenCalledWith(8))
  })

  it('Esc 推翻解析按待办处理，且不冒泡关掉「今日」浮层', async () => {
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    render(<Panels refreshKey={0} />)
    const input = await typeInto('周五 6点 聚餐')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(outer).not.toHaveBeenCalled()
    expect(document.querySelector('.qa-preview')).toHaveTextContent('按待办添加')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(addTodo).toHaveBeenCalledWith('周五 6点 聚餐'))
    expect(addSchedule).not.toHaveBeenCalled()
    window.removeEventListener('keydown', outer)
  })

  it('「改成待办」按钮与 Esc 等价，可再「改回日程」', async () => {
    render(<Panels refreshKey={0} />)
    await typeInto('3点开会')
    expect(document.querySelector('.qa-preview')).toHaveTextContent('按下午理解')
    fireEvent.click(screen.getByRole('button', { name: '改成待办' }))
    fireEvent.click(screen.getByRole('button', { name: '改回日程' }))
    expect(document.querySelector('.qa-preview')).toHaveTextContent('今天 周五 15:00')
  })

  it('服务端 422：错误原文显示在输入框下，草稿保留', async () => {
    addSchedule.mockRejectedValue(Object.assign(new Error('时间需要 YYYY-MM-DD HH:MM 格式'), { status: 422 }))
    render(<Panels refreshKey={0} />)
    const input = await typeInto('后天 14:00 牙医')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('时间需要 YYYY-MM-DD HH:MM 格式')
    expect(input.value).toBe('后天 14:00 牙医')
  })

  it('只有时间没写事：不提交，提示还差要做的事', async () => {
    render(<Panels refreshKey={0} />)
    const input = await typeInto('明天下午3点')
    expect(document.querySelector('.qa-preview')).toHaveTextContent('还差要做的事')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('还差要做的事')
    expect(addSchedule).not.toHaveBeenCalled()
    expect(addTodo).not.toHaveBeenCalled()
  })

  it('已经过去的时间标出来', async () => {
    render(<Panels refreshKey={0} />)
    await typeInto('今天 9点 晨跑')
    expect(document.querySelector('.qa-preview')).toHaveClass('is-past')
    expect(document.querySelector('.qa-preview')).toHaveTextContent('这个时间已经过了')
  })

  it('⌘K 带来的草稿（quickSeed）填进输入框并聚焦', async () => {
    vi.useRealTimers()
    const { rerender } = render(<Panels refreshKey={0} />)
    const input = await screen.findByPlaceholderText(PLACEHOLDER)
    rerender(<Panels refreshKey={0} quickSeed={{ seq: 1, text: '明天 交周报' }} />)
    expect(input.value).toBe('明天 交周报')
    await waitFor(() => expect(document.activeElement).toBe(input))
  })
})

describe('今日板：昨晚整理的记忆、简报卡挂载', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDashboard.mockResolvedValue(DASH)
    getMeetings.mockResolvedValue({ items: [], active: false })
    getBrief.mockResolvedValue({ status: 'none', date: '2026-10-02' })
    ensureBrief.mockResolvedValue({ status: 'ready', date: '2026-10-02', source: 'model', headline: '今天 1 个日程', details: [], at: '08:30' })
    getMemoryState.mockResolvedValue({ receipts: true, fresh: { count: 3, ids: [4, 5, 6], at: '03:02', date: '2026-10-02' } })
    dismissFreshMemory.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('「昨晚为你整理了 3 条记忆 · 查看」：打开记忆面板并标为已读', async () => {
    const opened = vi.fn()
    render(<Panels refreshKey={0} onOpenMemory={opened} />)
    expect(await screen.findByText('昨晚为你整理了 3 条记忆')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(opened).toHaveBeenCalledWith([4, 5, 6])
    await waitFor(() => expect(dismissFreshMemory).toHaveBeenCalled())
    expect(screen.queryByText(/条记忆/)).toBeNull()
  })

  it('× 关掉提示；N 为 0 时整行不存在', async () => {
    render(<Panels refreshKey={0} />)
    fireEvent.click(await screen.findByRole('button', { name: '不再提示' }))
    await waitFor(() => expect(dismissFreshMemory).toHaveBeenCalled())
    cleanup()
    getMemoryState.mockResolvedValue({ receipts: true, fresh: { count: 0, ids: [] } })
    render(<Panels refreshKey={0} />)
    await screen.findByLabelText('完成：整理会议材料')
    await act(async () => {})
    expect(document.querySelector('.mem-notice')).toBeNull()
  })

  it('简报只在今日板可见时生成：active=false 不 POST，变为可见才 POST 一次', async () => {
    const { rerender } = render(<Panels refreshKey={0} active={false} />)
    await screen.findByLabelText('完成：整理会议材料')
    await act(async () => {})
    expect(getBrief).toHaveBeenCalled()
    expect(ensureBrief).not.toHaveBeenCalled()
    rerender(<Panels refreshKey={0} active />)
    expect(await screen.findByText('今天 1 个日程')).toBeInTheDocument()
    expect(ensureBrief).toHaveBeenCalledTimes(1)
    // 简报卡在日程区之上
    const brief = document.querySelector('.brief')
    const sched = screen.getByRole('region', { name: '日程' })
    expect(brief.compareDocumentPosition(sched) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
