import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeFlow, createWebhook, decideApproval, deleteWebhook, getApproval, getFeishuStatus, getHooks, getRun, getTrigger,
  listApprovals, listFlows, listRuns, rerunGraph, runGraph, saveFlow, setMessageHook, setTrigger, sseLineParser, testNode,
} from './api.js'

const enc = new TextEncoder()
function streamResponse(chunks) {
  let i = 0
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }), releaseLock() {} }) },
  }
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

describe('flows/api', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('SSE 按行解析：半行留到下一块，空行 / 注释 / 坏行跳过', () => {
    const feed = sseLineParser()
    expect(feed('data: {"type":"run_start","run_id":"r1"}\n\nda')).toEqual([{ type: 'run_start', run_id: 'r1' }])
    expect(feed('ta: {"type":"node_start","node_id":"n1"}\r\n: ping\ndata: {坏}\n')).toEqual([{ type: 'node_start', node_id: 'n1' }])
    expect(feed('data: {"type":"run_done","status":"ok"}', true)).toEqual([{ type: 'run_done', status: 'ok' }])
  })

  it('runGraph 按契约发 {inputs}，逐个产出节点事件', async () => {
    const fetch = vi.fn(async () => streamResponse([
      'data: {"type":"run_start","run_id":"r1"}\n\ndata: {"type":"node_st',
      'art","node_id":"n1"}\n\n',
      'data: {"type":"run_done","status":"ok","output":{"text":"好"}}\n\n',
    ]))
    vi.stubGlobal('fetch', fetch)
    const got = []
    for await (const ev of runGraph('f 1', { text: '你好', file: { name: 'a.pdf', data_base64: 'QUJD' } })) got.push(ev.type)
    expect(got).toEqual(['run_start', 'node_start', 'run_done'])
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/flows/f%201/run')
    expect(JSON.parse(init.body)).toEqual({ inputs: { text: '你好', file: { name: 'a.pdf', data_base64: 'QUJD' } } })
  })

  it('401 抛 Error("401")；其他错误说人话；网络断了也说人话', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)))
    await expect(listFlows()).rejects.toThrow('401')
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: '至少要有一个结束节点' }, 400)))
    await expect(saveFlow({ name: 'x', graph: { nodes: [], edges: [] } })).rejects.toThrow('至少要有一个结束节点')
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)))
    await expect(getTrigger('f1')).rejects.toThrow('这个流程不见了')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(listFlows()).rejects.toThrow('网络连不上')
    await expect(runGraph('f1', {}).next()).rejects.toThrow('网络连不上')
  })

  it('保存：没有 id 走 POST，有 id 走 PUT，只发 {name, summary, graph}', async () => {
    const fetch = vi.fn(async () => json({ flow: { id: 'f9' } }))
    vi.stubGlobal('fetch', fetch)
    const graph = { nodes: [{ id: 'start', type: 'start' }], edges: [] }
    expect(await saveFlow({ name: '早报', graph, extra: 1 })).toEqual({ id: 'f9' })
    expect(fetch.mock.calls[0][0]).toBe('/api/flows')
    expect(fetch.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: '早报', summary: '', graph })
    await saveFlow({ id: 'f9', name: '早报', summary: '每天', graph })
    expect(fetch.mock.calls[1][0]).toBe('/api/flows/f9')
    expect(fetch.mock.calls[1][1].method).toBe('PUT')
  })

  it('一句话生成：POST {description}，可以中途取消', async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return json({ draft: { name: '早报' }, notes: [], source: 'model' })
    })
    vi.stubGlobal('fetch', fetch)
    expect((await composeFlow('每天早上发天气')).draft.name).toBe('早报')
    expect(fetch.mock.calls[0][0]).toBe('/api/flows/compose')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ description: '每天早上发天气' })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(composeFlow('x', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('定时运行：GET 没设过返回 null，PUT 原样发出', async () => {
    const fetch = vi.fn(async (_url, init = {}) => (init.method === 'PUT'
      ? json({ trigger: { kind: 'schedule', label: '每天 08:00' } })
      : json({ trigger: null })))
    vi.stubGlobal('fetch', fetch)
    expect(await getTrigger('f1')).toBeNull()
    const body = { kind: 'schedule', enabled: true, schedule: { repeat: 'daily', time: '08:00' }, inputs: {}, notify: { feishu: false, desktop: true } }
    expect(await setTrigger('f1', body)).toEqual({ kind: 'schedule', label: '每天 08:00' })
    expect(fetch.mock.calls[1][0]).toBe('/api/flows/f1/trigger')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(body)
  })

  it('运行记录兼容 {runs} 与数组；飞书状态读不到按没绑定', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ runs: [{ id: 'r1' }] })))
    expect(await listRuns('f1')).toEqual([{ id: 'r1' }])
    vi.stubGlobal('fetch', vi.fn(async () => json([{ id: 'r2' }])))
    expect(await listRuns('f1', 5)).toEqual([{ id: 'r2' }])
    vi.stubGlobal('fetch', vi.fn(async () => json({ configured: true, bound: true })))
    expect(await getFeishuStatus()).toEqual({ configured: true, bound: true })
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)))
    expect(await getFeishuStatus()).toEqual({ configured: true, bound: false })
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)))
    await expect(getFeishuStatus()).rejects.toThrow('401')
  })

  it('第二十轮：试跑一步发 {inputs}（没有就空对象）；重跑走 SSE；运行详情兼容 {run} 与直接返回', async () => {
    const fetch = vi.fn(async url => (url.endsWith('/test')
      ? json({ status: 'ok', ms: 120, output: { text: '好' }, note: '试跑不会真的发送' })
      : json({ run: { id: 'r1', status: 'ok' } })))
    vi.stubGlobal('fetch', fetch)
    expect(await testNode('f1', 'n 1', { text: '你好' })).toMatchObject({ status: 'ok', note: '试跑不会真的发送' })
    expect(fetch.mock.calls[0][0]).toBe('/api/flows/f1/nodes/n%201/test')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ inputs: { text: '你好' } })
    await testNode('f1', 'n1')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({})
    expect(await getRun('f1', 'r1')).toEqual({ id: 'r1', status: 'ok' })
    expect(fetch.mock.calls[2][0]).toBe('/api/flows/f1/runs/r1')
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'r2', status: 'waiting' })))
    expect(await getRun('f1', 'r2')).toEqual({ id: 'r2', status: 'waiting' })
    const sse = vi.fn(async () => streamResponse(['data: {"type":"run_start","run_id":"r3"}\n\ndata: {"type":"run_done","status":"ok"}\n\n']))
    vi.stubGlobal('fetch', sse)
    const got = []
    for await (const ev of rerunGraph('f1', 'r1')) got.push(ev.type)
    expect(got).toEqual(['run_start', 'run_done'])
    expect(sse.mock.calls[0][0]).toBe('/api/flows/f1/runs/r1/rerun')
    expect(sse.mock.calls[0][1].method).toBe('POST')
  })

  it('配额用完（429）用服务端的人话；没给原因时说稍后再试', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: '今天的用量到上限了，明天再来，或请管理员调高' }, 429)))
    await expect(testNode('f1', 'n1')).rejects.toThrow('今天的用量到上限了')
    await expect(rerunGraph('f1', 'r1').next()).rejects.toThrow('今天的用量到上限了')
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 429)))
    await expect(listFlows()).rejects.toThrow('操作太频繁了')
  })

  it('发送前确认：列表 / 详情 / 同意带内容、拒绝带原因；已处理 409、不存在 404 说人话', async () => {
    const fetch = vi.fn(async (url, init = {}) => {
      if (url.startsWith('/api/approvals?')) return json({ approvals: [{ id: 'a1', status: 'pending' }, null], pending: 1 })
      if (init.method === 'POST') return json({ approval: { id: 'a1', status: 'approved' }, run: { id: 'r1', status: 'running' } })
      return json({ approval: { id: 'a1', content: '要发的', editable: true } })
    })
    vi.stubGlobal('fetch', fetch)
    expect(await listApprovals()).toEqual({ approvals: [{ id: 'a1', status: 'pending' }], pending: 1 })
    expect(fetch.mock.calls[0][0]).toBe('/api/approvals?status=pending&limit=20')
    expect((await getApproval('a1')).content).toBe('要发的')
    await decideApproval('a1', { decision: 'approve', content: '改过的' })
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ decision: 'approve', content: '改过的' })
    await decideApproval('a1', { decision: 'reject', note: '  不发了 ', content: 'x' })
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ decision: 'reject', note: '不发了' })
    await decideApproval('a1', { decision: 'reject', note: '  ' })
    expect(JSON.parse(fetch.mock.calls[4][1].body)).toEqual({ decision: 'reject' })
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 409)))
    await expect(decideApproval('a1', { decision: 'approve' })).rejects.toMatchObject({ status: 409, message: '这条已经处理过了，或者已经过期' })
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)))
    await expect(getApproval('zz')).rejects.toThrow('找不到这条确认')
    vi.stubGlobal('fetch', vi.fn(async () => json({ approvals: [{ id: 'a1', status: 'pending' }, { id: 'a2', status: 'approved' }] })))
    expect((await listApprovals({ status: 'all', limit: 5 })).pending).toBe(1)
  })

  it('触发方式：读设置 / 存消息触发 / 生成与关掉链接', async () => {
    const fetch = vi.fn(async (url, init = {}) => {
      if (init.method === 'PUT') return json({ message: { ...JSON.parse(init.body), last_hit_at: null } })
      if (init.method === 'POST') return json({ webhook: { enabled: true, url_hint: '…a1b2' }, url: 'https://j.example.com/api/hooks/abc' })
      if (init.method === 'DELETE') return json({ webhook: null })
      return json({ message: null, webhook: { enabled: true }, channels: { feishu: { ready: true, reason: '' } } })
    })
    vi.stubGlobal('fetch', fetch)
    expect(await getHooks('f1')).toEqual({ message: null, webhook: { enabled: true }, channels: { feishu: { ready: true, reason: '' } } })
    expect(fetch.mock.calls[0][0]).toBe('/api/flows/f1/hooks')
    const body = { enabled: true, channels: ['feishu'], match: 'keywords', keywords: ['早报'], input_field: 'text' }
    expect(await setMessageHook('f1', body)).toEqual({ ...body, last_hit_at: null })
    expect(fetch.mock.calls[1][0]).toBe('/api/flows/f1/hooks/message')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(body)
    expect((await createWebhook('f1')).url).toBe('https://j.example.com/api/hooks/abc')
    expect(fetch.mock.calls[2][0]).toBe('/api/flows/f1/hooks/webhook')
    await deleteWebhook('f1')
    expect(fetch.mock.calls[3][1].method).toBe('DELETE')
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    expect(await getHooks('f1')).toEqual({ message: null, webhook: null, channels: {} })
  })
})
