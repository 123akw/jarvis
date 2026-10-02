/* 市场页的纯数据部分：主题色 / 图标预设、目录容错归一、搜索与筛选、精选套装、草稿的 sessionStorage 读写。 */
import { loginHref } from '../routes.js'

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

const REQUIRE_TEXT = { feishu_bound: '需绑定飞书', wechat_owner: '需管理员开通微信', desktop: '需电脑端', files: '用到文件空间' }
export const requireText = id => REQUIRE_TEXT[id] || '需要额外设置'
/** 详情页「需要什么」里的一句解释 */
const REQUIRE_HELP = {
  feishu_bound: '登录后在「设置 → 飞书」里绑定一次，智能体才能替你收发飞书消息。',
  wechat_owner: '微信通道只对管理员账号开放，需要管理员先开通。',
  desktop: '要在电脑上装好贾维斯桌面端并保持在线。',
  files: '会读写你在贾维斯里上传的文件，只在你的文件空间里。',
}
export const requireHelp = id => REQUIRE_HELP[id] || '登录后按提示完成设置即可使用。'

/** 类型：工具（含通道）/ 技能 / MCP / 积木。筛选按 group，徽标按 kind */
export const KIND_LABEL = { tool: '工具', channel: '通道', skill: '技能', mcp: 'MCP', step: '积木' }
export const KIND_FILTERS = [
  { id: 'tool', name: '工具' }, { id: 'skill', name: '技能' }, { id: 'mcp', name: 'MCP' }, { id: 'step', name: '积木' },
]
export const SOURCE_FILTERS = [{ id: 'official', name: '官方' }, { id: 'community', name: '社区' }]

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback)
const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const HEX = /^#[0-9a-f]{6}$/i

const objList = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [])

/** 工具清单：老目录是工具名字符串，MCP / 新目录可能带 {name, description} */
function normTools(v) {
  return (Array.isArray(v) ? v : []).map(t => {
    if (typeof t === 'string') return t ? { name: t, description: '' } : null
    if (t && typeof t === 'object' && str(t.name)) return { name: t.name, description: str(t.description || t.summary) }
    return null
  }).filter(Boolean)
}

function hostOf(url) {
  try { return new URL(url).hostname } catch { return '' }
}

/** MCP 插件连到哪些主机：目录直接给 hosts，或从 mcp 服务地址里取 */
function mcpHosts(p, extras) {
  const hosts = [...strList(p.hosts), ...strList(p.network)]
  const servers = [...objList(p.mcp_servers), ...objList(Array.isArray(p.mcp) ? p.mcp : []), ...objList(extras.mcp)]
  servers.forEach(s => { const h = str(s.host) || hostOf(str(s.url)); if (h) hosts.push(h) })
  return [...new Set(hosts)]
}

/** 需要管理员填写的配置项：[{ key, label, required, configured, help }] */
function normConfig(v) {
  return objList(v).filter(c => str(c.key)).map(c => ({
    key: c.key, label: str(c.label, c.key), required: c.required !== false, help: str(c.help),
    configured: typeof c.configured === 'boolean' ? c.configured : null,   // null：目录没说（老后端）
  }))
}

function normPlugin(p) {
  if (!p || typeof p !== 'object' || !str(p.id)) return null
  const extras = p.extras && typeof p.extras === 'object' ? p.extras : {}
  const source = p.source && typeof p.source === 'object' ? p.source : { type: 'builtin' }
  const isMcp = p.kind === 'mcp' || p.mcp === true || source.type === 'mcp'
    || objList(p.mcp_servers).length > 0 || (Array.isArray(p.mcp) && p.mcp.length > 0) || objList(extras.mcp).length > 0
  const config = normConfig(p.config)
  const missing = [...strList(p.config_missing), ...config.filter(c => c.required && c.configured === false).map(c => c.key)]
  const needsConfig = p.status === 'needs_config' || p.needs_config === true || missing.length > 0
  return {
    id: p.id,
    name: str(p.name, p.id),
    icon: str(p.icon) || '🧩',
    category: str(p.category, 'other'),
    summary: str(p.summary),
    description: str(p.description) || str(p.long_description) || str(extras.long_description),
    kind: isMcp ? 'mcp' : ['tool', 'channel', 'step', 'skill'].includes(p.kind) ? p.kind : 'tool',
    tools: normTools(p.tools),
    step: p.step && typeof p.step === 'object' ? p.step : null,
    requires: strList(p.requires),
    tier: p.tier === 'pro' ? 'pro' : 'free',
    price: Number.isFinite(p.price) ? p.price : 0,
    examples: strList(p.examples),
    available: p.available !== false,
    // 第十四轮插件包：来源 / 版本 / 加载状态（老后端没有这些字段时按内置、可用处理）
    builtin: p.builtin !== false,
    // needs_config：MCP 等插件缺管理员配置（如 API Key），不能加入工具箱
    status: p.status === 'unavailable' ? 'unavailable' : needsConfig ? 'needs_config' : 'ok',
    reason: str(p.reason),
    version: str(p.version),
    author: str(p.author),
    homepage: str(p.homepage),
    license: str(p.license) || str(extras.license),
    privacyUrl: /^https?:\/\//.test(str(p.privacy_url || extras.privacy_url)) ? str(p.privacy_url || extras.privacy_url) : '',
    source,
    hosts: isMcp ? mcpHosts(p, extras) : strList(p.hosts),
    config,
    configMissing: [...new Set(missing)],
    permissions: objList(p.permissions).filter(x => str(x.label)).map(x => ({ key: str(x.key, x.label), label: x.label, level: x.level === 'warn' ? 'warn' : 'info' })),
  }
}

