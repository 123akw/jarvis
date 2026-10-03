/* 「我的流程」首页的纯逻辑（第十八轮，契约 docs/proposals/2026-10-round18-flows.md §2 / §5.2）：
 * 节点的人话名字与图标、按连线排出先后、缩略图排版、定时运行的「下次运行」、草稿交接、时间文案。
 * 不碰 DOM，方便单测；组件只负责把这些画出来。 */

/** 草稿交接：模板 / 一句话生成 / 新建 → sessionStorage → /flows/new 的画布当 initial 读走 */
export const DRAFT_KEY = 'jvf-draft'
export const MAX_NAME = 30

/* ---------- 节点：名字、图标、色调 ---------- */

/** 节点类型的默认名字 / 图标；tone 决定缩略图与图标串的颜色 */
export const TYPE_META = {
  start: { label: '开始', icon: '🚩', tone: 'start' },
  llm: { label: 'AI 处理', icon: '✨', tone: 'ai' },
  tool: { label: '插件工具', icon: '🧩', tone: 'tool' },
  condition: { label: '条件分支', icon: '🔀', tone: 'logic' },
  template: { label: '文本拼接', icon: '📝', tone: 'logic' },
  step: { label: '积木', icon: '🧱', tone: 'out' },
  approval: { label: '发送前确认', icon: '✋', tone: 'wait' },
  end: { label: '结束', icon: '🏁', tone: 'end' },
}

/** 九个核心积木（节点目录没加载出来时兜底） */
export const STEP_META = {
  input_text: { name: '文字输入', icon: '✍️', tone: 'start' },
  input_file: { name: '资料上传', icon: '📎', tone: 'start' },
  split_file: { name: '文件拆分', icon: '✂️', tone: 'ai' },
  ai_extract: { name: 'AI 提炼', icon: '✨', tone: 'ai' },
  to_todo: { name: '加到待办', icon: '📌', tone: 'out' },
  feishu_send: { name: '发到飞书', icon: '📨', tone: 'out' },
  feishu_doc: { name: '汇总到飞书文档', icon: '📄', tone: 'out' },
  wechat_send: { name: '发到微信', icon: '📲', tone: 'out' },
  web_page: { name: '生成网页与二维码', icon: '🔗', tone: 'out' },
}

const FIELD_LABEL = { text: '文字', items: '条目', title: '标题', links: '链接', parts: '分段', files: '文件' }
const SYS_LABEL = { date: '今天日期', time: '现在时间', weekday: '星期几' }
const FIELD_TYPE_LABEL = { text: '一行字', paragraph: '一段文字', file: '一个文件', number: '一个数字', select: '一个选项' }

const dataOf = node => (node && typeof node.data === 'object' && node.data) || {}

/** 节点目录（GET /api/flows/nodes）→ 查表：工具（插件/工具名）、技能、积木、插件（名字、图标、能不能用） */
export function catalogIndex(catalog) {
  const idx = { tool: {}, skill: {}, step: {}, plugin: {} }
  const addPlugin = (id, it, name) => {
    if (!id) return
    const prev = idx.plugin[id]
    const available = it.available !== false
    if (!prev) idx.plugin[id] = { id, name: name || id, icon: it.icon || '', available, reason: available ? '' : (it.reason || '') }
    else if (!available && prev.available) idx.plugin[id] = { ...prev, available: false, reason: it.reason || prev.reason }
  }
  for (const group of catalog?.groups || []) {
    for (const it of group?.items || []) {
      const d = it?.data || {}
      if (it.type === 'tool' && d.plugin) {
        idx.tool[`${d.plugin}/${d.tool}`] = it
        addPlugin(d.plugin, it, it.plugin_name)
      } else if (d.skill) {
        idx.skill[d.skill] = it
        addPlugin(d.skill, it, it.plugin_name || it.title || d.title)
      } else if (it.type === 'step' && d.step) {
        idx.step[d.step] = it
        addPlugin(d.step, it, it.title || d.title)
      }
    }
  }
  return idx
}

const EMPTY_IDX = catalogIndex(null)

