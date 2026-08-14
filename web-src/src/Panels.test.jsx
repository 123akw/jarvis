import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getDashboard: vi.fn(),
  addTodo: vi.fn(),
  patchTodo: vi.fn(),
  deleteTodo: vi.fn(),
  addMemo: vi.fn(),
  deleteMemo: vi.fn(),
  addSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
}))

import { addTodo, deleteMemo, getDashboard, patchTodo } from './api.js'
import Panels from './Panels.jsx'

const DASH = {
  time: '2026-08-14 10:00:00',
  schedule: [{ id: 1, title: '项目复盘', when: '2026-08-14 15:00' }],
  todos: [{ id: 7, content: '整理会议材料', done: false }],
  memos: [{ id: 3, content: '周三交电费' }],
}

describe('任务台可交互', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDashboard.mockResolvedValue(DASH)
    patchTodo.mockResolvedValue({ ok: true })
    addTodo.mockResolvedValue({ ok: true, id: 8 })
    deleteMemo.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('待办是真复选框：勾选调 PATCH 并刷新面板', async () => {
    render(<Panels refreshKey={0} />)
    const tick = await screen.findByLabelText('完成：整理会议材料')
    fireEvent.click(tick)
    await waitFor(() => expect(patchTodo).toHaveBeenCalledWith(7, true))
    expect(getDashboard.mock.calls.length).toBeGreaterThan(1)  // 操作后重新拉取
  })

  it('待办快速新增：输入回车调 POST', async () => {
    render(<Panels refreshKey={0} />)
    const input = await screen.findByPlaceholderText('＋ 添加待办，回车确认')
    fireEvent.change(input, { target: { value: '买咖啡豆' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(addTodo).toHaveBeenCalledWith('买咖啡豆'))
    expect(input.value).toBe('')
  })

  it('备忘可删除', async () => {
    render(<Panels refreshKey={0} />)
    fireEvent.click(await screen.findByTitle('删除这条备忘'))
    await waitFor(() => expect(deleteMemo).toHaveBeenCalledWith(3))
  })
})
