/* 市场页的纯数据部分：主题色 / 图标预设、目录容错归一、草稿的 sessionStorage 读写。 */

/** 六个主题色预设（与平台后端、主页共用同一组；契约 PlatformIn.accent 只收这六个；目录若带 accents 字段以目录为准） */
export const ACCENTS = [
  { hex: '#0A84FF', name: '晴空蓝' },
  { hex: '#5E5CE6', name: '靛紫' },
  { hex: '#30B0C7', name: '湖青' },
  { hex: '#34C759', name: '薄荷绿' },
  { hex: '#FF9F0A', name: '琥珀橙' },
  { hex: '#FF375F', name: '玫红' },
]

/** 精选图标：一屏两行，覆盖常见职业与气质 */
export const ICONS = ['✨', '🤖', '🌙', '🧋', '🍜', '🛍️', '💼', '📚', '🎨', '🎬', '🏡', '🌿', '🚀', '🎯', '💡', '🐱']

export const CATEGORY_FALLBACK = [
  { id: 'efficiency', name: '效率' }, { id: 'communication', name: '沟通' }, { id: 'documents', name: '资料' },
  { id: 'info', name: '资讯' }, { id: 'life', name: '生活' }, { id: 'ai', name: 'AI 处理' }, { id: 'output', name: '输出' },
]

export const NAME_MAX = 20
export const TAGLINE_MAX = 40
export const DESC_MAX = 300

const REQUIRE_TEXT = { feishu_bound: '需绑定飞书', wechat_owner: '需管理员开通微信', desktop: '需电脑端' }
export const requireText = id => REQUIRE_TEXT[id] || '需要额外设置'

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback)
const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const HEX = /^#[0-9a-f]{6}$/i

function normPlugin(p) {
  if (!p || typeof p !== 'object' || !str(p.id)) return null
  return {
    id: p.id,
    name: str(p.name, p.id),
    icon: str(p.icon) || '🧩',
    category: str(p.category, 'other'),
    summary: str(p.summary),
    kind: ['tool', 'channel', 'step'].includes(p.kind) ? p.kind : 'tool',
    requires: strList(p.requires),
    tier: p.tier === 'pro' ? 'pro' : 'free',
    price: Number.isFinite(p.price) ? p.price : 0,
    examples: strList(p.examples),
    available: p.available !== false,
  }
}

export function normFlow(f) {
  if (!f || typeof f !== 'object') return null
  const steps = Array.isArray(f.steps) ? f.steps.filter(s => s && typeof s.plugin === 'string') : []
  return { id: str(f.id) || str(f.name), name: str(f.name, '推荐流程'), summary: str(f.summary), steps }
}

function normProfession(p) {
  if (!p || typeof p !== 'object' || !str(p.id)) return null
  const home = p.home && typeof p.home === 'object' ? p.home : {}
  return {
    id: p.id,
    name: str(p.name, p.id),
    icon: str(p.icon) || '🙂',
    summary: str(p.summary),
    plugins: strList(p.plugins),
    flows: (Array.isArray(p.flows) ? p.flows : []).map(normFlow).filter(Boolean),
    home: { greeting: str(home.greeting), chips: strList(home.chips).slice(0, 4) },
  }
}

/** 目录容错：缺字段补默认、未知字段忽略、未知分类归到「其他」 */
export function normalizeCatalog(raw) {
  const data = raw && typeof raw === 'object' ? raw : {}
  const plugins = (Array.isArray(data.plugins) ? data.plugins : []).map(normPlugin).filter(Boolean)
  let categories = (Array.isArray(data.categories) ? data.categories : [])
    .filter(c => c && str(c.id)).map(c => ({ id: c.id, name: str(c.name, c.id) }))
  if (!categories.length) categories = CATEGORY_FALLBACK
  const known = new Set(categories.map(c => c.id))
  if (plugins.some(p => !known.has(p.category))) {
    categories = [...categories, { id: 'other', name: '其他' }]
    plugins.forEach(p => { if (!known.has(p.category)) p.category = 'other' })
  }
  const accents = (Array.isArray(data.accents) ? data.accents : [])
    .map(a => (typeof a === 'string' ? { hex: a, name: '' } : { hex: str(a?.hex || a?.color), name: str(a?.name) }))
    .filter(a => HEX.test(a.hex))
  return {
    categories: categories.filter(c => plugins.some(p => p.category === c.id)),
    plugins,
    professions: (Array.isArray(data.professions) ? data.professions : []).map(normProfession).filter(Boolean),
    signup: ['off', 'invite', 'open'].includes(data.signup) ? data.signup : 'off',
    accents: accents.length >= 2 ? accents.slice(0, 6) : ACCENTS,
  }
}