/** 一个节点给人看的样子：{ name, icon, tone, kind（类型名） } */
export function nodeInfo(node, idx = EMPTY_IDX) {
  const type = TYPE_META[node?.type] ? node.type : 'step'
  const meta = TYPE_META[type]
  const d = dataOf(node)
  let icon = meta.icon
  let fallbackName = meta.label
  let tone = meta.tone
  if (type === 'tool') {
    const it = idx.tool[`${d.plugin}/${d.tool}`]
    icon = it?.icon || idx.plugin[d.plugin]?.icon || icon
    fallbackName = it?.title || idx.plugin[d.plugin]?.name || fallbackName
  } else if (type === 'llm' && d.skill) {
    const it = idx.skill[d.skill]
    icon = it?.icon || idx.plugin[d.skill]?.icon || icon
    fallbackName = it?.title || fallbackName
  } else if (type === 'step') {
    const it = idx.step[d.step]
    const known = STEP_META[d.step]
    icon = it?.icon || known?.icon || icon
    fallbackName = it?.title || known?.name || fallbackName
    tone = known?.tone || (it?.role === 'process' ? 'ai' : it?.role === 'input' ? 'start' : 'out')
  }
  const name = String(d.title || '').trim() || fallbackName
  return { name, icon, tone, kind: meta.label }
}

/* ---------- 图：先后顺序、层次 ---------- */

function cleanGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.filter(n => n && n.id) : []
  const ids = new Set(nodes.map(n => n.id))
  const edges = Array.isArray(graph?.edges)
    ? graph.edges.filter(e => e && ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    : []
  return { nodes, edges }
}

const posOf = n => ({ x: Number(n?.position?.x) || 0, y: Number(n?.position?.y) || 0 })

/** 按连线排出先后（拓扑序）；同一批里按位置从左到右、从上到下；有环 / 孤立的节点排在后面 */
export function orderNodes(graph) {
  const { nodes, edges } = cleanGraph(graph)
  const indeg = new Map(nodes.map(n => [n.id, 0]))
  const out = new Map(nodes.map(n => [n.id, []]))
  for (const e of edges) { indeg.set(e.target, indeg.get(e.target) + 1); out.get(e.source).push(e.target) }
  const byId = new Map(nodes.map(n => [n.id, n]))
  const cmp = (a, b) => {
    if (a.type === 'start' && b.type !== 'start') return -1
    if (b.type === 'start' && a.type !== 'start') return 1
    const pa = posOf(a); const pb = posOf(b)
    return pa.x - pb.x || pa.y - pb.y
  }
  const ready = nodes.filter(n => indeg.get(n.id) === 0).sort(cmp)
  const done = []
  const seen = new Set()
  while (ready.length) {
    const n = ready.shift()
    if (seen.has(n.id)) continue
    seen.add(n.id)
    done.push(n)
    for (const t of out.get(n.id)) {
      indeg.set(t, indeg.get(t) - 1)
      if (indeg.get(t) === 0) { ready.push(byId.get(t)); ready.sort(cmp) }
    }
  }
  return done.concat(nodes.filter(n => !seen.has(n.id)).sort(cmp))
}

/** 每个节点的层次（离开始最远的路径长度），给没有位置的图自动排版用 */
function depths(graph) {
  const { edges } = cleanGraph(graph)
  const depth = new Map()
  for (const n of orderNodes(graph)) {
    const ins = edges.filter(e => e.target === n.id).map(e => depth.get(e.source)).filter(v => v !== undefined)
    depth.set(n.id, ins.length ? Math.max(...ins) + 1 : 0)
  }
  return depth
}

/** 「开始 → AI 处理 → 结束」：读屏与缩略图的文字说明 */
export function chainLabel(graph, idx = EMPTY_IDX) {
  const list = orderNodes(graph)
  return list.length ? list.map(n => nodeInfo(n, idx).name).join(' → ') : '空流程'
}

/** 开始节点要填的字段 */
export function startFields(graph) {
  const start = cleanGraph(graph).nodes.find(n => n.type === 'start')
  const fields = dataOf(start).fields
  return Array.isArray(fields) ? fields.filter(f => f && f.key) : []
}

