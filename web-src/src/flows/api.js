import { csrfHeaders } from '../api.js'

/* 流程页的接口封装（第十八轮节点图契约见 docs/proposals/2026-10-round18-flows.md §3，文件末尾「v2」一节；
 * 第二十轮的发送前确认 / 单节点试跑 / 重跑 / 触发方式见 docs/proposals/2026-10-round20-flows-ops.md §3、§4.2、§4.3）。
 * 约定与 ../api.js 一致：401 抛 Error('401') 交给页面调 onExpired；其余错误一律换成人话。 */

/** HTTP 状态 → 人话；服务端给了原因（error 字段）优先用它。fallback 按状态码覆盖默认说法（比如确认页的 404 / 409） */
function httpError(status, reason, fallback = {}) {
  if (status === 403) return reason || fallback[403] || '登录状态校验没通过，请刷新页面后再试'
  if (status === 404) return reason || fallback[404] || '这个流程不见了，可能已经删掉了'
  if (status === 409) return reason || fallback[409] || '这个流程正在运行，等这次跑完再试'
  if (status === 410) return reason || fallback[410] || '这个流程已经删掉或关掉了'
  if (status === 413) return '文件太大了，请换一个 10MB 以内的'
  // 429：限流，或今天的用量到上限了（第二十轮配额）——服务端会说清是哪种
  if (status === 429) return reason || '操作太频繁了，请稍等片刻再试'
  if (status >= 500) return reason || '服务暂时不可用，请稍后再试'
  return reason || fallback[status] || `请求没成功（HTTP ${status}）`
}

/** fetch 抛出的 TypeError 是网络层失败（断网 / 服务没起来），说人话 */
function netError(err) {
  if (err?.name === 'AbortError') return err
  return err instanceof TypeError ? new Error('网络连不上，请检查网络后再试') : err
}

async function request(url, init, fallback) {
  let r
  try { r = await fetch(url, init) } catch (err) { throw netError(err) }
  if (r.status === 401) throw new Error('401')
  let data = null
  try { data = await r.json() } catch { /* 网关错误页不是 JSON */ }
  if (!r.ok) {
    throw Object.assign(new Error(httpError(r.status, data?.error || '', fallback)), { status: r.status, code: data?.code || '', data })
  }
  return data || {}
}

const json = () => ({ 'Content-Type': 'application/json', ...csrfHeaders() })

export async function listFlows() {
  const data = await request('/api/flows')
  return Array.isArray(data.flows) ? data.flows : []
}