const SHA = /^[0-9a-f]{40}$/

/** 来源 commit 的短写：40 位 sha 取前 7 位 */
export const shortRef = ref => (SHA.test(str(ref)) ? ref.slice(0, 7) : str(ref))

/** 插件来源的网页地址：GitHub / Gitee 指到固定的 commit 与子目录；其余用主页（只认 http(s)） */
export function sourceLink(plugin) {
  const s = plugin?.source || {}
  const hosts = { github: 'https://github.com', gitee: 'https://gitee.com' }
  if (hosts[s.type] && /^[\w.-]+\/[\w.-]+$/.test(str(s.repo))) {
    const ref = str(s.ref)
    return `${hosts[s.type]}/${s.repo}${ref ? `/tree/${encodeURIComponent(ref)}${s.path ? `/${s.path}` : ''}` : ''}`
  }
  const home = str(plugin?.homepage)
  return /^https?:\/\//.test(home) ? home : ''
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

/* ---------- 浏览：类型 / 来源 / 徽标 / 搜索 / 筛选 / 精选套装 ---------- */

/** 筛选用的类型分组：通道算工具 */
export const kindGroup = p => (p.kind === 'channel' ? 'tool' : p.kind)

/** 来源：official（随平台发布）/ source（从插件源装的）/ community（导入的社区插件） */
export function sourceOf(p) {
  if (p.builtin) return 'official'
  return str(p.source?.marketplace) ? 'source' : 'community'
}
export const SOURCE_LABEL = { official: '官方', community: '社区', source: '插件源' }

/** 不能加入工具箱的原因（能加入返回空串） */
export function blockReason(p) {
  if (!p) return '插件不存在'
  if (p.status === 'unavailable') return p.reason || '插件没加载成功'
  if (p.status === 'needs_config') return p.reason || '需要管理员先填好配置'
  return ''
}

/** 卡片与详情上的徽标：[{ id, label, tone }]；tone 决定颜色 */
export function badgesFor(p) {
  const out = []
  const src = sourceOf(p)
  out.push(src === 'official' ? { id: 'official', label: '官方', tone: 'official' } : { id: src, label: SOURCE_LABEL[src], tone: 'community' })
  if (p.kind === 'mcp') out.push({ id: 'mcp', label: 'MCP', tone: 'mcp' })
  else if (p.kind !== 'tool') out.push({ id: p.kind, label: KIND_LABEL[p.kind], tone: 'kind' })
  if (p.tier === 'pro') out.push({ id: 'pro', label: '专业版', tone: 'pro' })
  if (p.status === 'needs_config') out.push({ id: 'config', label: '需要配置', tone: 'warn' })
  else if (p.status === 'unavailable') out.push({ id: 'off', label: '暂不可用', tone: 'muted' })
  return out
}

const fold = v => String(v || '').toLowerCase()

/** 插件的检索文本：名称、一句话、详细说明、示例、分类、类型、作者、工具 */
function haystack(p, catName) {
  return fold([p.name, p.id, p.summary, p.description, ...p.examples, catName, KIND_LABEL[p.kind], SOURCE_LABEL[sourceOf(p)],
    p.author, ...p.tools.map(t => `${t.name} ${t.description}`), ...p.hosts].join(' \n '))
}

/** 即时搜索：空格分词、每个词都要命中；名称命中的排前面。q 为空返回原列表 */
export function searchPlugins(plugins, q, categories = []) {
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (!words.length) return plugins
  const catName = new Map(categories.map(c => [c.id, c.name]))
  const scored = []
  plugins.forEach((p, i) => {
    const text = haystack(p, catName.get(p.category))
    if (!words.every(w => text.includes(w))) return
    const name = fold(p.name)
    const score = words.reduce((n, w) => n + (name.startsWith(w) ? 4 : name.includes(w) ? 2 : fold(p.summary).includes(w) ? 1 : 0), 0)
    scored.push({ p, score, i })
  })
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map(x => x.p)
}

/** 分类 / 来源 / 类型组合筛选；'all' 或空表示不限 */
export function filterPlugins(plugins, { cat = 'all', source = 'all', kind = 'all' } = {}) {
  return plugins.filter(p => (cat === 'all' || p.category === cat)
    && (source === 'all' || sourceOf(p) === source || (source === 'community' && sourceOf(p) === 'source'))
    && (kind === 'all' || kindGroup(p) === kind))
}

/** 已选插件的类型分布：[{ id, label, n }]（按 KIND_FILTERS 顺序） */
export function kindCounts(plugins) {
  return KIND_FILTERS.map(k => ({ id: k.id, label: k.name, n: plugins.filter(p => kindGroup(p) === k.id).length })).filter(k => k.n)
}

/** 同类推荐：同分类优先、同类型次之，排除自己和不可用的 */
export function relatedPlugins(plugins, p, n = 6) {
  return plugins
    .filter(x => x.id !== p.id && x.status !== 'unavailable' && (x.category === p.category || kindGroup(x) === kindGroup(p)))
    .map((x, i) => ({ x, s: (x.category === p.category ? 2 : 0) + (kindGroup(x) === kindGroup(p) ? 1 : 0), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .map(r => r.x)
}

/** 精选套装的名字：职业 → 「店主套装」这类短名；没收录的用职业名 */
const BUNDLE_TITLE = {
  shop_owner: '店主套装', student: '学生套装', teacher: '老师套装', freelancer: '自由职业套装', project_manager: '项目经理套装',
  sales: '销售套装', creator: '创作者套装', office: '办公套装',
}
const BUNDLE_ORDER = ['shop_owner', 'student', 'office', 'freelancer', 'creator', 'teacher', 'sales', 'project_manager']

/** 精选套装 = 职业预设：插件 + 推荐流程用到的积木，一键整套加入。只留目录里在且能加入的 */
export function bundlesFrom(catalog) {
  if (!catalog) return []
  const byId = new Map(catalog.plugins.map(p => [p.id, p]))
  const rank = id => { const i = BUNDLE_ORDER.indexOf(id); return i < 0 ? BUNDLE_ORDER.length : i }
  return catalog.professions
    .map(prof => {
      const ids = [...new Set([...prof.plugins, ...prof.flows.flatMap(f => f.steps.map(s => s.plugin))])]
        .filter(id => byId.has(id) && !blockReason(byId.get(id)))
      return {
        id: prof.id, profession: prof.id, title: BUNDLE_TITLE[prof.id] || `${prof.name}套装`, icon: prof.icon,
        who: prof.name, summary: prof.summary, ids, plugins: ids.map(id => byId.get(id)), flows: prof.flows,
      }
    })
    .filter(b => b.ids.length >= 2)
    .sort((a, b) => rank(a.id) - rank(b.id))
}

/** 插件能做的事（详情页「它能做什么」）：工具 / 积木 / 技能各自的说法 */
export function abilitiesOf(p, toolName = t => t.name) {
  if (p.kind === 'skill') {
    return [{ id: 'skill', icon: '📖', text: '给智能体加一套做事方法（提示词技能），遇到相关的事会按这套方法来做；不运行任何代码。' }]
  }
  if (p.kind === 'step' && p.step) {
    const role = { input: '输入积木：把内容带进流程', process: '处理积木：在流程中间加工内容', output: '输出积木：把结果送出去' }[p.step.role]
    const out = [{ id: 'role', icon: '🧱', text: role || '流程积木：在「积木流程」里和别的积木拼在一起用' }]
    objList(p.step.options).filter(o => str(o.label)).slice(0, 4).forEach(o => out.push({ id: `opt-${o.key}`, icon: '⚙️', text: `可以设置：${o.label}` }))
    return out
  }
  const tools = p.tools.map(t => ({ id: t.name, icon: '', text: toolName(t), detail: t.description }))
  if (p.kind === 'mcp' && !tools.length) {
    return [{ id: 'mcp', icon: '🔌', text: `连接远程 MCP 服务${p.hosts.length ? `（${p.hosts.join('、')}）` : ''}，工具清单由服务提供` }]
  }
  return tools
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

/** 登录页地址（带 ?u= 预填账号）：结果页「去登录」和「在手机上打开」二维码共用（路径约定见 routes.js） */
export function loginPath(username) {
  return loginHref(username || '')
}

export function greetingFor(name, profession) {
  const given = profession?.home?.greeting
  if (given) return given
  const h = new Date().getHours()
  const part = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
  return `${part}，我是${name || '你的智能体'}。`
}
