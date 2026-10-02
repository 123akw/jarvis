import { describe, expect, it, vi } from 'vitest'

import {
  browserFamily, loopbackAccess, loopbackFetch, pingDesktop, queryLoopbackPermission, summonDesktop,
  LOOPBACK_PERMISSION_NAMES, WAKE_BASE, PROTOCOL_URL,
} from './desktopWake.js'

const ping = (loggedIn = false) => ({
  ok: true,
  json: async () => ({ app: 'jws-desktop', loggedIn }),
})
const refused = () => Object.assign(new TypeError('Failed to fetch'))
const permissionsWith = state => ({ query: vi.fn(async ({ name }) => {
  if (!LOOPBACK_PERMISSION_NAMES.includes(name)) throw new TypeError('bad name')
  return { state: typeof state === 'function' ? state() : state }
}) })
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15'
// 轮询用假时钟：sleep 推进时间，不真等
function fakeClock() {
  let t = 0
  return { now: () => t, sleep: vi.fn(async ms => { t += ms }) }
}

describe('本机访问声明 targetAddressSpace', () => {
  it('请求都声明目标在本机（loopback），不是 local', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ping(true))
    await pingDesktop({ fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${WAKE_BASE}/ping`)
    expect(init.targetAddressSpace).toBe('loopback')
    expect(init.signal).toBeDefined()
  })

  it('旧内核不认识该取值时去掉声明重发；网络失败不重发', async () => {
    const enumError = new TypeError("Failed to read the 'targetAddressSpace' property from 'RequestInit': The provided value 'loopback' is not a valid enum value of type IPAddressSpace.")
    const fetchImpl = vi.fn().mockRejectedValueOnce(enumError).mockResolvedValueOnce(ping(true))
    const response = await loopbackFetch(fetchImpl, `${WAKE_BASE}/ping`, { method: 'GET' })
    expect(response.ok).toBe(true)
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${WAKE_BASE}/ping`, { method: 'GET' })

    const failing = vi.fn().mockRejectedValue(refused())
    await expect(loopbackFetch(failing, `${WAKE_BASE}/ping`)).rejects.toThrow('Failed to fetch')
    expect(failing).toHaveBeenCalledTimes(1)
  })
})

describe('浏览器授权状态', () => {
  it('先查 loopback-network，不认识再查 local-network-access；都查不到算 unsupported', async () => {
    const permissions = { query: vi.fn(async ({ name }) => {
      if (name === 'loopback-network') throw new TypeError('not a valid enum value')
      return { state: 'denied' }
    }) }
    expect(await queryLoopbackPermission(permissions)).toBe('denied')
    expect(permissions.query.mock.calls.map(([d]) => d.name)).toEqual(['loopback-network', 'local-network-access'])
    expect(await queryLoopbackPermission({ query: async () => { throw new TypeError('x') } })).toBe('unsupported')
    expect(await queryLoopbackPermission(null)).toBe('unsupported')
  })

  it('Safari 的 https 页必拦（混合内容），Chrome 看授权状态', async () => {
    expect(browserFamily(SAFARI_UA)).toBe('safari')
    expect(browserFamily(CHROME_UA)).toBe('chrome')
    expect(await loopbackAccess({ userAgent: SAFARI_UA, secure: true, permissions: permissionsWith('granted') })).toBe('mixed-content')
    expect(await loopbackAccess({ userAgent: SAFARI_UA, secure: false, permissions: null })).toBe('open')
    expect(await loopbackAccess({ userAgent: CHROME_UA, secure: true, permissions: permissionsWith('denied') })).toBe('denied')
    expect(await loopbackAccess({ userAgent: CHROME_UA, secure: true, permissions: permissionsWith('prompt') })).toBe('prompt')
    expect(await loopbackAccess({ userAgent: CHROME_UA, secure: true, permissions: permissionsWith('granted') })).toBe('open')
  })
})