/** 把 {{节点.字段}} 换成「节点名 · 字段」这样的人话 */
export function humanVars(text, graph, idx = EMPTY_IDX) {
  const { nodes } = cleanGraph(graph)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const fields = startFields(graph)
  return String(text || '').replace(/\{\{\s*([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_]{1,24})\s*\}\}/g, (all, id, field) => {
    if (id === 'sys') return `「${SYS_LABEL[field] || '系统信息'}」`
    const node = byId.get(id)
    if (!node) return '「前面的结果」'
    if (node.type === 'start') {
      const f = fields.find(x => x.key === field)
      return `「${f?.label || '开始时填的内容'}」`
    }
    return `「${nodeInfo(node, idx).name} · ${FIELD_LABEL[field] || '结果'}」`
  }).replace(/\{\{\s*item\s*\}\}/g, '「当前这一条」')
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 节点做什么：一句人话（预览弹层的步骤清单用） */
export function describeNode(node, graph, idx = EMPTY_IDX) {
  const d = dataOf(node)
  switch (node?.type) {
    case 'start': {
      const fields = Array.isArray(d.fields) ? d.fields.filter(f => f && f.key) : []
      if (!fields.length) return '点「运行」直接开始，不用填东西'
      return `运行时填：${fields.map(f => `${f.label || '内容'}（${FIELD_TYPE_LABEL[f.type] || '一段文字'}）`).join('、')}`
    }
    case 'llm': {
      if (d.skill) {
        const skill = idx.skill[d.skill]?.title || idx.plugin[d.skill]?.name || ''
        return skill ? `用技能「${skill}」来写` : '用技能来写'
      }
      const prompt = clip(humanVars(d.prompt, graph, idx), 48)
      return prompt ? `AI 要做的：${prompt}` : '让 AI 处理前面的内容'
    }
    case 'tool': {
      const plugin = idx.plugin[d.plugin]?.name
      const args = Object.entries(d.args || {}).filter(([, v]) => String(v ?? '').trim())
      const argText = args.slice(0, 2).map(([k, v]) => {
        const spec = (idx.tool[`${d.plugin}/${d.tool}`]?.args || []).find(a => a.name === k)
        return `${spec?.label || '参数'}：${clip(humanVars(v, graph, idx), 16)}`
      }).join('，')
      const base = plugin ? `用插件「${plugin}」` : '用插件工具'
      return argText ? `${base}，${argText}` : base
    }
    case 'condition': {
      const cases = Array.isArray(d.cases) ? d.cases : []
      const names = cases.map((c, i) => c?.label || `情况 ${i + 1}`)
      return names.length ? `按条件分开走：${names.join(' / ')} / 其他情况` : '按条件分开走'
    }
    case 'template': {
      const t = clip(humanVars(d.template, graph, idx), 40)
      return t ? `拼成一段文字：${t}` : '把前面的内容拼成一段文字'
    }
    case 'step': {
      const known = STEP_META[d.step]
      const summary = idx.step[d.step]?.summary || ''
      if (summary) return clip(summary, 48)
      return known ? `用现成积木「${known.name}」` : '用现成积木'
    }
    case 'approval':
      return '先停下，把要发出去的内容给你看，你点同意才往下走'
    case 'end':
      return d.page ? '给出最终结果，并生成一个能分享的结果网页' : '给出最终结果'
    default:
      return ''
  }
}

/**
 * 「需要准备」：模板 / 草稿开始前要满足的条件，每条带是否满足与动作（契约 needs + 节点目录的 available）。
 *   needs 是服务端给的人话（如「需要绑定飞书」）；提到飞书的按绑定状态判断，给「去绑定飞书」。
 *   插件当前账号用不了：没装的说「需先加」（缺插件也允许用，进画布后对应节点会提示）；其余照目录给的原因。
 * 返回 [{ key, tag（卡片小标签）, text（预览里的一行）, ok: true|false|null（不知道）, action: 'feishu'|'' }]
 */
export function requirements({ needs = [], plugins = [], graph = null } = {}, idx = EMPTY_IDX, feishu = null) {
  const out = []
  let feishuNeed = false
  for (const raw of needs || []) {
    const text = String(raw || '').trim()
    if (!text) continue
    if (/飞书/.test(text)) {
      feishuNeed = true
      if (feishu && feishu.configured === false) {   // 服务器没接入飞书：绑不了，不给动作
        out.push({ key: `need:${text}`, text: `${text}（这台服务器还没接入飞书，先找管理员开通）`, ok: false, tag: '飞书没开通', action: '' })
        continue
      }
      const ok = feishu ? Boolean(feishu.bound) : null
      out.push({ key: `need:${text}`, text, ok, tag: ok === false ? '需先绑定飞书' : '需要：飞书', action: ok === false ? 'feishu' : '' })
    } else {
      out.push({ key: `need:${text}`, text, ok: null, tag: text.replace(/^需要/, '需要：').replace(/^需要：：/, '需要：'), action: '' })
    }
  }
  const ids = plugins?.length ? plugins : graphPlugins(graph)
  for (const p of pluginNeeds(ids, idx)) {
    if (p.available) continue
    const missing = !p.reason || /装/.test(p.reason)
    if (!missing && feishuNeed && /飞书/.test(p.reason)) continue   // 和「需要绑定飞书」是一回事
    out.push(missing
      ? { key: `plugin:${p.id}`, text: p.reason || `这个智能体还没装「${p.name}」，到智能体设置里加上就能用`, ok: false, tag: `需先加「${p.name}」`, action: '' }
      : { key: `plugin:${p.id}`, text: `「${p.name}」：${p.reason}`, ok: false, tag: `「${p.name}」暂时用不了`, action: /飞书/.test(p.reason) ? 'feishu' : '' })
  }
  return out
}

/** 流程用到的插件（目录里能查到名字的），以及其中当前账号用不了的 */
export function pluginNeeds(pluginIds, idx = EMPTY_IDX) {
  const list = [...new Set((pluginIds || []).filter(Boolean))]
  return list.map(id => idx.plugin[id] || null).filter(Boolean)
}

/** 节点图里用到的插件（插件工具、技能、积木） */
export function graphPlugins(graph) {
  const ids = []
  for (const n of cleanGraph(graph).nodes) {
    const d = dataOf(n)
    if (n.type === 'tool' && d.plugin) ids.push(d.plugin)
    else if (n.type === 'llm' && d.skill) ids.push(d.skill)
    else if (n.type === 'step' && d.step) ids.push(d.step)
  }
  return [...new Set(ids)]
}

/* ---------- 缩略图排版 ---------- */

const NODE_W = 220
const NODE_H = 72
const GAP_X = 300
const GAP_Y = 110

/** 位置缺失或全挤在一处时，按层次从左到右自动排 */
function positioned(graph) {
  const { nodes } = cleanGraph(graph)
  const keys = new Set(nodes.map(n => `${Math.round(posOf(n).x)},${Math.round(posOf(n).y)}`))
  const hasPos = nodes.every(n => n.position && Number.isFinite(Number(n.position.x)) && Number.isFinite(Number(n.position.y)))
  if (hasPos && keys.size === nodes.length) return new Map(nodes.map(n => [n.id, posOf(n)]))
  const depth = depths(graph)
  const rows = new Map()
  const out = new Map()
  for (const n of orderNodes(graph)) {
    const col = depth.get(n.id) || 0
    const row = rows.get(col) || 0
    rows.set(col, row + 1)
    out.set(n.id, { x: col * GAP_X, y: row * GAP_Y })
  }
  return out
}

/**
 * 节点图 → 缩略图（SVG 坐标）：按 position 等比缩放进 w×h，居中；节点是小圆角矩形，连线是右出左进的贝塞尔曲线。
 * maxScale 限制节点很少时别画得太大。返回 { w, h, scale, nodes: [{id, x, y, w, h, tone, icon, name}], edges: [{id, d}] }
 */
export function thumbLayout(graph, { w = 320, h = 132, pad = 16, maxScale = 0.4 } = {}, idx = EMPTY_IDX) {
  const { nodes, edges } = cleanGraph(graph)
  if (!nodes.length) return { w, h, scale: 0, nodes: [], edges: [] }
  const pos = positioned(graph)
  const xs = nodes.map(n => pos.get(n.id).x)
  const ys = nodes.map(n => pos.get(n.id).y)
  const minX = Math.min(...xs); const minY = Math.min(...ys)
  const bw = Math.max(...xs) - minX + NODE_W
  const bh = Math.max(...ys) - minY + NODE_H
  const scale = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, maxScale)
  const ox = (w - bw * scale) / 2
  const oy = (h - bh * scale) / 2
  const r = v => Math.round(v * 10) / 10
  const box = new Map()
  const outNodes = nodes.map(n => {
    const p = pos.get(n.id)
    const info = nodeInfo(n, idx)
    const b = { id: n.id, x: r(ox + (p.x - minX) * scale), y: r(oy + (p.y - minY) * scale), w: r(NODE_W * scale), h: r(NODE_H * scale), tone: info.tone, icon: info.icon, name: info.name }
    box.set(n.id, b)
    return b
  })
  const outEdges = edges.map((e, i) => {
    const s = box.get(e.source); const t = box.get(e.target)
    const sx = s.x + s.w; const sy = s.y + s.h / 2
    const tx = t.x; const ty = t.y + t.h / 2
    const c = Math.max(8, Math.abs(tx - sx) / 2)
    return { id: e.id || `e${i}`, d: `M${r(sx)} ${r(sy)} C${r(sx + c)} ${r(sy)} ${r(tx - c)} ${r(ty)} ${r(tx)} ${r(ty)}` }
  })
  return { w, h, scale, nodes: outNodes, edges: outEdges }
}

