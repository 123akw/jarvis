/* 管理后台的纯函数：数字 / 金额 / 时间的写法、配额三种模式的换算、账号的搜索与排序、类别归并。
 * 都不碰 DOM，单测直接测。 */

/* ---------- 数字与金额 ---------- */

/** 12345 → 「12,345」 */
export function fmtInt(n) {
  const v = Math.round(Number(n) || 0)
  return v.toLocaleString('zh-CN')
}

const trim = s => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')

/** 大数按中文习惯缩写：9,999 以内原样，往上「1.2 万」「3.4 亿」 */
export function fmtCompact(n) {
  const v = Number(n) || 0
  const a = Math.abs(v)
  if (a < 10000) return fmtInt(v)
  if (a < 1e8) return `${trim((v / 1e4).toFixed(a < 1e5 ? 1 : 0))} 万`
  return `${trim((v / 1e8).toFixed(a < 1e9 ? 2 : 1))} 亿`
}

/** 估算花费（元）：0 → ¥0；不到 1 分 → <¥0.01；千元以内两位小数；再往上取整加千分位 */
export function fmtYuan(n) {
  const v = Number(n) || 0
  if (v === 0) return '¥0'
  if (v > 0 && v < 0.01) return '<¥0.01'
  if (Math.abs(v) < 1000) return `¥${v.toFixed(2)}`
  return `¥${Math.round(v).toLocaleString('zh-CN')}`
}

/** 比例 → 百分比；没有分母时 null → 「—」 */
export function fmtPct(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—'
  if (ratio > 0 && ratio < 0.001) return '<0.1%'
  return `${trim((ratio * 100).toFixed(1))}%`
}

export const failRate = (runs, failures) => (runs > 0 ? Math.min(1, failures / runs) : null)

