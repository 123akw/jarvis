import { csrfHeaders } from '../api.js'

/* 管理后台的接口封装（第二十轮契约 docs/proposals/2026-10-round20-flows-ops.md §5，仅 Owner）。
 * 约定与 flows/api.js 一致：401 抛 Error('401') 交给页面调 onExpired；其余错误一律换成人话。
 * 返回值都先过一遍 normalize：缺字段补默认值，页面不用到处判空。 */

function httpError(status, reason) {
  if (status === 403) return reason || '只有管理员能看管理后台'
  if (status === 404) return reason || '服务端还没有这项功能，可能需要先更新'
  if (status === 429) return '操作太频繁了，请稍等片刻再试'
  if (status >= 500) return reason || '服务暂时不可用，请稍后再试'
  return reason || `请求没成功（HTTP ${status}）`
}

/** fetch 抛出的 TypeError 是网络层失败（断网 / 服务没起来），说人话；主动取消原样抛 */
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
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const list = v => (Array.isArray(v) ? v : [])

/** 顶栏的范围切换；today 按 days=1 取（契约写的是 7|30，「今天」需要服务端也接 1） */
export const RANGES = [
  { id: 'today', days: 1, label: '今天', short: '今天' },
  { id: '7d', days: 7, label: '近 7 天', short: '7 天' },
  { id: '30d', days: 30, label: '近 30 天', short: '30 天' },
]
export const rangeOf = id => RANGES.find(r => r.id === id) || RANGES[1]

/** 契约 §5 的默认配额（服务端没告诉我们当前默认值时，界面上按这个说） */
export const CONTRACT_DEFAULTS = { daily_model_calls: 300, daily_flow_runs: 100 }
export const QUOTA_FIELDS = ['daily_model_calls', 'daily_flow_runs']

function normalizeQuota(q) {
  const quota = q && typeof q === 'object' ? q : {}
  const out = { source: quota.source || 'default' }
  for (const f of QUOTA_FIELDS) out[f] = quota[f] === null || quota[f] === undefined ? null : num(quota[f])
  if (quota.sources && typeof quota.sources === 'object') out.sources = { ...quota.sources }
  return out
}

function normalizeAccount(a) {
  return {
    user_id: String(a?.user_id ?? ''),
    username: String(a?.username || ''),
    role: a?.role || '',
    platform: a?.platform && a.platform.name ? { name: String(a.platform.name), icon: a.platform.icon || '' } : null,
    calls: num(a?.calls),
    tokens: num(a?.tokens),
    cost_yuan: num(a?.cost_yuan),
    flow_runs: num(a?.flow_runs),
    flow_failures: num(a?.flow_failures),
    today: { calls: num(a?.today?.calls), flow_runs: num(a?.today?.flow_runs) },
    quota: normalizeQuota(a?.quota),
    last_active_at: a?.last_active_at || null,
  }
}

/** 当前的默认配额：服务端给了 quota_defaults 就用；否则从「用默认」的账号身上读；再不行按契约默认值 */
function quotaDefaults(data, accounts) {
  const given = data?.quota_defaults || data?.defaults
  const out = { ...CONTRACT_DEFAULTS }
  for (const f of QUOTA_FIELDS) {
    if (given && Number.isFinite(Number(given[f]))) { out[f] = Number(given[f]); continue }
    const seen = accounts.find(a => (a.quota.sources?.[f] || a.quota.source) === 'default' && a.quota[f] !== null)
    if (seen) out[f] = seen.quota[f]
  }
  return out
}

export function normalizeUsage(data, days = 7) {
  const t = data?.totals || {}
  const accounts = list(data?.accounts).map(normalizeAccount)
  return {
    range: data?.range || { days },
    totals: {
      calls: num(t.calls), input_tokens: num(t.input_tokens), output_tokens: num(t.output_tokens),
      cost_yuan: num(t.cost_yuan), flow_runs: num(t.flow_runs), flow_failures: num(t.flow_failures),
      active_accounts: num(t.active_accounts),
    },
    daily: list(data?.daily).map(d => ({
      day: String(d?.day || ''), calls: num(d?.calls), tokens: num(d?.tokens), cost_yuan: num(d?.cost_yuan),
      flow_runs: num(d?.flow_runs), flow_failures: num(d?.flow_failures),
    })).filter(d => d.day).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    by_kind: list(data?.by_kind).map(k => ({
      kind: String(k?.kind || 'other'), label: k?.label || '', calls: num(k?.calls), tokens: num(k?.tokens), cost_yuan: num(k?.cost_yuan),
    })),
    accounts,
    pricing: {
      input_per_m: data?.pricing?.input_per_m ?? null,
      output_per_m: data?.pricing?.output_per_m ?? null,
      note: data?.pricing?.note || '',
    },
    defaults: quotaDefaults(data, accounts),
  }
}

/** GET /api/admin/usage?days=1|7|30 */
export async function getUsage(days = 7, { signal } = {}) {
  const data = await request(`/api/admin/usage?days=${encodeURIComponent(days)}`, { signal })
  return normalizeUsage(data, days)
}

/** PUT /api/admin/quotas/{user_id}：每项 null=用默认、正整数=自定义、UNLIMITED=不限 → 新的 quota */
export async function saveQuota(userId, body) {
  const data = await request(`/api/admin/quotas/${encodeURIComponent(userId)}`, {
    method: 'PUT', headers: json(), body: JSON.stringify(body),
  })
  return normalizeQuota(data.quota || body)
}

function normalizeAlert(a) {
  return {
    id: String(a?.id ?? ''),
    kind: String(a?.kind || ''),
    title: String(a?.title || ''),
    detail: String(a?.detail || ''),
    owner: a?.owner && a.owner.username ? { id: a.owner.id, username: String(a.owner.username) } : null,
    created_at: a?.created_at || '',
    read: Boolean(a?.read),
  }
}

/** GET /api/admin/alerts?limit= → { alerts, unread } */
export async function getAlerts(limit = 50, { signal } = {}) {
  const data = await request(`/api/admin/alerts?limit=${encodeURIComponent(limit)}`, { signal })
  const alerts = list(data.alerts).map(normalizeAlert)
  const unread = Number.isFinite(Number(data.unread)) ? Number(data.unread) : alerts.filter(a => !a.read).length
  return { alerts, unread }
}

/** POST /api/admin/alerts/read：{ ids: [...] } 标几条，{ all: true } 全部 */
export async function markAlertsRead({ ids, all } = {}) {
  const body = all ? { all: true } : { ids: list(ids).map(String) }
  return request('/api/admin/alerts/read', { method: 'POST', headers: json(), body: JSON.stringify(body) })
}