/* ---------- 新建 / 草稿交接 ---------- */

/** 「新建流程」的默认草稿：开始 → AI 处理 → 结束 */
export function blankDraft() {
  return {
    name: '新流程',
    summary: '',
    graph: {
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: '开始', fields: [
          { key: 'text', label: '要处理的内容', type: 'paragraph', required: true, placeholder: '贴一段文字进来' },
        ] } },
        { id: 'n1', type: 'llm', position: { x: 320, y: 0 }, data: { title: 'AI 处理', prompt: '请帮我整理下面的内容，列出要点：\n{{start.text}}', output: 'text' } },
        { id: 'end', type: 'end', position: { x: 640, y: 0 }, data: { title: '结束', output: '{{n1.text}}', page: false } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'n1', sourceHandle: null },
        { id: 'e2', source: 'n1', target: 'end', sourceHandle: null },
      ],
    },
  }
}

export function writeDraft({ name, summary = '', graph }) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name: String(name || '新流程').slice(0, MAX_NAME), summary: summary || '', graph }))
    return true
  } catch {
    return false
  }
}

/** 读草稿（不删）；坏数据当没有 */
export function readDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    return d && typeof d === 'object' && d.graph && Array.isArray(d.graph.nodes) ? d : null
  } catch {
    return null
  }
}

