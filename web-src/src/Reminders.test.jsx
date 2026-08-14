import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getPendingReminders: vi.fn() }))

import { getPendingReminders } from './api.js'
import Reminders from './Reminders.jsx'

describe('日程主动提醒弹条', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('领取到到点日程后弹提示条，点「知道了」消掉', async () => {
    getPendingReminders.mockResolvedValue({
      items: [{ id: 3, when: '2026-08-14 15:00', title: '项目复盘' }],
    })
    render(<Reminders />)
    expect(await screen.findByText('项目复盘')).toBeTruthy()
    expect(screen.getByText('15:00')).toBeTruthy()
    fireEvent.click(screen.getByText('知道了'))
    expect(screen.queryByText('项目复盘')).toBeNull()
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
