import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getDashboard: vi.fn(), getMeetings: vi.fn(), getMeeting: vi.fn(), emailMeeting: vi.fn(),
  importMeetingTodos: vi.fn(), renameMeetingSpeaker: vi.fn(),
  addTodo: vi.fn(), patchTodo: vi.fn(), deleteTodo: vi.fn(), addMemo: vi.fn(), deleteMemo: vi.fn(),
  addSchedule: vi.fn(), deleteSchedule: vi.fn(),
}))

import { addSchedule, addTodo, getDashboard, getMeeting, getMeetings, patchTodo } from './api.js'
import Panels from './Panels.jsx'

const DASH = {
  time: '2026-08-14 10:00:00',
  schedule: [{ id: 1, title: '项目复盘', when: '2026-08-14 15:00' }],
  todos: [{ id: 7, content: '整理会议材料', done: false }],
  memos: [{ id: 3, content: '周三交电费' }],
}
const pending = () => new Promise(() => {})

describe('今日板体验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDashboard.mockResolvedValue(DASH)
    getMeetings.mockResolvedValue({ items: [], active: false })
  })
  afterEach(cleanup)

  it('勾选待办立即打勾（不等服务器往返）', async () => {
    patchTodo.mockImplementation(pending)
    render(<Panels refreshKey={0} />)
    const tick = await screen.findByLabelText('完成：整理会议材料')
    fireEvent.click(tick)
    expect(tick).toBeChecked()
    expect(tick.closest('li')).toHaveClass('done')
  })

  it('勾选失败：回滚并说明', async () => {
    patchTodo.mockRejectedValue(new Error('请求失败'))
    render(<Panels refreshKey={0} />)
    const tick = await screen.findByLabelText('完成：整理会议材料')
    fireEvent.click(tick)
    expect(await screen.findByRole('alert')).toHaveTextContent('没能完成')
    expect(screen.getByLabelText('完成：整理会议材料')).not.toBeChecked()
  })

  it('新增待办失败：草稿放回输入框并提示', async () => {
    addTodo.mockRejectedValue(new Error('请求失败'))
    render(<Panels refreshKey={0} />)
    const input = await screen.findByPlaceholderText('＋ 添加待办，回车确认')
    fireEvent.change(input, { target: { value: '买咖啡豆' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('没能添加')
    expect(input.value).toBe('买咖啡豆')
  })

  it('读取中有加载提示；读取失败给出重试', async () => {
    getDashboard.mockImplementationOnce(pending)
    const { unmount } = render(<Panels refreshKey={0} />)
    expect(screen.getByText('正在读取今日…')).toBeInTheDocument()
    unmount()
    getDashboard.mockReset()
    getDashboard.mockRejectedValueOnce(Object.assign(new Error('服务暂不可用'), { status: 503 })).mockResolvedValue(DASH)
    render(<Panels refreshKey={0} />)
    fireEvent.click(await screen.findByRole('button', { name: '重试' }))
    expect(await screen.findByText('项目复盘')).toBeInTheDocument()
  })

  it('日程也能手动添加：标题 + 时间，回车提交', async () => {
    addSchedule.mockResolvedValue({ ok: true, id: 9 })
    render(<Panels refreshKey={0} />)
    const title = await screen.findByPlaceholderText('＋ 添加日程，回车确认')
    fireEvent.change(title, { target: { value: '看牙' } })
    fireEvent.change(screen.getByLabelText('日程时间'), { target: { value: '2026-08-14T16:30' } })
    fireEvent.keyDown(title, { key: 'Enter' })
    await waitFor(() => expect(addSchedule).toHaveBeenCalledWith('看牙', '2026-08-14 16:30'))
    expect(title.value).toBe('')
  })

  it('超出显示上限的待办给出「还有 N 项」', async () => {
    getDashboard.mockResolvedValue({ ...DASH, todos: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, content: `事项${i + 1}` })) })
    render(<Panels refreshKey={0} />)
    expect(await screen.findByText('还有 2 项未显示')).toBeInTheDocument()
  })

  it('会议纪要按 Markdown 渲染（不再露出 ## 和 ** 符号）', async () => {
    getMeetings.mockResolvedValue({ items: [{ id: 1, title: '周会', started_at: '2026-08-14 09:00:00' }], active: false })
    getMeeting.mockResolvedValue({ id: 1, title: '周会', started_at: '2026-08-14 09:00:00', transcript: '', minutes: '## 纪要\n\n**结论**：上线' })
    const { container } = render(<Panels refreshKey={0} />)
    fireEvent.click(await screen.findByRole('button', { name: /周会/ }))
    await waitFor(() => expect(container.querySelector('.meeting-minutes strong')).toHaveTextContent('结论'))
    expect(container.querySelector('.meeting-minutes').textContent).not.toContain('**')
  })
})
