import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFlow, getMyProfession, listFlows, runFlow, sseLineParser } from './api.js'

const enc = new TextEncoder()
function streamResponse(chunks) {
  let i = 0
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }), releaseLock() {} }) },
  }
}

describe('flows/api', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('SSE 按行解析：半行留到下一块，空行 / 注释 / 坏行跳过', () => {
    const feed = sseLineParser()
    expect(feed('data: {"type":"run_start","run_id":"r1"}\n\nda')).toEqual([{ type: 'run_start', run_id: 'r1' }])
    expect(feed('ta: {"type":"step_start","step_id":"s1"}\r\n: ping\ndata: {坏}\n')).toEqual([{ type: 'step_start', step_id: 's1' }])
    expect(feed('data: {"type":"run_done","status":"ok"}', true)).toEqual([{ type: 'run_done', status: 'ok' }])
  })

  it('runFlow 逐个产出事件，请求体按契约带 text / file', async () => {
    const fetch = vi.fn(async () => streamResponse([
      'data: {"type":"run_start","run_id":"r1"}\n\ndata: {"type":"step_st',
      'art","step_id":"a"}\n\n',
      'data: {"type":"run_done","status":"ok","output":null}\n\n',
    ]))
    vi.stubGlobal('fetch', fetch)
    const got = []
    for await (const ev of runFlow('f 1', { file: { name: 'a.pdf', data_base64: 'QUJD', extra: 1 } })) got.push(ev.type)
    expect(got).toEqual(['run_start', 'step_start', 'run_done'])
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/flows/f%201/run')
    expect(JSON.parse(init.body)).toEqual({ file: { name: 'a.pdf', data_base64: 'QUJD' } })
  })

  it('401 抛 Error("401")；其他错误说人话；网络断了也说人话', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    await expect(listFlows()).rejects.toThrow('401')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: '第一步必须是输入' }) })))
    await expect(createFlow('x', [])).rejects.toThrow('第一步必须是输入')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(listFlows()).rejects.toThrow('网络连不上')
    const gen = runFlow('f1', { text: 'hi' })
    await expect(gen.next()).rejects.toThrow('网络连不上')
  })

  it('保存只发契约里的 {plugin, options}', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flow: { id: 'f1' } }) }))
    vi.stubGlobal('fetch', fetch)
    await createFlow('归档', [{ id: 'tmp-1', plugin: 'input_text', options: { label: '贴进来' } }])
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: '归档', steps: [{ plugin: 'input_text', options: { label: '贴进来' } }] })
  })

  it('拿不到平台职业时当 null（接口未就绪不影响页面）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    expect(await getMyProfession()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ platform: { profession: 'teacher' } }) })))
    expect(await getMyProfession()).toBe('teacher')
  })
})
