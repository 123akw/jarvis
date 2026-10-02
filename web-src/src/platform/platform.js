/* 「自己的平台」（第十三轮）：账号拼好的平台——品牌、主题色、插件、主页问候、分享链接。
 * 接口契约见 docs/proposals/2026-10-round13-platform.md §4.2；这里只放纯函数和接口调用，界面在同目录的组件里。 */
import { csrfHeaders } from '../api.js'

/** 六个主题色预设（PlatformIn.accent 只收这六个）。后端返回了表外的色值也照常使用，设置里会把它补成第七个选项。 */
export const PLATFORM_ACCENTS = [
  { name: '晴空蓝', hex: '#0A84FF' },
  { name: '靛紫', hex: '#5E5CE6' },
  { name: '湖青', hex: '#30B0C7' },
  { name: '薄荷绿', hex: '#34C759' },
  { name: '琥珀橙', hex: '#FF9F0A' },
  { name: '玫红', hex: '#FF375F' },
]
export const DEFAULT_ACCENT = PLATFORM_ACCENTS[0].hex

/** 平台图标：精选 emoji（职业 / 场景各一组，够挑又不至于翻页） */
export const PLATFORM_ICONS = [
  '📋', '🗂️', '📈', '💼', '🤝', '🎯', '🛍️', '🧋',
  '🎓', '📚', '✍️', '🎬', '🏠', '🌱', '⚡️', '✨',
]

/** 目录接口拿不到时的兜底：插件 id → 名称 / 图标 / 示例问题（以 GET /api/market/catalog 为准） */
const PLUGIN_FALLBACK = {
  schedule: ['日程助手', '📅', '明天下午3点和客户开会'],
  todo: ['待办清单', '✅', '还有哪些待办没做完？'],
  memo: ['随手记', '📝', '记一条备忘：'],
  memory: ['懂你的记忆', '🧠', '记住我周一上午不排会'],
  weather: ['天气', '🌤️', '今天天气怎么样？'],
  search: ['联网搜索', '🔎', '帮我查查最近的行业新闻'],
  recall: ['翻旧账', '🕰️', '上次聊到的预算是多少？'],
  movies: ['影视评分', '🎬', '最近有什么高分电影？'],
  esports: ['电竞比分', '🎮', '今晚有什么比赛？'],
  tickets: ['票务比价', '🎫', '下周去上海的高铁票'],
  meeting: ['会议纪要', '🎙️', '开始记会议纪要'],
  feishu: ['飞书', '🪶', '', 'channel'],
  wechat: ['微信技能包', '💬', '', 'channel'],
  input_text: ['文字输入', '⌨️', '', 'step'],
  input_file: ['资料上传', '📎', '', 'step'],
  split_file: ['文件拆分', '✂️', '', 'step'],
  ai_extract: ['AI 提炼', '✨', '', 'step'],
  to_todo: ['加到待办', '☑️', '', 'step'],
  feishu_send: ['发到飞书', '📨', '', 'step'],
  feishu_doc: ['汇总到飞书文档', '📄', '', 'step'],
  wechat_send: ['发到微信', '💬', '', 'step'],
  web_page: ['生成网页与二维码', '🔗', '', 'step'],
}

/** 插件元信息：目录里有就用目录的，没有用兜底表，再没有就用 id 本身 */
export function pluginMeta(id, byId = null) {
  const p = byId?.[id]
  const [name, icon, example, kind = 'tool'] = PLUGIN_FALLBACK[id] || [id, '🧩', '']
  return {
    id,
    name: p?.name || name,
    icon: p?.icon || icon,
    kind: p?.kind || kind,
    summary: p?.summary || '',
    examples: Array.isArray(p?.examples) ? p.examples : example ? [example] : [],
  }
}

/** 主页快捷问题：先取平台插件的示例（带插件图标和名字），再用职业主页的 chips 补齐，去重，最多 max 条 */
export function homeChips(platform, byId = null, max = 4) {
  const out = []
  const seen = new Set()
  const push = (text, hint = '', icon = '') => {
    const t = String(text || '').trim()
    if (!t || seen.has(t) || out.length >= max) return
    seen.add(t)
    out.push({ text: t, hint, icon })
  }
  for (const id of platform?.plugins || []) {
    const m = pluginMeta(id, byId)
    if (m.kind === 'step') continue
    push(m.examples[0], m.name, m.icon)
  }
  for (const c of platform?.home?.chips || []) {
    if (typeof c === 'string') push(c)
    else if (c) push(c.text, c.hint, c.icon)
  }
  return out
}