export async function deleteFlow(id) {
  return request(`/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE', headers: csrfHeaders() })
}

/** 最近几次运行（契约 §3.3：{runs: [{id, status, started_at, finished_at, ms, input_summary, nodes, output_text, page_url, error}]}）；
 *  兼容直接返回数组的写法 */
export async function listRuns(id, limit = 20) {
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

/** POST 后按 SSE 逐个产出事件（运行 / 重跑共用） */
async function* streamPost(url, body, signal) {
  let r
  try {
    r = await fetch(url, { method: 'POST', headers: json(), body: JSON.stringify(body), signal })
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

/* ---------- v2：节点图（第十八轮） ---------- */

const flowUrl = id => `/api/flows/${encodeURIComponent(id)}`

/** 节点目录：{ groups: [{ id, label, items: [节点模板] }], vars: { sys: [...] } }（契约 §3.2） */
export function getNodeCatalog() {
  return request('/api/flows/nodes')
}

/** 一条流程（含节点图）：{ id, name, summary, graph, trigger, updated_at } */
export async function getFlow(id) {
  return (await request(flowUrl(id))).flow
}

/** 保存：没有 id 新建（POST），有 id 覆盖（PUT）。返回服务端规整后的 flow */
export async function saveFlow({ id = '', name, summary = '', graph }) {
  const body = JSON.stringify({ name, summary, graph })
  const data = id
    ? await request(flowUrl(id), { method: 'PUT', headers: json(), body })
    : await request('/api/flows', { method: 'POST', headers: json(), body })
  return data.flow
}

/** 模板库：{ categories: [{ id, label }], templates: [{ id, name, summary, category, icon, plugins, graph, needs }] } */
export function getTemplates() {
  return request('/api/flows/templates')
}

/** 一句话生成流程草稿（不落库）：{ draft: { name, summary, graph }, notes: [人话说明], source: 'model'|'template' }。
 *  signal 用于用户点「取消」时中止 */
export function composeFlow(description, signal = undefined) {
  return request('/api/flows/compose', { method: 'POST', headers: json(), body: JSON.stringify({ description }), signal })
}

/** 定时运行：{ trigger: { kind, schedule, inputs, notify, enabled, next_run_at, last_run_at, last_status } | null } */
export async function getTrigger(id) {
  return (await request(`${flowUrl(id)}/trigger`)).trigger || null
}

export async function setTrigger(id, trigger) {
  return (await request(`${flowUrl(id)}/trigger`, { method: 'PUT', headers: json(), body: JSON.stringify(trigger) })).trigger || null
}

/**
 * 运行节点图流程：inputs 按开始节点的字段 key 给值（文件给 { name, data_base64 }）。
 * 逐个产出事件 {type:'run_start'|'node_start'|'node_done'|'node_skip'|'node_error'|'run_done', …}（契约 §3.4）。
 */
export async function* runGraph(id, inputs = {}, signal = null) {
  yield* streamPost(`${flowUrl(id)}/run`, { inputs }, signal)
}

/** 飞书绑定情况（定时运行的通知渠道用）：{ configured, bound }；读不到（接口出错）按没绑定处理，401 照常抛 */
export async function getFeishuStatus() {
  try {
    const s = await request('/api/feishu/status')
    return { configured: s.configured !== false, bound: Boolean(s.bound) }
  } catch (err) {
    if (err.message === '401') throw err
    return { configured: true, bound: false }
  }
}

/* ---------- 第二十轮：运行详情 / 试跑一步 / 重跑 ---------- */

const enc = encodeURIComponent

/** 单次运行详情（与运行记录列表项同结构）：确认页轮询「接着跑」、画布等确认时据此更新。兼容 {run} 与直接返回 */
export async function getRun(id, runId) {
  const data = await request(`${flowUrl(id)}/runs/${enc(runId)}`)
  return data.run || (data.id || data.status ? data : null)
}

/**
 * 只跑一个节点（契约 §3.2）：上游产出取最近一次运行；inputs 用来补开始节点的输入。
 * 返回 { status: 'ok'|'error', ms, output: { text, items, links }, note, error }；不写运行记录。
 */
export function testNode(id, nodeId, inputs = null) {
  const body = inputs && Object.keys(inputs).length ? { inputs } : {}
  return request(`${flowUrl(id)}/nodes/${enc(nodeId)}/test`, { method: 'POST', headers: json(), body: JSON.stringify(body) })
}

/** 用某次运行保存的输入再跑一遍（契约 §3.3），事件与 runGraph 相同 */
export async function* rerunGraph(id, runId, signal = null) {
  yield* streamPost(`${flowUrl(id)}/runs/${enc(runId)}/rerun`, {}, signal)
}

/* ---------- 第二十轮：发送前确认（契约 §3.1） ---------- */

const APPROVAL_ERR = {
  404: '找不到这条确认，可能已经处理过、过期清掉了，或者不是发给你的',
  409: '这条已经处理过了，或者已经过期',
}

/** 我的确认：{ approvals: [{ id, flow: {id, name}, run_id, node_id, title, preview, status, created_at, expires_at }], pending } */
export async function listApprovals({ status = 'pending', limit = 20 } = {}) {
  const data = await request(`/api/approvals?status=${enc(status)}&limit=${limit}`)
  const approvals = Array.isArray(data.approvals) ? data.approvals.filter(a => a && a.id) : []
  const pending = Number.isFinite(Number(data.pending)) ? Number(data.pending) : approvals.filter(a => a.status === 'pending').length
  return { approvals, pending }
}

/** 一条确认的详情：{ ..., content, editable, next: [{ title, node_type }], source } */
export async function getApproval(id) {
  return (await request(`/api/approvals/${enc(id)}`, undefined, APPROVAL_ERR)).approval || null
}

/** 同意（可带改过的内容）/ 拒绝（可带原因）：→ { approval, run: { id, status } } */
export function decideApproval(id, { decision, content, note } = {}) {
  const body = { decision }
  if (decision === 'approve' && typeof content === 'string') body.content = content
  if (decision === 'reject' && String(note || '').trim()) body.note = String(note).trim()
  return request(`/api/approvals/${enc(id)}`, { method: 'POST', headers: json(), body: JSON.stringify(body) }, APPROVAL_ERR)
}

/* ---------- 第二十轮：触发方式——收到消息 / 通过链接（契约 §4.2、§4.3） ---------- */

/** { message: {...} | null, webhook: {...} | null, channels: { feishu: {ready, reason}, wechat: {ready, reason} } } */
export async function getHooks(id) {
  const data = await request(`${flowUrl(id)}/hooks`)
  return {
    message: data.message || null,
    webhook: data.webhook || null,
    channels: data.channels && typeof data.channels === 'object' ? data.channels : {},
  }
}

/** 保存「收到消息时」：{ enabled, channels, match: 'all'|'keywords', keywords, input_field }；返回保存后的设置 */
export async function setMessageHook(id, message) {
  const data = await request(`${flowUrl(id)}/hooks/message`, { method: 'PUT', headers: json(), body: JSON.stringify(message) })
  return data.message !== undefined ? data.message : (data.enabled !== undefined ? data : message)
}

/** 生成 / 重置链接：{ webhook, url }——完整地址只这一次给，之后看不到 */
export function createWebhook(id) {
  return request(`${flowUrl(id)}/hooks/webhook`, { method: 'POST', headers: json(), body: '{}' })
}

/** 关掉链接触发（旧地址立刻失效） */
export function deleteWebhook(id) {
  return request(`${flowUrl(id)}/hooks/webhook`, { method: 'DELETE', headers: csrfHeaders() })
}