export function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY) } catch { /* 存储不可用 */ }
}

/** 复制出来的名字：「早报 副本」，不超过 30 字 */
export function copyName(name) {
  const base = String(name || '未命名流程').trim()
  return `${base.slice(0, MAX_NAME - 3)} 副本`
}

/* ---------- 定时运行 ---------- */

/** 契约 weekday 1–7 = 周一 … 周日 */
export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
export const REPEATS = [
  { id: 'daily', label: '每天' },
  { id: 'weekdays', label: '工作日' },
  { id: 'weekly', label: '每周' },
]
const isoDay = date => ((date.getDay() + 6) % 7) + 1

export function validTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''))
}

/** 「每个工作日 08:00」：服务端没给 label 时前端自己拼 */
export function scheduleLabel(schedule) {
  if (!schedule || !validTime(schedule.time)) return ''
  if (schedule.repeat === 'weekdays') return `每个工作日 ${schedule.time}`
  if (schedule.repeat === 'weekly') return `每周${WEEKDAYS[(Number(schedule.weekday) || 1) - 1] || '一'} ${schedule.time}`
  return `每天 ${schedule.time}`
}

/** 下次运行的时间（本地时区）；时间不合法返回 null */
export function nextRun(schedule, now = new Date()) {
  if (!schedule || !validTime(schedule.time)) return null
  const [hh, mm] = schedule.time.split(':').map(Number)
  for (let i = 0; i <= 8; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm, 0, 0)
    if (d <= now) continue
    const day = isoDay(d)
    if (schedule.repeat === 'weekdays' && day > 5) continue
    if (schedule.repeat === 'weekly' && day !== (Number(schedule.weekday) || 1)) continue
    return d
  }
  return null
}

