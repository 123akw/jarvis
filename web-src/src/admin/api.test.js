import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAlerts, getUnreadAlerts, getUsage, markAlertsRead, normalizeUsage, rangeOf, saveQuota } from './api.js'

const ok = data => ({ ok: true, status: 200, json: async () => data })
const fail = (status, data = {}) => ({ ok: false, status, json: async () => data })

/* fetch 替身：记下每次请求，按顺序吐出 reply() 排好的响应（没排就回 {}） */
let calls
let queue
const reply = r => queue.push(r)
beforeEach(() => {
  calls = []
  queue = []
  global.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers || {} })
    const r = queue.shift() || ok({})
    if (r instanceof Error) throw r
    return r
  })
})
afterEach(() => { vi.restoreAllMocks() })

describe('admin/api', () => {
  it('getUsage 按天数取，并把缺的字段补齐', async () => {
    reply(ok({
      totals: { calls: 12, cost_yuan: '1.5' },
      daily: [{ day: '2026-10-03', calls: 2 }, { day: '2026-10-02', calls: 10 }, { calls: 99 }],
      accounts: [{ user_id: 7, username: 'amy', quota: { daily_model_calls: 50, daily_flow_runs: null, source: 'custom' } }],
    }))
    const u = await getUsage(30)
    expect(calls[0].url).toBe('/api/admin/usage?days=30')
    expect(u.totals).toEqual({ calls: 12, input_tokens: 0, output_tokens: 0, cost_yuan: 1.5, flow_runs: 0, flow_failures: 0, active_accounts: 0 })
    expect(u.daily.map(d => d.day)).toEqual(['2026-10-02', '2026-10-03'])   // 没有 day 的丢掉，按日期排
    expect(u.accounts[0]).toMatchObject({ user_id: '7', username: 'amy', platform: null, today: { calls: 0, flow_runs: 0 } })
    expect(u.accounts[0].quota).toEqual({ source: 'custom', daily_model_calls: 50, daily_flow_runs: null })
    expect(u.by_kind).toEqual([])
    expect(u.pricing).toEqual({ input_per_m: null, output_per_m: null, note: '' })
    expect(u.defaults).toEqual({ daily_model_calls: 300, daily_flow_runs: 100 })
  })

  it('默认配额：服务端给了用服务端的，否则从「用默认」的账号身上读', () => {
    expect(normalizeUsage({ quota_defaults: { daily_model_calls: 500, daily_flow_runs: 20 } }).defaults)
      .toEqual({ daily_model_calls: 500, daily_flow_runs: 20 })
    const u = normalizeUsage({ accounts: [
      { username: 'a', quota: { daily_model_calls: 9, daily_flow_runs: 9, source: 'custom' } },
      { username: 'b', quota: { daily_model_calls: 250, daily_flow_runs: 60, source: 'default' } },
    ] })
    expect(u.defaults).toEqual({ daily_model_calls: 250, daily_flow_runs: 60 })
  })

  it('范围：今天=1 天，认不出的回到近 7 天', () => {
    expect(rangeOf('today').days).toBe(1)
    expect(rangeOf('30d').days).toBe(30)
    expect(rangeOf('nope').id).toBe('7d')
  })

  it('saveQuota 用 PUT 带 CSRF 头，返回新的 quota', async () => {
    reply(ok({ quota: { daily_model_calls: 80, daily_flow_runs: null, source: 'custom' } }))
    const q = await saveQuota('u/1', { daily_model_calls: 80, daily_flow_runs: null })
    expect(calls[0]).toMatchObject({ url: '/api/admin/quotas/u%2F1', method: 'PUT', body: { daily_model_calls: 80, daily_flow_runs: null } })
    expect(calls[0].headers['Content-Type']).toBe('application/json')
    expect(q).toEqual({ source: 'custom', daily_model_calls: 80, daily_flow_runs: null })
  })

  it('告警：列表与未读数；标已读传 ids 或 all', async () => {
    reply(ok({ alerts: [{ id: 1, kind: 'quota', title: 't', read: false, owner: { id: 'u1', username: 'amy' } }, { id: 2, read: true }] }))
    const r = await getAlerts(20)
    expect(calls[0].url).toBe('/api/admin/alerts?limit=20')
    expect(r.unread).toBe(1)   // 服务端没给 unread 时自己数
    expect(r.alerts[0]).toMatchObject({ id: '1', owner: { username: 'amy' }, read: false })
    expect(r.alerts[1].owner).toBeNull()

    await markAlertsRead({ ids: [3, '4'] })
    await markAlertsRead({ all: true })
    expect(calls[1]).toMatchObject({ url: '/api/admin/alerts/read', method: 'POST', body: { ids: ['3', '4'] } })
    expect(calls[2].body).toEqual({ all: true })
  })

  it('401 抛 Error("401")；其余错误说人话', async () => {
    reply(fail(401))
    await expect(getUsage(7)).rejects.toThrow('401')
    reply(fail(403))
    await expect(getUsage(7)).rejects.toThrow('只有管理员能看管理后台')
    reply(fail(400, { error: '配额要填 1 到 100000 之间的整数' }))
    await expect(saveQuota('u1', {})).rejects.toThrow('配额要填 1 到 100000 之间的整数')
    reply({ ok: false, status: 502, json: async () => { throw new Error('html') } })
    await expect(getAlerts()).rejects.toThrow('服务暂时不可用，请稍后再试')
    reply(new TypeError('Failed to fetch'))
    await expect(getUsage(7)).rejects.toThrow('网络连不上，请检查网络后再试')
  })

  it('入口小红点：只要未读数，任何失败都当 0', async () => {
    reply(ok({ alerts: [], unread: 4 }))
    expect(await getUnreadAlerts()).toBe(4)
    expect(calls[0].url).toBe('/api/admin/alerts?limit=1')
    reply(fail(404))
    expect(await getUnreadAlerts()).toBe(0)
    reply(fail(401))
    expect(await getUnreadAlerts()).toBe(0)
  })
})
