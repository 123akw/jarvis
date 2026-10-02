import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getPendingReminders: vi.fn(), snoozeReminder: vi.fn(), completeReminder: vi.fn() }))

import { completeReminder, getPendingReminders, snoozeReminder } from './api.js'
import Reminders from './Reminders.jsx'

const MEETING = { id: 3, when: '2026-08-14 15:00', at: '2026-08-14 15:00', title: '项目复盘' }

describe('日程主动提醒弹条', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('巡检这类没有响铃时刻的消息只有「知道了」，点了消掉', async () => {
    getPendingReminders.mockResolvedValue({
      items: [{ id: 'heartbeat-2026-08-14 15:00-1', when: '2026-08-14 15:00', title: '该给妈妈回电话了' }],
    })
    render(<Reminders />)
    expect(await screen.findByText('该给妈妈回电话了')).toBeTruthy()
    expect(screen.getByText('15:00')).toBeTruthy()
    expect(screen.queryByText('完成')).toBeNull()
    fireEvent.click(screen.getByText('知道了'))
    expect(screen.queryByText('该给妈妈回电话了')).toBeNull()
  })

  it('日程提醒点「稍后 10 分」：带响铃时刻调接口，留一句回执后自己消失', async () => {
    getPendingReminders.mockResolvedValue({ items: [MEETING] })
    snoozeReminder.mockResolvedValue({ ok: true, status: 'snoozed', until: '2026-08-14 15:13', title: '项目复盘' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<Reminders />)
    fireEvent.click(await screen.findByText('稍后 10 分'))
    expect(snoozeReminder).toHaveBeenCalledWith(3, '2026-08-14 15:00', 10)
    expect(await screen.findByText('好的，15:13 再提醒你')).toBeTruthy()
    expect(screen.queryByText('完成')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(screen.queryByText('好的，15:13 再提醒你')).toBeNull()
  })

  it('点「完成」：调接口后弹条消失', async () => {
    getPendingReminders.mockResolvedValue({ items: [MEETING] })
    completeReminder.mockResolvedValue({ ok: true, status: 'done', title: '项目复盘' })
    render(<Reminders />)
    fireEvent.click(await screen.findByText('完成'))
    expect(completeReminder).toHaveBeenCalledWith(3, '2026-08-14 15:00')
    await vi.waitFor(() => expect(screen.queryByText('项目复盘')).toBeNull())
  })

  it('别处已经点过「完成」时，「稍后」也直接收起', async () => {
    getPendingReminders.mockResolvedValue({ items: [MEETING] })
    snoozeReminder.mockResolvedValue({ ok: true, status: 'done', already: true, title: '项目复盘' })
    render(<Reminders />)
    fireEvent.click(await screen.findByText('稍后 10 分'))
    await vi.waitFor(() => expect(screen.queryByText('项目复盘')).toBeNull())
  })

  it('操作失败时保留弹条并提示重试；日程已删则直接收起', async () => {
    getPendingReminders.mockResolvedValue({ items: [MEETING, { ...MEETING, id: 4, title: '已删的会' }] })
    completeReminder.mockRejectedValueOnce(Object.assign(new Error('网络异常'), { status: 500 }))
    completeReminder.mockRejectedValueOnce(Object.assign(new Error('这条日程已经删除了'), { status: 404 }))
    render(<Reminders />)
    const [first, second] = await screen.findAllByText('完成')
    fireEvent.click(first)
    expect(await screen.findByText(/没成功，再试一次/)).toBeTruthy()
    expect(screen.getByText('项目复盘')).toBeTruthy()
    fireEvent.click(second)
    await vi.waitFor(() => expect(screen.queryByText('已删的会')).toBeNull())
  })

  it('同一次提醒重复领取到也只弹一条', async () => {
    getPendingReminders.mockResolvedValue({ items: [MEETING, MEETING] })
    render(<Reminders />)
    await screen.findByText('项目复盘')
    expect(screen.getAllByText('项目复盘')).toHaveLength(1)
  })

  it('没有到点日程时什么都不渲染', async () => {
    getPendingReminders.mockResolvedValue({ items: [] })
    const { container } = render(<Reminders />)
    await Promise.resolve()
    expect(container.innerHTML).toBe('')
  })

  it('会话过期时回调 onExpired', async () => {
    getPendingReminders.mockRejectedValue(new Error('401'))
    const onExpired = vi.fn()
    render(<Reminders onExpired={onExpired} />)
    await vi.waitFor(() => expect(onExpired).toHaveBeenCalled())
  })
})