const two = n => String(n).padStart(2, '0')
const hm = d => `${two(d.getHours())}:${two(d.getMinutes())}`

/** 接下来几次运行（「下次运行」+ 之后 2 次） */
export function nextRuns(schedule, now = new Date(), count = 3) {
  const out = []
  let from = now
  for (let i = 0; i < count; i += 1) {
    const d = nextRun(schedule, from)
    if (!d) break
    out.push(d)
    from = d
  }
  return out
}

/** 「今天（周五）08:00」「明天（周六）08:00」「周三 08:00」「10月15日（周三）08:00」 */
export function whenLabel(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day1 = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diff = Math.round((day1 - day0) / 86400000)
  const week = `周${WEEKDAYS[isoDay(date) - 1]}`
  if (diff >= 0 && diff <= 2) return `${['今天', '明天', '后天'][diff]}（${week}）${hm(date)}`
  if (diff > 2 && diff < 7) return `${week} ${hm(date)}`
  return `${date.getMonth() + 1}月${date.getDate()}日（${week}）${hm(date)}`
}

/* ---------- 时间与状态文案 ---------- */

export const RUN_STATUS = {
  ok: '完成', error: '失败', running: '运行中', busy: '排队中', cancelled: '已停止', skipped: '没走到',
  waiting: '等你确认', rejected: '你没同意', expired: '确认过期了', quota: '今天用量到上限了',
}

/** 运行从哪来（契约 §2 的 source），运行记录里显示 */
export const RUN_SOURCE = {
  manual: '手动运行', schedule: '定时运行', chat: '对话里叫跑的', message: '收到消息触发', webhook: '链接触发',
  rerun: '重跑', test: '试跑', resume: '确认后接着跑',
}
export const sourceLabel = src => RUN_SOURCE[src] || ''

/** 确认还剩多久：「还剩 23 小时」「还剩 40 分钟」「快到期了」；过了返回「已过期」，读不出时间返回 '' */
export function remainLabel(expiresAt, now = Date.now()) {
  const t = toMs(expiresAt)
  if (!Number.isFinite(t)) return ''
  const s = Math.round((t - now) / 1000)
  if (s <= 0) return '已过期'
  if (s < 120) return '快到期了'
  if (s < 3600) return `还剩 ${Math.floor(s / 60)} 分钟`
  if (s < 86400 * 2) return `还剩 ${Math.floor(s / 3600)} 小时`
  return `还剩 ${Math.floor(s / 86400)} 天`
}

const toMs = iso => {
  if (!iso) return NaN
  if (typeof iso === 'number') return iso < 1e12 ? iso * 1000 : iso
  return Date.parse(iso)
}

export function relTime(iso, now = Date.now()) {
  const t = toMs(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 「10月3日 08:00」 */
export function absTime(iso) {
  const t = toMs(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm(d)}`
}

/** 耗时：800 毫秒 / 1.2 秒 / 1 分 5 秒 */
export function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1) return ''   // 0 毫秒这种就不写了
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`
}

/** 结果链接补成绝对地址 */
export function absUrl(url) {
  if (!url) return ''
  try { return new URL(url, window.location.origin).href } catch { return url }
}

/** 只放行站内路径与 http(s) 链接（结果网页地址来自服务端，仍防一手 javascript:） */
export function safeHref(url) {
  const s = String(url || '').trim()
  if (!s) return ''
  if (s.startsWith('/') && !s.startsWith('//')) return s
  return /^https?:\/\//i.test(s) ? s : ''
}
