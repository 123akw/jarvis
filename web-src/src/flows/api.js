import { csrfHeaders } from '../api.js'

/* 流程拼接页的接口封装（契约见 docs/proposals/2026-10-round13-platform.md 4.2 / 4.3）。
 * 约定与 ../api.js 一致：401 抛 Error('401') 交给页面调 onExpired；其余错误一律换成人话。 */

function httpError(status, reason) {
  if (status === 403) return reason || '登录状态校验没通过，请刷新页面后再试'
  if (status === 404) return reason || '这个流程不见了，可能已经删掉了'
  if (status === 409) return reason || '这个流程正在运行，等这次跑完再试'
  if (status === 413) return '文件太大了，请换一个 10MB 以内的'
  if (status === 429) return '操作太频繁了，请稍等片刻再试'
  if (status >= 500) return reason || '服务暂时不可用，请稍后再试'
  return reason || `请求没成功（HTTP ${status}）`
}

/** fetch 抛出的 TypeError 是网络层失败（断网 / 服务没起来），说人话 */
function netError(err) {
  if (err?.name === 'AbortError') return err
  return err instanceof TypeError ? new Error('网络连不上，请检查网络后再试') : err
}

async function request(url, init) {
  let r
  try { r = await fetch(url, init) } catch (err) { throw netError(err) }
  if (r.status === 401) throw new Error('401')
  let data = null
  try { data = await r.json() } catch { /* 网关错误页不是 JSON */ }
  if (!r.ok) {
    throw Object.assign(new Error(httpError(r.status, data?.error || '')), { status: r.status, code: data?.code || '' })
  }
  return data || {}
}

const json = () => ({ 'Content-Type': 'application/json', ...csrfHeaders() })

/** 积木元数据：kind=step 或带 step 的插件 + 职业模板 */
export function getCatalog() {
  return request('/api/market/catalog')
}

/** 当前账号智能体的职业（把对口模板排前面）；还没有智能体或接口未就绪都当 null */
export async function getMyProfession() {
  try {
    const data = await request('/api/platform')
    return data?.platform?.profession || null
  } catch (err) {
    if (err.message === '401') throw err
    return null
  }
}

export async function listFlows() {
  const data = await request('/api/flows')
  return Array.isArray(data.flows) ? data.flows : []
}

/** 只发契约里的 {plugin, options}：本地新加的步骤还没有服务端 id */
function payload(name, steps) {
  return JSON.stringify({ name, steps: steps.map(s => ({ plugin: s.plugin, options: s.options || {} })) })
}

export async function createFlow(name, steps) {
  return (await request('/api/flows', { method: 'POST', headers: json(), body: payload(name, steps) })).flow
}

export async function updateFlow(id, name, steps) {
  return (await request(`/api/flows/${encodeURIComponent(id)}`, { method: 'PUT', headers: json(), body: payload(name, steps) })).flow
}

export async function deleteFlow(id) {
  return request(`/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE', headers: csrfHeaders() })
}

/** 最近几次运行；兼容 {runs:[…]} 与直接返回数组两种写法 */
export async function listRuns(id, limit = 5) {
  const data = await request(`/api/flows/${encodeURIComponent(id)}/runs?limit=${limit}`)
  if (Array.isArray(data)) return data
  return Array.isArray(data.runs) ? data.runs : []
}

/** 按行解析 SSE：每行 `data: {json}`，空行与注释行（`:` 开头）跳过；半行留到下一块 */
export function sseLineParser() {
  let buf = ''
  return function feed(chunk, flush = false) {
    buf += chunk
    const lines = buf.split('\n')
    buf = flush ? '' : lines.pop()
    const out = []
    for (let line of lines) {
      line = line.replace(/\r$/, '')
      if (!line.startsWith('data:')) continue
      const body = line.slice(5).trim()
      if (!body) continue
      try { out.push(JSON.parse(body)) } catch { /* 半截 / 非 JSON 的行丢掉，不让整条流程崩 */ }
    }
    return out
  }
}

/**
 * 运行流程：POST /api/flows/{id}/run → text/event-stream，逐个产出事件
 * {type:'run_start'|'step_start'|'step_done'|'step_error'|'run_done', …}。signal 用于中途取消。
 */
export async function* runFlow(id, input, signal = null) {
  const body = {}
  if (input?.text) body.text = input.text
  if (input?.file) body.file = { name: input.file.name, data_base64: input.file.data_base64 }
  let r
  try {
    r = await fetch(`/api/flows/${encodeURIComponent(id)}/run`, { method: 'POST', headers: json(), body: JSON.stringify(body), signal })
  } catch (err) { throw netError(err) }
  if (r.status === 401) throw new Error('401')
  if (!r.ok) {
    let reason = ''
    try { reason = (await r.json())?.error || '' } catch { /* 非 JSON */ }
    throw Object.assign(new Error(httpError(r.status, reason)), { status: r.status })
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  const feed = sseLineParser()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield* feed(dec.decode(value, { stream: true }))
    }
    yield* feed(dec.decode(), true)
  } catch (err) {
    throw netError(err)
  } finally {
    try { reader.releaseLock() } catch { /* 已释放 */ }
  }
}

/** File → base64（不带 data: 前缀） */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('读取文件失败，换一个试试'))
    reader.readAsDataURL(file)
  })
}