describe('桌面悬浮窗联动', () => {
  it('悬浮窗在跑：探活→领票→/wake 带票唤起，不碰 jws://', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ping(false))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, loggedIn: true }) })
    const fetchTicket = vi.fn().mockResolvedValue({ ticket: 't-one-time', expires_in: 60 })
    const openProtocol = vi.fn()

    const result = await summonDesktop({ fetchTicket, fetchImpl, openProtocol, permissions: permissionsWith('granted') })

    expect(result).toEqual({ status: 'awakened', loggedIn: true })
    expect(fetchTicket).toHaveBeenCalledTimes(1)
    expect(openProtocol).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${WAKE_BASE}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 't-one-time' }),
      targetAddressSpace: 'loopback',
    })
  })

  it('待询问授权：探活给足时间等用户在浏览器弹窗里点「允许」，并先报 permission-prompt', async () => {
    vi.useFakeTimers()
    try {
      let answer
      const fetchImpl = vi.fn()
        .mockImplementationOnce((_url, { signal }) => new Promise((resolve, reject) => {
          answer = () => resolve(ping(true))
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, loggedIn: true }) })
      const onProgress = vi.fn()
      const pending = summonDesktop({ fetchTicket: async () => ({ ticket: 't' }), fetchImpl, onProgress,
        permissions: permissionsWith('prompt'), userAgent: CHROME_UA, secure: true })
      await vi.advanceTimersByTimeAsync(5000)  // 远超 800ms：旧逻辑早已判「没启动」
      answer()
      expect(await pending).toEqual({ status: 'awakened', loggedIn: true })
      expect(onProgress).toHaveBeenCalledWith('permission-prompt')
    } finally {
      vi.useRealTimers()
    }
  })

  it('没在跑：带票打开 jws://，轮询到应用起来后换新票唤起，不再要用户点第二次', async () => {
    const clock = fakeClock()
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(refused())               // 首次探活：没在跑
      .mockRejectedValueOnce(refused())               // 轮询 1：还在启动
      .mockResolvedValueOnce(ping(true))              // 轮询 2：起来了（已凭协议里的票登录）
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, loggedIn: true }) })
    const fetchTicket = vi.fn().mockResolvedValueOnce({ ticket: 'proto-ticket' }).mockResolvedValueOnce({ ticket: 'wake-ticket' })
    const openProtocol = vi.fn()
    const onProgress = vi.fn()

    const result = await summonDesktop({ fetchTicket, fetchImpl, openProtocol, onProgress, permissions: permissionsWith('granted'), ...clock })

    expect(openProtocol).toHaveBeenCalledWith(`${PROTOCOL_URL}?ticket=proto-ticket`)
    expect(onProgress).toHaveBeenCalledWith('launching')
    expect(result).toEqual({ status: 'awakened', loggedIn: true, launched: true })
    expect(JSON.parse(fetchImpl.mock.calls[3][1].body)).toEqual({ ticket: 'wake-ticket' })
  })

  it('jws:// 之后约 6 秒仍探不到：报 not-running（附协议地址），领不到票也照样拉起', async () => {
    const clock = fakeClock()
    const fetchImpl = vi.fn().mockRejectedValue(refused())
    const openProtocol = vi.fn()
    const result = await summonDesktop({ fetchTicket: vi.fn().mockRejectedValue(new Error('401')), fetchImpl, openProtocol,
      permissions: permissionsWith('granted'), ...clock })

    expect(result).toEqual({ status: 'not-running', protocolUrl: PROTOCOL_URL })
    expect(openProtocol).toHaveBeenCalledWith(PROTOCOL_URL)
    expect(clock.now()).toBeGreaterThanOrEqual(6000)
    expect(clock.now()).toBeLessThan(8000)
    expect(fetchImpl.mock.calls.every(([url]) => url === `${WAKE_BASE}/ping`)).toBe(true)  // 从没发过 /wake
  })

  it('用户拒绝过授权：不白等，直接带票走 jws:// 并报 blocked（区分于没启动）', async () => {
    const fetchImpl = vi.fn()
    const openProtocol = vi.fn()
    const result = await summonDesktop({ fetchTicket: async () => ({ ticket: 'tk' }), fetchImpl, openProtocol,
      permissions: permissionsWith('denied'), userAgent: CHROME_UA, secure: true })

    expect(result).toEqual({ status: 'blocked', reason: 'denied', browser: 'chrome', protocolUrl: `${PROTOCOL_URL}?ticket=tk` })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(openProtocol).toHaveBeenCalledWith(`${PROTOCOL_URL}?ticket=tk`)
  })

  it('Safari：混合内容必拦，直接走 jws:// 并报 blocked/mixed-content', async () => {
    const fetchImpl = vi.fn()
    const result = await summonDesktop({ fetchTicket: async () => ({ ticket: 'tk' }), fetchImpl, openProtocol: vi.fn(),
      userAgent: SAFARI_UA, secure: true, permissions: null })
    expect(result).toMatchObject({ status: 'blocked', reason: 'mixed-content', browser: 'safari' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('等待期间用户在弹窗里点了「阻止」：结束时按浏览器拦截报 blocked', async () => {
    const clock = fakeClock()
    let state = 'prompt'
    const fetchImpl = vi.fn(async () => { state = 'denied'; throw refused() })
    const result = await summonDesktop({ fetchTicket: async () => ({ ticket: 'tk' }), fetchImpl, openProtocol: vi.fn(),
      permissions: permissionsWith(() => state), userAgent: CHROME_UA, secure: true, ...clock })
    expect(result).toMatchObject({ status: 'blocked', reason: 'denied' })
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

  it('探活超时走 AbortSignal，超时视为探不到', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    expect(await pingDesktop({ fetchImpl, timeoutMs: 10 })).toBeNull()
  })

  it('冒充应用的响应不算在跑', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ app: 'other-app' }) })
    expect(await pingDesktop({ fetchImpl })).toBeNull()
  })
})

describe('悬浮窗控制 /window', () => {
  it('在跑时转发动作并报 done', async () => {
    const { desktopWindow } = await import('./desktopWake.js')
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ping(true))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    const result = await desktopWindow('hide', { fetchImpl })
    expect(result).toEqual({ status: 'done' })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${WAKE_BASE}/window`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hide' }),
      targetAddressSpace: 'loopback',
    })
  })

  it('没在跑：不发 /window，报 not-running', async () => {
    const { desktopWindow } = await import('./desktopWake.js')
    const fetchImpl = vi.fn().mockRejectedValue(new Error('refused'))
    expect(await desktopWindow('quit', { fetchImpl })).toEqual({ status: 'not-running' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('请求被拒：报 failed', async () => {
    const { desktopWindow } = await import('./desktopWake.js')
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ping(true))
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    expect(await desktopWindow('show', { fetchImpl })).toEqual({ status: 'failed' })
  })
})
