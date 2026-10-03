import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeFlow, getFeishuStatus, getTrigger, listFlows, listRuns, runGraph, saveFlow, setTrigger, sseLineParser,
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
})
