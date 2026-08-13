import { describe, expect, it, vi } from 'vitest'

import { pingDesktop, summonDesktop, WAKE_BASE, PROTOCOL_URL } from './desktopWake.js'

const ping = (loggedIn = false) => ({
  ok: true,
  json: async () => ({ app: 'jws-desktop', loggedIn }),
})

describe('桌面悬浮窗联动三态', () => {
  it('悬浮窗在跑：探活→领票→/wake 带票唤起', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ping(false))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, loggedIn: true }) })
    const fetchTicket = vi.fn().mockResolvedValue({ ticket: 't-one-time', expires_in: 60 })

    const result = await summonDesktop({ fetchTicket, fetchImpl })

    expect(result).toEqual({ status: 'awakened', loggedIn: true })
    expect(fetchTicket).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${WAKE_BASE}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 't-one-time' }),
    })
  })

  it('悬浮窗没在跑：不发 /wake，回落 jws:// 协议地址（票据随行）', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error('refused'), { name: 'TypeError' }))
    const fetchTicket = vi.fn().mockResolvedValue({ ticket: 'proto-ticket' })

    const result = await summonDesktop({ fetchTicket, fetchImpl })

    expect(result).toEqual({ status: 'not-running', protocolUrl: `${PROTOCOL_URL}?ticket=proto-ticket` })
    expect(fetchImpl).toHaveBeenCalledTimes(1)  // 只有 ping，没有 wake
    // 连票都领不到时仍给纯协议地址，指引照常
    const noTicket = await summonDesktop({ fetchTicket: vi.fn().mockRejectedValue(new Error('401')), fetchImpl })
    expect(noTicket).toEqual({ status: 'not-running', protocolUrl: PROTOCOL_URL })
  })

  it('领票失败：明确报 ticket-failed 且绝不发 /wake', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ping(false))
    const fetchTicket = vi.fn().mockRejectedValue(new Error('401'))

    const result = await summonDesktop({ fetchTicket, fetchImpl })

    expect(result).toEqual({ status: 'ticket-failed' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('wake 请求失败：报 wake-failed（票已领但桌面端没收好）', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ping(false))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    const result = await summonDesktop({ fetchTicket: async () => ({ ticket: 't' }), fetchImpl })
    expect(result).toEqual({ status: 'wake-failed' })
  })

  it('探活 800ms 超时走 AbortSignal，超时视为没在跑', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const result = await pingDesktop({ fetchImpl, timeoutMs: 10 })
    expect(result).toBeNull()
    // 探不到就不领票
    const summoned = await summonDesktop({ fetchTicket: vi.fn().mockRejectedValue(new Error('x')), fetchImpl, timeoutMs: 10 })
    expect(summoned.status).toBe('not-running')
  })

  it('冒充应用的响应不算在跑', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ app: 'other-app' }) })
    expect(await pingDesktop({ fetchImpl })).toBeNull()
  })
})
