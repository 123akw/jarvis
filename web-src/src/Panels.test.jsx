import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getDashboard: vi.fn(),
  getMeetings: vi.fn(),
  getMeeting: vi.fn(),
  emailMeeting: vi.fn(),
  importMeetingTodos: vi.fn(),
  addTodo: vi.fn(),
  patchTodo: vi.fn(),
  deleteTodo: vi.fn(),
  addMemo: vi.fn(),
  deleteMemo: vi.fn(),
  addSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  getBrief: vi.fn(async () => ({ status: 'early', date: '2026-08-14' })),
  ensureBrief: vi.fn(),
  getMemoryState: vi.fn(async () => ({ receipts: true, fresh: { count: 0, ids: [] } })),
  dismissFreshMemory: vi.fn(),
}))

import { addTodo, deleteMemo, emailMeeting, getDashboard, getMeeting, getMeetings, importMeetingTodos, patchTodo } from './api.js'
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
    getMeetings.mockResolvedValue({ items: [], active: false })
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
    // 打勾动画播完（约 0.45 秒）后重新拉取
    await waitFor(() => expect(getDashboard.mock.calls.length).toBeGreaterThan(1))
  })

  it('待办快速新增：输入回车调 POST', async () => {
    render(<Panels refreshKey={0} />)
    const input = await screen.findByPlaceholderText('＋ 待办或日程，写上时间就是日程')
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

describe('会议纪要卡片', () => {
  const MEETINGS = {
    active: false,
    items: [{ id: 2, title: '产品周会', started_at: '2026-08-24 10:00', ended_at: '2026-08-24 10:45', mailed_to: '1539598168@qq.com', has_minutes: true }],
  }
  beforeEach(() => {
    vi.clearAllMocks()
    getDashboard.mockResolvedValue(DASH)
    getMeetings.mockResolvedValue(MEETINGS)
    getMeeting.mockResolvedValue({ id: 2, title: '产品周会', minutes: '# 会议纪要\n- 方案明天上线', transcript: '[10:00:01] 我：开始吧' })
    emailMeeting.mockResolvedValue({ ok: true, to: '1539598168@qq.com' })
  })
  afterEach(cleanup)

  it('列出会议并点开查看纪要', async () => {
    render(<Panels refreshKey={0} />)
    const open = await screen.findByTitle('查看纪要')
    expect(open.textContent).toContain('产品周会')
    expect(open.textContent).toContain('✉')   // 已发过邮件的标记
    fireEvent.click(open)
    await waitFor(() => expect(getMeeting).toHaveBeenCalledWith(2))
    const item = await screen.findByText(/方案明天上线/)
    expect(item.closest('.meeting-minutes').textContent).toContain('会议纪要')   // 纪要按 Markdown 渲染
  })

  it('重发邮件按钮真的调接口并回显收件人', async () => {
    render(<Panels refreshKey={0} />)
    fireEvent.click(await screen.findByTitle('重发纪要邮件'))
    await waitFor(() => expect(emailMeeting).toHaveBeenCalledWith(2))
    expect((await screen.findByRole('status')).textContent).toContain('1539598168@qq.com')
  })

  it('没有任何会议且未在监控时整卡隐藏', async () => {
    getMeetings.mockResolvedValue({ items: [], active: false })
    render(<Panels refreshKey={0} />)
    await screen.findByLabelText('完成：整理会议材料')
    expect(screen.queryByText('会议纪要')).toBeNull()
  })

  it('监控中显示状态点', async () => {
    getMeetings.mockResolvedValue({ items: [], active: true })
    render(<Panels refreshKey={0} />)
    expect((await screen.findByText('● 监控中')).textContent).toBeTruthy()
  })
})

describe('会议纪要：导入待办与追问', () => {
  const MEETINGS = {
    active: false,
    items: [{ id: 2, title: '产品周会', started_at: '2026-08-25 10:00', ended_at: '2026-08-25 10:45', mailed_to: '', has_minutes: true }],
  }
  const DETAIL = { id: 2, title: '产品周会', started_at: '2026-08-25 10:00', minutes: '# 会议纪要\n## 待办事项\n· 梳理变量 — 我 — 周四', transcript: '[10:00:01] 我：开始吧' }
  beforeEach(() => {
    vi.clearAllMocks()
    getDashboard.mockResolvedValue(DASH)
    getMeetings.mockResolvedValue(MEETINGS)
    getMeeting.mockResolvedValue(DETAIL)
    importMeetingTodos.mockResolvedValue({ ok: true, found: 1, mine: 1, imported: 1 })
  })
  afterEach(cleanup)

  it('导入待办：调接口并刷新任务台', async () => {
    render(<Panels refreshKey={0} />)
    fireEvent.click(await screen.findByTitle('查看纪要'))
    fireEvent.click(await screen.findByRole('button', { name: /导入待办/ }))
    await waitFor(() => expect(importMeetingTodos).toHaveBeenCalledWith(2))
    expect((await screen.findByRole('status')).textContent).toContain('1 条')
    expect(getDashboard.mock.calls.length).toBeGreaterThan(1)
  })

  it('追问：把纪要+转写整包交给对话', async () => {
    const asked = []
    render(<Panels refreshKey={0} onAskMeeting={t => asked.push(t)} />)
    fireEvent.click(await screen.findByTitle('查看纪要'))
    fireEvent.click(await screen.findByRole('button', { name: /就这场会议追问/ }))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('产品周会')
    expect(asked[0]).toContain('梳理变量')
    expect(asked[0]).toContain('原始转写')
  })
})