/* ---------- 日期与时间 ---------- */

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 'YYYY-MM-DD' 按本地日期解析（new Date('2026-10-03') 是 UTC 零点，东八区会差一天） */
export function parseDay(day) {
  const m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

const sameDate = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** 坐标轴上的短日期：「10/3」；今天写「今天」 */
export function dayShort(day, now = new Date()) {
  const d = parseDay(day)
  if (!d) return String(day || '')
  if (sameDate(d, now)) return '今天'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 提示框里的完整日期：「10月3日 周五」，今天加「（今天）」 */
export function dayLong(day, now = new Date()) {
  const d = parseDay(day)
  if (!d) return String(day || '')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}${sameDate(d, now) ? '（今天）' : ''}`
}

/** 范围副标题：今天「10月3日」；多天「9月27日 – 10月3日」 */
export function rangeText(days, now = new Date()) {
  const md = d => `${d.getMonth() + 1}月${d.getDate()}日`
  if (days <= 1) return `今天 · ${md(now)}`
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return `${md(start)} – ${md(now)}`
}

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 昨天 14:20 / 3 天前 / 9月12日；没有 → 「还没用过」 */
export function relTime(iso, now = new Date()) {
  if (!iso) return '还没用过'
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '还没用过'
  const s = Math.max(0, (now.getTime() - t.getTime()) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (s < 86400 && sameDate(t, now)) return `${Math.floor(s / 3600)} 小时前`
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  if (sameDate(t, yesterday)) return `昨天 ${hm}`
  if (s < 7 * 86400) return `${Math.max(2, Math.round(s / 86400))} 天前`
  return t.getFullYear() === now.getFullYear()
    ? `${t.getMonth() + 1}月${t.getDate()}日`
    : `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`
}

/* ---------- 类别 ---------- */

export const KINDS = [
  { kind: 'chat', label: '对话' },
  { kind: 'flow', label: '流程' },
  { kind: 'compose', label: '一句话生成' },
  { kind: 'voice', label: '语音' },
  { kind: 'other', label: '其他' },
]

/** 服务端的 by_kind → 固定顺序的五类（认不出的类别并进「其他」），带占比 */
export function kindRows(byKind) {
  const rows = KINDS.map(k => ({ ...k, calls: 0, tokens: 0, cost_yuan: 0 }))
  const at = Object.fromEntries(rows.map(r => [r.kind, r]))
  for (const k of Array.isArray(byKind) ? byKind : []) {
    const known = at[k.kind]
    const row = known || at.other
    if (known && k.label) row.label = k.label
    row.calls += Number(k.calls) || 0
    row.tokens += Number(k.tokens) || 0
    row.cost_yuan += Number(k.cost_yuan) || 0
  }
  const total = rows.reduce((s, r) => s + r.calls, 0)
  return rows.map(r => ({ ...r, share: total ? r.calls / total : 0 }))
}

/* ---------- 配额 ---------- */

/** PUT 里表示「不限」的值。契约只写了 int|null（null=用默认），没写不限怎么传：先用 -1，待主控与用量代理确认 */
export const UNLIMITED = -1

export const QUOTA_LABELS = {
  daily_model_calls: { title: '每天的模型调用', unit: '次', short: '调用' },
  daily_flow_runs: { title: '每天的流程运行', unit: '次', short: '流程' },
}

export const isOwner = account => account?.role === 'Owner'

/** 某一项配额现在是哪种模式：'unlimited' | 'default' | 'custom'。
 *  服务端若给了逐项的 quota.sources 就按它；否则用整体的 quota.source（契约只有这一个）。 */
export function quotaMode(quota, field, account = null) {
  if (account && isOwner(account)) return 'unlimited'
  const src = quota?.sources?.[field] || quota?.source || 'default'
  const v = quota?.[field]
  if (src === 'unlimited' || (typeof v === 'number' && v < 0)) return 'unlimited'
  if (src === 'custom' && typeof v === 'number') return 'custom'
  return 'default'
}

/** 今天的上限（数字），不限返回 null */
export function quotaLimit(quota, field, account = null, defaults = {}) {
  const mode = quotaMode(quota, field, account)
  if (mode === 'unlimited') return null
  const v = quota?.[field]
  if (typeof v === 'number' && v >= 0) return v
  return Number.isFinite(defaults[field]) ? defaults[field] : null
}

/** 弹层里一项的选择 → PUT 的值；自定义不合法时返回 undefined（由表单提示） */
export function quotaValue(choice) {
  if (choice.mode === 'unlimited') return UNLIMITED
  if (choice.mode === 'default') return null
  const s = String(choice.value ?? '').trim()
  if (!/^\d+$/.test(s)) return undefined
  const n = Number(s)
  return n >= 1 && n <= 100000 ? n : undefined
}

/** 进度条的语气：<80% 平常，80–99% 提醒，用满了告急 */
export function meterTone(used, limit) {
  if (limit === null || limit === undefined) return 'free'
  if (limit <= 0 || used >= limit) return 'full'
  return used / limit >= 0.8 ? 'warn' : 'ok'
}

/* ---------- 账号：搜索与排序 ---------- */

export const SORTS = [
  { id: 'usage', label: '用量' },
  { id: 'cost', label: '花费' },
  { id: 'failures', label: '失败' },
  { id: 'recent', label: '最近活跃' },
]

const lastActive = a => {
  const t = a.last_active_at ? new Date(a.last_active_at).getTime() : NaN
  return Number.isNaN(t) ? -Infinity : t
}

const SORT_KEYS = {
  usage: a => [a.calls, a.tokens],
  cost: a => [a.cost_yuan, a.calls],
  failures: a => [a.flow_failures, a.flow_runs],
  recent: a => [lastActive(a), a.calls],
}

/** 搜账号名 / 智能体名（不分大小写），再按选的维度从大到小排；并列按账号名 */
export function sortAccounts(accounts, { query = '', sort = 'usage' } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const keyOf = SORT_KEYS[sort] || SORT_KEYS.usage
  return (Array.isArray(accounts) ? accounts : [])
    .filter(a => !q || a.username.toLowerCase().includes(q) || (a.platform?.name || '').toLowerCase().includes(q))
    .map(a => ({ a, k: keyOf(a) }))
    .sort((x, y) => (y.k[0] - x.k[0]) || (y.k[1] - x.k[1]) || x.a.username.localeCompare(y.a.username, 'zh-CN'))
    .map(x => x.a)
}

/* ---------- 告警 ---------- */

/** 告警类别 → 图标与一句话类别名（kind 由用量代理定，这里按关键字宽松匹配） */
export function alertKind(kind) {
  const k = String(kind || '').toLowerCase()
  if (/pause|schedule/.test(k)) return { icon: 'flow', label: '定时流程' }
  if (/fail|error/.test(k)) return { icon: 'flow', label: '流程失败' }
  if (/feishu|wechat|channel|disconnect|offline/.test(k)) return { icon: 'bubble', label: '渠道断开' }
  if (/quota|limit/.test(k)) return { icon: 'sliders', label: '配额' }
  return { icon: 'help', label: '提醒' }
}