function timeGreeting(now = new Date()) {
  const h = now.getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/** 主页问候：职业主页给的 greeting 优先，否则按平台名生成 */
export function homeGreeting(platform, now = new Date()) {
  const g = String(platform?.home?.greeting || '').trim()
  if (g) return g
  return `${timeGreeting(now)}，欢迎回到${platform?.name || '你的平台'}`
}

/** 平台的公开链接：接口给了绝对地址就用它，否则按当前站点拼 /p/<slug> */
export function platformLink(platform) {
  if (platform?.url && /^https?:\/\//.test(platform.url)) return platform.url
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/p/${encodeURIComponent(platform?.slug || '')}`
}

/* ---------------- 颜色：主题色 → 深浅两套 token ---------------- */

const HEX_RE = /^#?([0-9a-f]{6})$/i

export function normalizeHex(hex, fallback = DEFAULT_ACCENT) {
  const m = HEX_RE.exec(String(hex || '').trim())
  return m ? `#${m[1].toUpperCase()}` : fallback
}
const toRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const toHex = rgb => `#${rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`
/** a、b 线性混合，t 是 b 的占比 */
export const mixHex = (a, b, t) => toHex(toRgb(a).map((v, i) => v + (toRgb(b)[i] - v) * t))

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

function hueShift(hex, deg, light = 0) {
  const [r, g, b] = toRgb(hex).map(v => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  h = (h * 60 + deg + 360) % 360
  const l2 = Math.min(0.9, Math.max(0.1, l + light))
  const c = (1 - Math.abs(2 * l2 - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l2 - c / 2
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return toHex([r1, g1, b1].map(v => (v + m) * 255))
}

const LIGHT_BG = '#F5F5F7'
const DARK_BG = '#0B0B0F'
/** 主色上的文字 / 图标：白字够清楚（≥3:1，图标与粗体按钮字）就用白，否则用近黑 */
const onColor = hex => (contrast(hex, '#FFFFFF') >= 3 ? '#FFFFFF' : '#16161A')

/**
 * 一个主题色 → 两套主题的 token：
 *  dark  暗色下原色直接用（在深底上本来就亮）；
 *  light 亮色下往黑里压，直到在浅底上 ≥3:1（链接、焦点环、主按钮都要看得清，黄橙绿最需要）；
 *  on    主按钮 / 发送键上的字色；orb 光球四色由主色转色相派生；bar 是地址栏 / 状态栏色（底色里掺一点主色）。
 */
export function accentTokens(hex) {
  const base = normalizeHex(hex)
  let light = base
  for (let t = 0.05; contrast(light, LIGHT_BG) < 3 && t <= 0.6; t += 0.05) light = mixHex(base, '#000000', t)
  return {
    dark: base,
    darkOn: onColor(base),
    light,
    lightOn: onColor(light),
    orb: [base, hueShift(base, 32, 0.06), hueShift(base, -38, 0.02), mixHex(base, '#FFFFFF', 0.5)],
    bar: { dark: mixHex(DARK_BG, base, 0.16), light: mixHex(LIGHT_BG, base, 0.1) },
  }
}

/* ---------------- 接口 ---------------- */

async function parse(response) {
  if (response.status === 401) throw new Error('401')
  let data = {}
  try { data = await response.json() } catch { data = {} }
  if (response.ok === false) {
    const error = new Error(data?.error || '请求失败')
    error.status = response.status
    throw error
  }
  return data
}

const isPlatform = p => Boolean(p && typeof p === 'object' && p.slug && p.name)

/** GET /api/platform → Platform | null（还没有平台、旧服务端没这个接口、任何失败都当没有平台） */
export async function getPlatform() {
  try {
    const data = await parse(await fetch('/api/platform'))
    return isPlatform(data?.platform) ? data.platform : null
  } catch {
    return null
  }
}

/** PUT /api/platform：部分更新，返回更新后的 Platform */
export async function savePlatform(patch) {
  const data = await parse(await fetch('/api/platform', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(patch),
  }))
  return isPlatform(data?.platform) ? data.platform : isPlatform(data) ? data : null
}

/** GET /api/p/{slug}（公开）→ 品牌信息；404 时抛 status=404 */
export async function getPublicPlatform(slug) {
  return parse(await fetch(`/api/p/${encodeURIComponent(slug)}`))
}

/** GET /api/market/catalog（公开）→ 插件 id → Plugin */
export async function getPluginIndex() {
  const data = await parse(await fetch('/api/market/catalog'))
  const out = {}
  for (const p of Array.isArray(data?.plugins) ? data.plugins : []) if (p?.id) out[p.id] = p
  return out
}

/** GET /api/flows → Flow[] */
export async function getFlows() {
  const data = await parse(await fetch('/api/flows'))
  return Array.isArray(data?.flows) ? data.flows : []
}