export function normalizeRecommendation(raw) {
  const data = raw && typeof raw === 'object' ? raw : {}
  return {
    plugins: strList(data.plugins),
    flows: (Array.isArray(data.flows) ? data.flows : []).map(normFlow).filter(Boolean),
    reason: str(data.reason),
    source: data.source === 'model' ? 'model' : 'rules',
  }
}

/** 推荐里「一键全部加入」要装的：推荐插件 + 推荐流程用到的积木 */
export function recommendedIds(rec) {
  if (!rec) return []
  const ids = [...rec.plugins]
  rec.flows.forEach(f => f.steps.forEach(s => ids.push(s.plugin)))
  return [...new Set(ids)]
}

/* ---------- 草稿（刷新不丢）：sessionStorage，读写都包 try/catch；口令永不落盘 ---------- */
export const DRAFT_KEY = 'jv_market_draft'
export const STEPS = ['market', 'brand', 'done']

export function emptyDraft() {
  return {
    step: 'market', picked: [], profession: '', description: '', recommendation: null,
    brand: { name: '', tagline: '', icon: ICONS[0], accent: ACCENTS[0].hex },
    done: null,   // 生成成功后的智能体与账号名（不含口令），刷新后还能看到账号和装了哪些插件
  }
}

export function loadDraft() {
  const base = emptyDraft()
  let raw = null
  try { raw = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null') } catch { raw = null }
  if (!raw || typeof raw !== 'object') return base
  const brand = raw.brand && typeof raw.brand === 'object' ? raw.brand : {}
  const done = raw.done && typeof raw.done === 'object' && raw.done.platform && typeof raw.done.platform === 'object'
    ? { platform: raw.done.platform, username: str(raw.done.username) } : null
  const step = STEPS.includes(raw.step) ? raw.step : base.step
  return {
    step: step === 'done' && !done ? base.step : step,
    picked: [...new Set(strList(raw.picked))],
    profession: str(raw.profession),
    description: str(raw.description).slice(0, DESC_MAX),
    recommendation: raw.recommendation ? normalizeRecommendation(raw.recommendation) : null,
    brand: {
      name: str(brand.name).slice(0, NAME_MAX),
      tagline: str(brand.tagline).slice(0, TAGLINE_MAX),
      icon: str(brand.icon) || base.brand.icon,
      accent: HEX.test(brand.accent || '') ? brand.accent : base.brand.accent,
    },
    done,
  }
}

export function saveDraft(draft) {
  try {
    const { done, ...rest } = draft
    // 结果页只留平台信息，口令只活在内存里
    const safe = { ...rest, done: done?.platform ? { platform: done.platform, username: done.username || '' } : null }
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(safe))
  } catch { /* 隐私模式等写不进：只在本次生效 */ }
}

export function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY) } catch { /* 同上 */ }
}

/** 登录页地址（带 ?u= 预填账号）：结果页「去登录」和「在手机上打开」二维码共用 */
export function loginPath(username) {
  return username ? `/?u=${encodeURIComponent(username)}` : '/'
}

export function greetingFor(name, profession) {
  const given = profession?.home?.greeting
  if (given) return given
  const h = new Date().getHours()
  const part = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
  return `${part}，我是${name || '你的智能体'}。`
}
