/* 流程节点图的纯逻辑（第十八轮，契约 docs/proposals/2026-10-round18-flows.md §2 / §3.3 / §5.1）。
 *
 * 画布（flows/canvas/**）只负责把这里算出来的东西画出来：
 *   - 节点 / 连线增删改（都返回新对象，不改入参）；
 *   - 拓扑序、祖先（变量只能引用祖先）、变量 token 解析与人话标签；
 *   - 客户端镜像校验（与 jarvis/flows/graph.py 的结构规则一致，另加缺必填、孤立节点、没连到结束）；
 *   - 自动整理布局（左 → 右分层，自写，不引 dagre）；
 *   - 运行事件 → 节点状态；撤销 / 重做历史。
 * 不碰 DOM，方便单测。界面文案一律说人话：不出现节点 id、JSON、英文工具名。 */

export const START_ID = 'start'
export const ELSE_HANDLE = 'else'
export const MAX_NODES = 30
export const MAX_EDGES = 60
export const MAX_FIELDS = 8
export const MAX_TEXT = 4000
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,23}$/
export const NODE_ID = /^[A-Za-z0-9_-]{1,32}$/

/** 节点类型 → 人话名与一句说明（节点卡的小字、面板分组用） */
export const TYPE_INFO = {
  start: { label: '开始', hint: '流程从这里开始；运行时要填的内容在这里设' },
  llm: { label: 'AI 处理', hint: '让 AI 按你的要求处理前面的内容' },
  tool: { label: '插件工具', hint: '调用一个已装插件的功能' },
  condition: { label: '条件分支', hint: '按条件走不同的路' },
  template: { label: '文本拼接', hint: '把前面几步的结果拼成一段话' },
  step: { label: '积木', hint: '现成的处理 / 输出积木' },
  end: { label: '结束', hint: '最终结果长什么样' },
}
export const NODE_TYPES = Object.keys(TYPE_INFO)

export const FIELD_TYPES = [
  { value: 'text', label: '文字' },
  { value: 'paragraph', label: '长文' },
  { value: 'file', label: '文件' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '选项' },
]

/** 节点产出字段的人话名 */
export const OUT_LABEL = { text: '文字', items: '清单', title: '标题', links: '链接', parts: '分段', files: '文件' }
/** 能「逐条处理」的清单类产出 */
export const LIST_FIELDS = ['items', 'parts', 'links']

export const OPS = [
  { value: 'contains', label: '包含' },
  { value: 'not_contains', label: '不包含' },
  { value: 'equals', label: '等于' },
  { value: 'not_equals', label: '不等于' },
  { value: 'empty', label: '是空的', unary: true },
  { value: 'not_empty', label: '不是空的', unary: true },
  { value: 'gt', label: '大于（按数字比）' },
  { value: 'lt', label: '小于（按数字比）' },
  { value: 'ge', label: '大于等于（按数字比）' },
  { value: 'le', label: '小于等于（按数字比）' },
]
export const UNARY_OPS = new Set(OPS.filter(o => o.unary).map(o => o.value))

export const DEFAULT_SYS = [
  { key: 'date', label: '今天日期' },
  { key: 'time', label: '现在时间' },
  { key: 'weekday', label: '星期几' },
]

/* ---------- 小工具 ---------- */

const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

export const nodeById = (graph, id) => (graph?.nodes || []).find(n => n.id === id) || null

export function nodeTitle(node) {
  const t = String(node?.data?.title || '').trim()
  return t || TYPE_INFO[node?.type]?.label || '节点'
}

/** 条件节点的出口：每个分支一个（id = case.id），最后是「否则」 */
export function conditionHandles(node) {
  const cases = Array.isArray(node?.data?.cases) ? node.data.cases : []
  return [...cases.map(c => c.id), ELSE_HANDLE]
}

/** 出口的人话名（条件节点用分支名；其它节点只有一个出口，返回 ''） */
export function handleLabel(node, handle) {
  if (node?.type !== 'condition') return ''
  if (handle === ELSE_HANDLE) return '否则'
  const i = (node.data?.cases || []).findIndex(c => c.id === handle)
  if (i < 0) return ''
  return String(node.data.cases[i].label || '').trim() || `分支 ${i + 1}`
}

/** 新节点接线时默认用的出口：条件节点用第一个分支，其它节点只有一个出口 */
export function defaultHandle(node) {
  return node?.type === 'condition' ? conditionHandles(node)[0] : null
}

function nextId(list, prefix) {
  let max = 0
  const re = new RegExp(`^${prefix}(\\d+)$`)
  for (const item of list) {
    const m = re.exec(item.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${max + 1}`
}
export const nextNodeId = graph => nextId(graph.nodes, 'n')
export const nextEdgeId = graph => nextId(graph.edges, 'e')

/** option.choices 兼容字符串与 {value,label} 两种写法（积木选项声明沿用 step_catalog） */
export function choiceList(opt) {
  return (opt?.choices || []).map(c => (c && typeof c === 'object')
    ? { value: String(c.value ?? c.id ?? c.label), label: String(c.label ?? c.name ?? c.value) }
    : { value: String(c), label: String(c) })
}

/** 积木选项的默认值 */
export function defaultOptions(decls) {
  const out = {}
  for (const opt of decls || []) {
    if (!opt?.key) continue
    if (opt.default !== undefined && opt.default !== null) out[opt.key] = opt.default
    else if (opt.type === 'select') { const first = choiceList(opt)[0]; if (first) out[opt.key] = first.value }
  }
  return out
}

/* ---------- 新图 / 规整 ---------- */

/** 空白流程：一个开始（带一个「要处理的文字」输入项）连到结束，中间留出加节点的位置 */
export function emptyGraph() {
  return {
    nodes: [
      { id: START_ID, type: 'start', position: { x: 0, y: 0 },
        data: { title: '开始', fields: [{ key: 'text', label: '要处理的文字', type: 'paragraph', required: true }] } },
      { id: 'end', type: 'end', position: { x: 640, y: 0 }, data: { title: '结束', output: '', page: false } },
    ],
    edges: [{ id: 'e1', source: START_ID, target: 'end', sourceHandle: null }],
  }
}

/** 服务端 / 草稿来的图 → 编辑器用的图：补齐字段、丢掉悬空连线；位置全挤在一处（没排过版）就自动整理 */
export function normalizeGraph(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes) || !raw.nodes.length) return emptyGraph()
  const seen = new Set()
  const nodes = []
  for (const n of raw.nodes) {
    if (!n || typeof n !== 'object' || !TYPE_INFO[n.type]) continue
    const id = String(n.id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const pos = n.position && typeof n.position === 'object' ? n.position : {}
    nodes.push({ id, type: n.type, position: { x: num(pos.x), y: num(pos.y) }, data: n.data && typeof n.data === 'object' ? clone(n.data) : {} })
  }
  if (!nodes.some(n => n.id === START_ID)) {
    nodes.unshift({ id: START_ID, type: 'start', position: { x: 0, y: 0 }, data: { title: '开始', fields: [] } })
  }
  const pairs = new Set()
  const edges = []
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!e || typeof e !== 'object') continue
    const source = String(e.source || '')
    const target = String(e.target || '')
    if (!nodes.some(n => n.id === source) || !nodes.some(n => n.id === target) || source === target) continue
    const sourceHandle = e.sourceHandle == null || e.sourceHandle === '' ? null : String(e.sourceHandle)
    const key = `${source}|${target}|${sourceHandle}`
    if (pairs.has(key)) continue
    pairs.add(key)
    const id = e.id && NODE_ID.test(String(e.id)) && !edges.some(x => x.id === String(e.id)) ? String(e.id) : ''
    edges.push({ id, source, target, sourceHandle })
  }
  for (const e of edges) if (!e.id) e.id = nextEdgeId({ edges })
  let graph = { nodes, edges }
  const spots = new Set(nodes.map(n => `${Math.round(n.position.x)},${Math.round(n.position.y)}`))
  if (nodes.length > 1 && spots.size === 1) graph = autoLayout(graph)
  return graph
}

/** 保存用：只留契约里的字段，位置取整 */
export function cleanGraph(graph) {
  return {
    nodes: graph.nodes.map(n => ({
      id: n.id, type: n.type,
      position: { x: Math.round(num(n.position?.x)), y: Math.round(num(n.position?.y)) },
      data: clone(n.data || {}),
    })),
    edges: graph.edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  }
}

/* ---------- 节点 ---------- */

/**
 * 由节点目录里的一项（或 {type, data}）造一个新节点：数据深拷贝、按类型补默认值。
 * item 形如契约 §3.2 的 items[]：{ key, type, title, data, args?, options? }。
 */
export function createNode(graph, item, position = { x: 0, y: 0 }) {
  const type = item?.type
  if (!TYPE_INFO[type] || type === 'start') return null
  const id = type === 'end' && !nodeById(graph, 'end') ? 'end' : nextNodeId(graph)
  const data = clone(item.data || {}) || {}
  if (!String(data.title || '').trim()) data.title = item.title || TYPE_INFO[type].label
  if (type === 'llm') {
    if (typeof data.prompt !== 'string') data.prompt = ''
    if (data.output !== 'list') data.output = 'text'
  } else if (type === 'tool') {
    const args = data.args && typeof data.args === 'object' ? data.args : {}
    // 开始节点有同名 / 同义的输入项（如「城市」）就直接接上，省得再插变量
    const fields = nodeById(graph, START_ID)?.data?.fields || []
    for (const a of item.args || []) {
      if (args[a.name] !== undefined) continue
      const same = fields.find(f => f.key === a.name || (a.label && String(f.label || '').trim() === a.label))
      if (same) args[a.name] = `{{${START_ID}.${same.key}}}`
      else if (a.default !== undefined && a.default !== null) args[a.name] = String(a.default)
    }
    data.args = args
  } else if (type === 'condition') {
    if (!Array.isArray(data.cases) || !data.cases.length) {
      data.cases = [{ id: 'c1', label: '分支 1', logic: 'and', rules: [{ var: '', op: 'contains', value: '' }] }]
    }
  } else if (type === 'template') {
    if (typeof data.template !== 'string') data.template = ''
  } else if (type === 'step') {
    data.options = { ...defaultOptions(item.options), ...(data.options || {}) }
  } else if (type === 'end') {
    if (typeof data.output !== 'string') data.output = ''
    data.page = !!data.page
  }
  return { id, type, position: { x: Math.round(num(position.x)), y: Math.round(num(position.y)) }, data }
}

export function addNode(graph, node) {
  if (!node || nodeById(graph, node.id)) return graph
  return { ...graph, nodes: [...graph.nodes, node] }
}

/** 改节点 data（浅合并）；patch 也可以是函数 data => 新 data */
export function updateNodeData(graph, id, patch) {
  let hit = false
  const nodes = graph.nodes.map(n => {
    if (n.id !== id) return n
    hit = true
    const data = typeof patch === 'function' ? patch(n.data || {}) : { ...(n.data || {}), ...patch }
    return { ...n, data }
  })
  if (!hit) return graph
  let edges = graph.edges
  // 条件分支删掉后，挂在那个出口上的连线一并去掉
  const node = nodes.find(n => n.id === id)
  if (node?.type === 'condition') {
    const handles = new Set(conditionHandles(node))
    edges = edges.filter(e => e.source !== id || handles.has(e.sourceHandle))
  }
  return { nodes, edges }
}

export function moveNodes(graph, positions) {
  let changed = false
  const nodes = graph.nodes.map(n => {
    const p = positions[n.id]
    if (!p || (p.x === n.position.x && p.y === n.position.y)) return n
    changed = true
    return { ...n, position: { x: p.x, y: p.y } }
  })
  return changed ? { ...graph, nodes } : graph
}

/**
 * 删节点（开始节点删不掉）。heal：只删一个节点、它前面正好一条线时，把前后接起来（链中间删一步不断开）。
 */
export function removeNodes(graph, ids, { heal = true } = {}) {
  const drop = new Set((ids || []).filter(id => id !== START_ID && nodeById(graph, id)))
  if (!drop.size) return graph
  const nodes = graph.nodes.filter(n => !drop.has(n.id))
  let edges = graph.edges.filter(e => !drop.has(e.source) && !drop.has(e.target))
  if (heal && drop.size === 1) {
    const [id] = drop
    const ins = graph.edges.filter(e => e.target === id)
    const outs = graph.edges.filter(e => e.source === id)
    if (ins.length === 1 && outs.length) {
      for (const o of outs) {
        const conn = { source: ins[0].source, target: o.target, sourceHandle: ins[0].sourceHandle ?? null }
        const g = { nodes, edges }
        if (!canConnect(g, conn)) edges = [...edges, { id: nextEdgeId(g), ...conn }]
      }
    }
  }
  return { nodes, edges }
}

/* ---------- 连线 ---------- */

/** 从 from 出发能不能走到 to */
export function reaches(graph, from, to) {
  if (from === to) return true
  const out = adjacency(graph).out
  const seen = new Set([from])
  const stack = [from]
  while (stack.length) {
    const cur = stack.pop()
    for (const next of out.get(cur) || []) {
      if (next === to) return true
      if (!seen.has(next)) { seen.add(next); stack.push(next) }
    }
  }
  return false
}

function adjacency(graph) {
  const out = new Map(graph.nodes.map(n => [n.id, []]))
  const inc = new Map(graph.nodes.map(n => [n.id, []]))
  for (const e of graph.edges) {
    if (!out.has(e.source) || !inc.has(e.target)) continue
    out.get(e.source).push(e.target)
    inc.get(e.target).push(e.source)
  }
  return { out, inc }
}

/** 这条线能不能连：能连返回 ''，不能连返回人话原因 */
export function canConnect(graph, { source, target, sourceHandle = null } = {}) {
  if (!source || !target) return '连线没接上'
  if (source === target) return '节点不能连到自己'
  const s = nodeById(graph, source)
  const t = nodeById(graph, target)
  if (!s || !t) return '连线连到了不存在的节点'
  if (t.type === 'start') return '「开始」前面不能再接东西'
  if (s.type === 'end') return '「结束」后面不能再接'
  const handle = sourceHandle ?? null
  if (s.type === 'condition' && !conditionHandles(s).includes(handle)) return '请从某个分支的出口拉线'
  if (graph.edges.some(e => e.source === source && e.target === target && (e.sourceHandle ?? null) === handle)) {
    return '这两个节点已经连上了'
  }
  if (graph.edges.length >= MAX_EDGES) return `一个流程最多 ${MAX_EDGES} 条连线`
  if (reaches(graph, target, source)) return '这样会绕成圈，流程会停不下来'
  return ''
}

/** 连线：返回 { graph, error }；连不上时 graph 原样返回 */
export function connect(graph, conn) {
  const error = canConnect(graph, conn)
  if (error) return { graph, error }
  const edge = { id: nextEdgeId(graph), source: conn.source, target: conn.target, sourceHandle: conn.sourceHandle ?? null }
  return { graph: { ...graph, edges: [...graph.edges, edge] }, error: '' }
}

export function removeEdges(graph, ids) {
  const drop = new Set(ids || [])
  if (!graph.edges.some(e => drop.has(e.id))) return graph
  return { ...graph, edges: graph.edges.filter(e => !drop.has(e.id)) }
}

/* ---------- 插入（带自动连线） ---------- */

export const NODE_W = 240    // 节点卡宽（与模板 / 一句话生成的排版参数一致：宽 240、层距 80、行距 40）
export const COL = 320       // 列距 = 节点宽 + 层距
export const LIMIT_MSG = `一个流程最多 ${MAX_NODES} 个节点，可以拆成两个流程`
export const ROW = 136       // 新节点避让时往下挪的步长

function freeSpot(graph, pos, skip) {
  let { x, y } = pos
  for (let i = 0; i < 12; i += 1) {
    const hit = graph.nodes.some(n => n.id !== skip && Math.abs(n.position.x - x) < 200 && Math.abs(n.position.y - y) < 100)
    if (!hit) break
    y += ROW
  }
  return { x, y }
}

function descendants(graph, id) {
  const out = adjacency(graph).out
  const seen = new Set()
  const stack = [...(out.get(id) || [])]
  while (stack.length) {
    const cur = stack.pop()
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...(out.get(cur) || []))
  }
  return seen
}

/** 插入后给新节点让位：它后面的节点离它不到一列时整体右移一列 */
function makeRoom(graph, id) {
  const node = nodeById(graph, id)
  const after = descendants(graph, id)
  if (!node || !after.size) return graph
  const tight = graph.nodes.some(n => after.has(n.id) && n.position.x < node.position.x + COL * 0.8)
  if (!tight) return graph
  return { ...graph, nodes: graph.nodes.map(n => (after.has(n.id) ? { ...n, position: { x: n.position.x + COL, y: n.position.y } } : n)) }
}

/**
 * 把节点接到 after 的某个出口后面：那个出口原来接着的节点改接到新节点后面（链中间插一步）；
 * 新节点是「结束」时不改原有连线，另起一条。返回 { graph, error }。
 */
export function insertAfter(graph, after, handle, node) {
  const prev = nodeById(graph, after)
  if (!prev || !node) return { graph, error: '找不到要接在后面的节点' }
  if (prev.type === 'end') return { graph, error: '「结束」后面不能再接' }
  if (graph.nodes.length >= MAX_NODES) return { graph, error: LIMIT_MSG }
  const h = prev.type === 'condition' ? (handle ?? defaultHandle(prev)) : null
  const branch = prev.type === 'condition' ? Math.max(0, conditionHandles(prev).indexOf(h)) : 0
  const spot = freeSpot(graph, { x: prev.position.x + COL, y: prev.position.y + branch * ROW }, node.id)
  const placed = { ...node, position: spot }
  let g = addNode(graph, placed)
  const outs = graph.edges.filter(e => e.source === after && (e.sourceHandle ?? null) === h)
  const splice = outs.length > 0 && placed.type !== 'end'
  if (splice) {
    const outHandle = defaultHandle(placed)
    const moved = new Set(outs.map(e => e.id))
    g = { ...g, edges: g.edges.map(e => (moved.has(e.id) ? { ...e, source: placed.id, sourceHandle: outHandle } : e)) }
  }
  const res = connect(g, { source: after, target: placed.id, sourceHandle: h })
  if (res.error) return { graph, error: res.error }
  return { graph: makeRoom(res.graph, placed.id), error: '' }
}

/** 插在一条连线中间：source → 新节点 → target */
export function insertOnEdge(graph, edgeId, node) {
  const edge = graph.edges.find(e => e.id === edgeId)
  if (!edge || !node) return { graph, error: '找不到这条连线' }
  if (node.type === 'end') return { graph, error: '「结束」只能放在最后' }
  if (graph.nodes.length >= MAX_NODES) return { graph, error: LIMIT_MSG }
  const s = nodeById(graph, edge.source)
  const t = nodeById(graph, edge.target)
  const pos = { x: Math.round((s.position.x + t.position.x) / 2), y: Math.round((s.position.y + t.position.y) / 2) }
  let g = addNode(removeEdges(graph, [edgeId]), { ...node, position: pos })
  let res = connect(g, { source: edge.source, target: node.id, sourceHandle: edge.sourceHandle ?? null })
  if (res.error) return { graph, error: res.error }
  res = connect(res.graph, { source: node.id, target: edge.target, sourceHandle: defaultHandle(node) })
  if (res.error) return { graph, error: res.error }
  g = res.graph
  // 新节点放在两者中点；挤的话把下游整体右移一列
  if (t.position.x - s.position.x < COL * 1.6) {
    g = { ...g, nodes: g.nodes.map(n => (n.id === node.id ? { ...n, position: { x: s.position.x + COL, y: s.position.y } } : n)) }
    g = makeRoom(g, node.id)
  }
  return { graph: g, error: '' }
}

/* ---------- 拓扑序 / 祖先 ---------- */

/** 拓扑序（开始节点最先；同层按画布位置从左到右、从上到下）。有环时剩下的按位置排在最后 */
export function topoOrder(graph) {
  const { out } = adjacency(graph)
  const indeg = new Map(graph.nodes.map(n => [n.id, 0]))
  for (const [, targets] of out) for (const t of targets) indeg.set(t, indeg.get(t) + 1)
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const cmp = (a, b) => {
    if (a === START_ID) return -1
    if (b === START_ID) return 1
    const pa = byId.get(a).position
    const pb = byId.get(b).position
    return pa.x - pb.x || pa.y - pb.y || (a < b ? -1 : a > b ? 1 : 0)
  }
  const ready = graph.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id).sort(cmp)
  const order = []
  while (ready.length) {
    const cur = ready.shift()
    order.push(cur)
    for (const t of out.get(cur)) {
      indeg.set(t, indeg.get(t) - 1)
      if (indeg.get(t) === 0) { ready.push(t); ready.sort(cmp) }
    }
  }
  if (order.length < graph.nodes.length) {
    const rest = graph.nodes.map(n => n.id).filter(id => !order.includes(id)).sort(cmp)
    order.push(...rest)
  }
  return order
}

export function hasCycle(graph) {
  const { out } = adjacency(graph)
  const indeg = new Map(graph.nodes.map(n => [n.id, 0]))
  for (const [, targets] of out) for (const t of targets) indeg.set(t, indeg.get(t) + 1)
  const queue = graph.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id)
  let seen = 0
  while (queue.length) {
    const cur = queue.shift()
    seen += 1
    for (const t of out.get(cur)) {
      indeg.set(t, indeg.get(t) - 1)
      if (indeg.get(t) === 0) queue.push(t)
    }
  }
  return seen < graph.nodes.length
}

/** 上游（祖先）节点 id 集合 */
export function ancestors(graph, id) {
  const { inc } = adjacency(graph)
  const seen = new Set()
  const stack = [...(inc.get(id) || [])]
  while (stack.length) {
    const cur = stack.pop()
    if (seen.has(cur) || cur === id) continue
    seen.add(cur)
    stack.push(...(inc.get(cur) || []))
  }
  return seen
}

/** 按拓扑序列出祖先节点（变量可选范围） */
export function upstream(graph, id) {
  const set = ancestors(graph, id)
  return topoOrder(graph).filter(x => set.has(x)).map(x => nodeById(graph, x))
}

/* ---------- 变量 ---------- */

const VAR_RE = /\{\{\s*(?:([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_]{1,24})|(item))\s*\}\}/g

/** 文本里的变量：[{ raw, ref, field, start, end }]；{{item}} 记作 ref='item' */
export function parseVars(text) {
  const out = []
  const s = String(text ?? '')
  VAR_RE.lastIndex = 0
  let m
  while ((m = VAR_RE.exec(s))) {
    out.push({ raw: m[0], ref: m[3] ? 'item' : m[1], field: m[3] ? '' : m[2], start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** 切成文字段与变量段：[{ kind: 'text', text } | { kind: 'var', raw, ref, field }] */
export function splitVars(text) {
  const s = String(text ?? '')
  const out = []
  let at = 0
  for (const v of parseVars(s)) {
    if (v.start > at) out.push({ kind: 'text', text: s.slice(at, v.start) })
    out.push({ kind: 'var', raw: v.raw, ref: v.ref, field: v.field })
    at = v.end
  }
  if (at < s.length) out.push({ kind: 'text', text: s.slice(at) })
  return out
}

export const varToken = (ref, field) => (ref === 'item' ? '{{item}}' : `{{${ref}.${field}}}`)

/**
 * 节点能给下游用的产出：[{ field, label }]。
 * item 是节点在目录里对应的那项（积木可带 produces 声明，有就按它筛）。
 */
export function outputsOf(node, item = null, outputs = null) {
  if (!node) return []
  const d = node.data || {}
  const pick = fields => fields.map(f => ({ field: f, label: OUT_LABEL[f] || f }))
  // 节点目录给了各类型的产出（契约 §3.2 的 outputs）就按它；AI 处理只有选「清单」时才列清单
  const declared = outputs && node.type !== 'start' && Array.isArray(outputs[node.type]) ? outputs[node.type] : null
  if (declared && node.type !== 'step' && node.type !== 'end') {
    const list = declared.filter(f => OUT_LABEL[f] && !(node.type === 'llm' && f === 'items' && d.output !== 'list'))
    return pick(list)
  }
  switch (node.type) {
    case 'start':
      return (Array.isArray(d.fields) ? d.fields : []).filter(f => f?.key)
        .map(f => ({ field: f.key, label: String(f.label || '').trim() || '没起名的输入项' }))
    case 'llm':
      return pick(d.output === 'list' ? ['text', 'items'] : ['text'])
    case 'tool':
      return pick(['text', 'items'])
    case 'template':
      return pick(['text'])
    case 'step': {
      const all = ['text', 'items', 'title', 'links', 'parts']
      const produces = Array.isArray(item?.produces) ? item.produces.filter(f => all.includes(f)) : null
      return pick(produces && produces.length ? ['text', ...produces.filter(f => f !== 'text')] : all)
    }
    default:
      return []
  }
}

/**
 * 变量的人话标签：{{n1.text}} → 「AI 处理 · 文字」。broken = 引用的节点 / 输入项已经不在了。
 */
export function varLabel(graph, ref, field, { sys = DEFAULT_SYS } = {}) {
  if (ref === 'item') return { label: '当前这一条', broken: false }
  if (ref === 'sys') {
    const hit = sys.find(s => s.key === field)
    return { label: `系统 · ${hit ? hit.label : field}`, broken: !hit }
  }
  const node = nodeById(graph, ref)
  if (!node) return { label: `已删除的节点 · ${OUT_LABEL[field] || field}`, broken: true }
  if (node.type === 'start') {
    const f = (node.data?.fields || []).find(x => x.key === field)
    return { label: `${nodeTitle(node)} · ${f ? (String(f.label || '').trim() || '没起名的输入项') : '已删除的输入项'}`, broken: !f }
  }
  return { label: `${nodeTitle(node)} · ${OUT_LABEL[field] || field}`, broken: !OUT_LABEL[field] }
}

/** 把文本里的变量换成「人话」：用于节点卡摘要、读屏 */
export function humanize(text, graph, opts) {
  return splitVars(text).map(seg => (seg.kind === 'text' ? seg.text : `「${varLabel(graph, seg.ref, seg.field, opts).label}」`)).join('')
}

/**
 * 某节点里能插的变量（只能引用祖先）：按拓扑序分组，最后是系统变量。
 * itemOf(node) 返回该节点在目录里的那项（可省）。
 */
export function varOptions(graph, nodeId, { sys = DEFAULT_SYS, itemOf = () => null, outputs = null } = {}) {
  const groups = []
  const self = nodeById(graph, nodeId)
  if (self?.data?.foreach) {
    groups.push({ id: 'item', title: '逐条处理', type: 'item', vars: [{ token: '{{item}}', ref: 'item', field: '', label: '当前这一条', short: '当前这一条' }] })
  }
  for (const node of upstream(graph, nodeId)) {
    const outs = outputsOf(node, itemOf(node), outputs)
    if (!outs.length) continue
    const title = nodeTitle(node)
    groups.push({
      id: node.id, title, type: node.type,
      vars: outs.map(o => ({ token: varToken(node.id, o.field), ref: node.id, field: o.field, label: `${title} · ${o.label}`, short: o.label })),
    })
  }
  if (sys.length) {
    groups.push({
      id: 'sys', title: '系统', type: 'sys',
      vars: sys.map(s => ({ token: varToken('sys', s.key), ref: 'sys', field: s.key, label: `系统 · ${s.label}`, short: s.label })),
    })
  }
  return groups
}

/** 节点 data 里所有字符串（递归），带字段路径，用于找变量引用 */
function strings(value, path = []) {
  if (typeof value === 'string') return [{ path, text: value }]
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, i]))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]))
  return []
}

/** 条件规则里的 var 字段（"n1.text"，不带花括号） */
const RULE_VAR = /^\s*([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_]{1,24})\s*$/

/** 节点里引用到的变量（含条件规则的 var） */
export function referencesOf(node) {
  const refs = []
  for (const s of strings(node?.data || {})) {
    const isRuleVar = node.type === 'condition' && s.path[0] === 'cases' && s.path[2] === 'rules' && s.path[4] === 'var'
    if (isRuleVar) {
      const m = RULE_VAR.exec(s.text)
      if (m) refs.push({ ref: m[1], field: m[2], raw: s.text })
      continue
    }
    for (const v of parseVars(s.text)) refs.push({ ref: v.ref, field: v.field, raw: v.raw })
  }
  return refs
}

/** 把节点里引用 oldId 的变量换成 newId（复制粘贴 / 改 id 时用） */
export function renameRefs(data, oldId, newId) {
  const walk = v => {
    if (typeof v === 'string') {
      return v.replace(VAR_RE, (m, ref, field) => (ref === oldId ? `{{${newId}.${field}}}` : m))
        .replace(RULE_VAR, (m, ref, field) => (ref === oldId ? `${newId}.${field}` : m))
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(data)
}

/* ---------- 校验 ---------- */

const issue = (key, nodeId, level, block, message) => ({ key, nodeId, level, block, message })

/** 节点是不是「输出」：结束节点，或输出角色的积木（目录里没有角色信息时积木都算） */
function isOutput(node, itemOf) {
  if (node.type === 'end') return true
  if (node.type !== 'step') return false
  const role = itemOf(node)?.role
  return !role || role === 'output'
}

const blank = v => v === undefined || v === null || String(v).trim() === ''

/**
 * 客户端镜像校验。返回 [{ key, nodeId|null, level: 'error'|'warn', block: 'save'|'run'|'', message }]：
 *   block='save'：服务端一定会拒（结构问题），保存前就拦下；
 *   block='run'：能存成草稿，但跑不起来（缺必填、没连上、引用不对）；
 *   level='warn'：提醒（结果没送到结束），不拦。
 * opts.itemOf(node) → 目录里的那项（判断插件工具 / 积木可不可用、参数声明）；
 *   返回 null = 目录里确实没有（下架了），undefined = 目录还没加载（不判断）。
 */
export function validateGraph(graph, { itemOf = () => undefined, sys = DEFAULT_SYS } = {}) {
  const out = []
  const nodes = graph?.nodes || []
  const edges = graph?.edges || []
  const starts = nodes.filter(n => n.type === 'start')
  if (starts.length !== 1 || starts[0].id !== START_ID) out.push(issue('g-start', null, 'error', 'save', '流程要有且只有一个「开始」节点'))
  if (!nodes.some(n => isOutput(n, itemOf))) out.push(issue('g-end', null, 'error', 'save', '还没有「结束」节点：从左边拖一个「结束」进来'))
  if (nodes.length > MAX_NODES) out.push(issue('g-nodes', null, 'error', 'save', `${LIMIT_MSG}（现在有 ${nodes.length} 个）`))
  if (edges.length > MAX_EDGES) out.push(issue('g-edges', null, 'error', 'save', `一个流程最多 ${MAX_EDGES} 条连线，现在有 ${edges.length} 条`))
  const ids = new Set(nodes.map(n => n.id))
  for (const e of edges) {
    const s = nodeById(graph, e.source)
    const t = nodeById(graph, e.target)
    if (!s || !t) { out.push(issue(`x-${e.id}`, null, 'error', 'save', '有连线连到了不存在的节点')); continue }
    if (e.source === e.target) out.push(issue(`x-${e.id}`, s.id, 'error', 'save', '节点不能连到自己'))
    else if (t.type === 'start') out.push(issue(`x-${e.id}`, s.id, 'error', 'save', '「开始」前面不能再接东西'))
    else if (s.type === 'end') out.push(issue(`x-${e.id}`, s.id, 'error', 'save', '「结束」后面不能再接'))
  }
  if (hasCycle(graph)) out.push(issue('g-cycle', null, 'error', 'save', '有连线绕成了圈，流程会停不下来：删掉往回连的那条'))

  const fromStart = ids.has(START_ID) ? new Set([START_ID, ...descendants(graph, START_ID)]) : new Set()
  const outputs = new Set(nodes.filter(n => isOutput(n, itemOf)).map(n => n.id))
  const { inc, out: outs } = adjacency(graph)

  for (const node of nodes) {
    const d = node.data || {}
    const at = (k, level, block, message) => out.push(issue(`${node.id}-${k}`, node.id, level, block, message))
    const item = itemOf(node)

    // 按类型的必填
    if (node.type === 'start') {
      const fields = Array.isArray(d.fields) ? d.fields : []
      if (fields.length > MAX_FIELDS) at('fields', 'error', 'save', `输入项最多 ${MAX_FIELDS} 个`)
      const keys = new Set()
      fields.forEach((f, i) => {
        if (!FIELD_KEY.test(String(f?.key || '')) || keys.has(f.key)) at(`fk${i}`, 'error', 'save', `第 ${i + 1} 个输入项的内部名字不对，删掉重加一个`)
        keys.add(f?.key)
        if (blank(f?.label)) at(`fl${i}`, 'error', 'run', `第 ${i + 1} 个输入项还没起名字`)
        if (f?.type === 'select' && !(Array.isArray(f.options) && f.options.some(o => !blank(o)))) {
          at(`fo${i}`, 'error', 'run', `「${f.label || `第 ${i + 1} 个输入项`}」是选项，还没写有哪些选项`)
        }
      })
    } else if (node.type === 'llm') {
      if (blank(d.prompt)) at('prompt', 'error', 'run', '还没写要 AI 做什么')
      else if (String(d.prompt).length > MAX_TEXT) at('prompt', 'error', 'save', `要求太长了，最多 ${MAX_TEXT} 字`)
      if (d.skill && item === null) at('skill', 'warn', '', '用到的技能已经不在了，换一个或不用技能')
    } else if (node.type === 'tool') {
      if (item === null) at('tool', 'error', 'run', '这个插件工具不在了，删掉换一个')
      else if (item) {
        if (item.available === false) at('avail', 'error', 'run', item.reason || '这个插件现在用不了')
        for (const a of item.args || []) {
          if (a.required && blank(d.args?.[a.name])) at(`arg-${a.name}`, 'error', 'run', `还缺：${a.label || '必填项'}`)
        }
      }
    } else if (node.type === 'condition') {
      const cases = Array.isArray(d.cases) ? d.cases : []
      if (!cases.length) at('cases', 'error', 'run', '还没设分支')
      cases.forEach((c, i) => {
        const name = String(c?.label || '').trim() || `分支 ${i + 1}`
        const rules = Array.isArray(c?.rules) ? c.rules : []
        if (!rules.length) { at(`c${i}`, 'error', 'run', `「${name}」还没设条件`); return }
        rules.forEach((r, j) => {
          if (blank(r?.var)) at(`c${i}r${j}`, 'error', 'run', `「${name}」有一条条件没选要比较的内容`)
          else if (!UNARY_OPS.has(r.op) && blank(r.value)) at(`c${i}v${j}`, 'error', 'run', `「${name}」有一条条件没填比较的值`)
        })
      })
    } else if (node.type === 'template') {
      if (blank(d.template)) at('tpl', 'error', 'run', '还没写要拼成什么样')
      else if (String(d.template).length > MAX_TEXT) at('tpl', 'error', 'save', `内容太长了，最多 ${MAX_TEXT} 字`)
    } else if (node.type === 'step') {
      if (item === null) at('step', 'error', 'run', '这个积木已经下架了，删掉换一个')
      else if (item?.available === false) at('avail', 'error', 'run', item.reason || '这个积木现在用不了')
    }

    // 连线：孤立 / 没连到开始 / 结果没送到结束
    if (node.type !== 'start' && ids.has(START_ID)) {
      if (!(inc.get(node.id) || []).length) at('in', 'error', 'run', '还没连上，这一步不会运行')
      else if (!fromStart.has(node.id)) at('in', 'error', 'run', '没有连到「开始」，这一步不会运行')
    }
    if (!outputs.has(node.id) && node.type !== 'end') {
      const reach = descendants(graph, node.id)
      const ok = [...reach].some(id => outputs.has(id))
      if (!(outs.get(node.id) || []).length) at('out', 'warn', '', '后面还没接节点，这一步的结果没送到「结束」')
      else if (!ok) at('out', 'warn', '', '这一路没有接到「结束」，结果不会出现在最终结果里')
      else if (node.type === 'condition') {
        const used = new Set(edges.filter(e => e.source === node.id).map(e => e.sourceHandle))
        const idle = conditionHandles(node).filter(h => !used.has(h)).map(h => handleLabel(node, h))
        if (idle.length) at('branch', 'warn', '', `${idle.map(x => `「${x}」`).join('、')}后面还没接节点，走到那里流程就停了`)
      }
    }

    // 变量引用
    const before = ancestors(graph, node.id)
    const told = new Set()
    for (const r of referencesOf(node)) {
      const k = `${r.ref}.${r.field}`
      if (told.has(k)) continue
      told.add(k)
      if (r.ref === 'item') {
        if (!d.foreach) at(`v-${k}`, 'error', 'run', '「当前这一条」只能在打开「逐条处理」时用')
        continue
      }
      if (r.ref === 'sys') {
        if (!sys.some(s => s.key === r.field)) at(`v-${k}`, 'error', 'run', '用到了不认识的系统变量，请重新选')
        continue
      }
      const ref = nodeById(graph, r.ref)
      if (!ref) { at(`v-${k}`, 'error', 'save', '用到的结果已经不在了（那个节点删掉了），重新选一下'); continue }
      if (!before.has(r.ref)) { at(`v-${k}`, 'error', 'run', `只能用前面步骤的结果，「${nodeTitle(ref)}」不在这一步前面`); continue }
      if (ref.type === 'start' && !(ref.data?.fields || []).some(f => f.key === r.field)) {
        at(`v-${k}`, 'error', 'run', '用到的输入项已经删了，重新选一下')
      }
    }
  }
  return out
}

/** 按节点归类：{ [nodeId]: issues[] }，另有 graph 级的在 '' 下 */
export function issuesByNode(issues) {
  const map = {}
  for (const it of issues) (map[it.nodeId || ''] ||= []).push(it)
  return map
}

/* ---------- 节点卡摘要 ---------- */

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 节点卡上 1–2 行配置摘要（人话，变量换成标签） */
export function nodeSummary(node, graph, { item = null, sys = DEFAULT_SYS, skillName = '' } = {}) {
  const d = node?.data || {}
  const h = t => humanize(t, graph, { sys })
  switch (node?.type) {
    case 'start': {
      const fields = Array.isArray(d.fields) ? d.fields : []
      if (!fields.length) return '运行时不用填东西'
      return `运行时填：${fields.map(f => String(f.label || '').trim() || '没起名的输入项').join('、')}`
    }
    case 'llm': {
      const head = skillName ? `技能「${skillName}」 · ` : ''
      return d.prompt ? `${head}${clip(h(d.prompt), 56)}` : `${head}还没写要 AI 做什么`
    }
    case 'tool': {
      const args = item?.args || []
      const bits = args.filter(a => !blank(d.args?.[a.name])).map(a => `${a.label || '参数'}：${clip(h(d.args[a.name]), 18)}`)
      if (bits.length) return bits.join('；')
      return item?.summary ? clip(item.summary, 56) : '还没填参数'
    }
    case 'condition': {
      const n = (d.cases || []).length
      return n ? `${n} 个分支，都不满足时走「否则」` : '还没设分支'
    }
    case 'template':
      return d.template ? clip(h(d.template), 56) : '还没写要拼成什么样'
    case 'step': {
      const bits = []
      for (const opt of item?.options || []) {
        const v = d.options?.[opt.key]
        if (blank(v)) continue
        if (opt.type === 'select') {
          const hit = choiceList(opt).find(c => c.value === String(v))
          bits.push(hit ? hit.label : String(v))
        } else bits.push(`${opt.label || '设置'} ${clip(v, 14)}`)
      }
      return bits.join(' · ') || clip(item?.summary || '', 56) || '直接用就行'
    }
    case 'end': {
      const what = d.output ? clip(h(d.output), 48) : '前一步的结果'
      return `输出：${what}${d.page ? ' · 生成结果网页' : ''}`
    }
    default:
      return ''
  }
}

/* ---------- 自动整理布局（左 → 右分层） ---------- */

const EST_W = NODE_W
const GAP_X = COL - NODE_W
const GAP_Y = 40

function estHeight(node) {
  if (node.type === 'condition') return 92 + 30 * ((node.data?.cases || []).length + 1)
  return 104
}

/**
 * 分层：层号 = 从源头出发的最长路径；层内按上游的位置（条件节点再按分支顺序）排，减少交叉；
 * 每层尽量对齐上游的中线，再整体挪到不重叠。sizes[id] = { width, height }（画布量出来的真实尺寸，可省）。
 */
export function autoLayout(graph, sizes = {}) {
  const order = topoOrder(graph)
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const { inc } = adjacency(graph)
  const rank = new Map()
  for (const id of order) {
    const preds = (inc.get(id) || []).filter(p => rank.has(p))
    rank.set(id, preds.length ? Math.max(...preds.map(p => rank.get(p) + 1)) : 0)
  }
  const layers = []
  for (const id of order) (layers[rank.get(id)] ||= []).push(id)
  const w = id => sizes[id]?.width || EST_W
  const hgt = id => sizes[id]?.height || estHeight(byId.get(id))
  const center = new Map()   // id → y 中线
  const slot = (src, tgt) => {
    // 条件节点不同分支的下游错开：按分支序号偏移
    const s = byId.get(src)
    if (s?.type !== 'condition') return 0
    const e = graph.edges.find(x => x.source === src && x.target === tgt)
    const hs = conditionHandles(s)
    const i = Math.max(0, hs.indexOf(e?.sourceHandle ?? null))
    return (i - (hs.length - 1) / 2) * (ROW * 0.9)
  }
  const pos = {}
  let x = 0
  layers.forEach((layer, r) => {
    const want = layer.map(id => {
      const preds = (inc.get(id) || []).filter(p => center.has(p))
      const y = preds.length ? preds.reduce((s, p) => s + center.get(p) + slot(p, id), 0) / preds.length
        : byId.get(id).position.y
      return { id, want: y }
    })
    if (r === 0) want.sort((a, b) => (a.id === START_ID ? -1 : b.id === START_ID ? 1 : a.want - b.want))
    else want.sort((a, b) => a.want - b.want)
    // 依次往下放，保证间距；再整体平移，让偏离期望的总量最小
    const placed = []
    let cursor = -Infinity
    for (const it of want) {
      const top = Math.max(it.want - hgt(it.id) / 2, cursor)
      placed.push({ ...it, top })
      cursor = top + hgt(it.id) + GAP_Y
    }
    const shift = placed.reduce((s, p) => s + (p.want - (p.top + hgt(p.id) / 2)), 0) / (placed.length || 1)
    for (const p of placed) {
      const top = p.top + shift
      center.set(p.id, top + hgt(p.id) / 2)
      pos[p.id] = { x, y: Math.round(top / 4) * 4 }
    }
    x += Math.max(...layer.map(w)) + GAP_X
  })
  // 开始节点放在 (0, 0) 附近：整体平移
  const sp = pos[START_ID]
  const dy = sp ? -sp.y : 0
  const nodes = graph.nodes.map(n => {
    const p = pos[n.id]
    return p ? { ...n, position: { x: Math.round(p.x), y: Math.round(p.y + dy) } } : n
  })
  return { ...graph, nodes }
}

/* ---------- 运行事件 → 节点状态（契约 §3.3） ---------- */

export function startRunState(now = Date.now()) {
  return { status: 'running', runId: '', nodes: {}, order: [], output: null, error: '', errorNode: '', ms: 0, startedAt: now }
}

/** 事件 → 新的运行状态。另有本地事件：{type:'stopped'}（用户停止）、{type:'failed', message}（连接断了等） */
export function runReducer(state, ev) {
  const s = state || startRunState()
  if (!ev || typeof ev !== 'object') return s
  const id = ev.node_id
  const put = patch => {
    const prev = s.nodes[id] || {}
    const order = s.order.includes(id) ? s.order : [...s.order, id]
    return { ...s, order, nodes: { ...s.nodes, [id]: { ...prev, ...patch } } }
  }
  const settleRunning = (status, message) => Object.fromEntries(Object.entries(s.nodes).map(([k, v]) => (
    v.status === 'running' ? [k, { ...v, status, message: v.message || message }] : [k, v])))
  switch (ev.type) {
    case 'run_start':
      return { ...s, runId: String(ev.run_id || '') }
    case 'node_start':
      return id ? put({ status: 'running', title: ev.title || '', type: ev.node_type || '' }) : s
    case 'node_done':
      return id ? put({ status: 'ok', ms: num(ev.ms), summary: ev.summary || '', preview: ev.preview || '', output: ev.output || null }) : s
    case 'node_skip':
      return id ? put({ status: 'skipped', reason: ev.reason || '' }) : s
    case 'node_error': {
      if (!id) return s
      const next = put({ status: 'error', ms: num(ev.ms), message: ev.message || '这一步没走通' })
      return { ...next, error: ev.message || '这一步没走通', errorNode: id }
    }
    case 'run_done': {
      const ok = ev.status === 'ok'
      return {
        ...s, status: ok ? 'ok' : 'error', ms: num(ev.ms, s.ms), output: ev.output || null,
        error: ok ? '' : (s.error || ev.error || ev.output?.error || '流程没跑完'),
        nodes: settleRunning(ok ? 'ok' : 'error', ok ? '' : '没跑完'),
      }
    }
    case 'stopped':
      return { ...s, status: 'stopped', error: '', nodes: settleRunning('stopped', '已停止') }
    case 'failed':
      return { ...s, status: 'error', error: ev.message || '连接断了，流程没跑完', nodes: settleRunning('error', ev.message || '没跑完') }
    default:
      return s
  }
}

/** 连线在运行中的样子：flowing（数据正在流过去）、done、skipped，或 '' */
export function edgeRunState(edge, run) {
  if (!run || !edge) return ''
  const src = run.nodes[edge.source]
  const tgt = run.nodes[edge.target]
  if (tgt?.status === 'skipped' || src?.status === 'skipped') return 'skipped'
  if (src?.status !== 'ok') return ''
  // 条件节点：没选中的出口整串变暗
  const branch = src.output?.branch
  if (branch !== undefined && branch !== null && (edge.sourceHandle ?? null) !== branch) return 'skipped'
  if (tgt?.status === 'running') return 'flowing'
  if (tgt?.status === 'ok' || tgt?.status === 'error') return 'done'
  return run.status === 'running' ? 'flowing' : ''
}

/** 条件节点这次走了哪个出口（node_done.output.branch）；没跑或不是条件节点返回 undefined */
export function chosenBranch(run, nodeId) {
  const b = run?.nodes?.[nodeId]?.output?.branch
  return b === undefined || b === null ? undefined : b
}

/**
 * 「结果已过期」：上次运行之后又改过配置的节点，以及它们的下游（结果都可能不同了）。
 * snapshot 是开始运行时的节点图；返回节点 id 集合（只含上次跑过的节点）。
 */
export function staleNodes(graph, snapshot, run) {
  const out = new Set()
  if (!snapshot || !run) return out
  const before = new Map(snapshot.nodes.map(n => [n.id, n]))
  const changed = []
  for (const n of graph.nodes) {
    const old = before.get(n.id)
    if (!old) continue
    if (old.data !== n.data && JSON.stringify(old.data) !== JSON.stringify(n.data)) changed.push(n.id)
  }
  // 连线变了，下游的输入也变了
  const key = e => `${e.source}|${e.target}|${e.sourceHandle ?? ''}`
  const oldEdges = new Set(snapshot.edges.map(key))
  const newEdges = new Set(graph.edges.map(key))
  for (const e of graph.edges) if (!oldEdges.has(key(e))) changed.push(e.target)
  for (const e of snapshot.edges) if (!newEdges.has(key(e)) && nodeById(graph, e.target)) changed.push(e.target)
  for (const id of changed) {
    out.add(id)
    for (const d of descendants(graph, id)) out.add(d)
  }
  for (const id of [...out]) if (!run.nodes?.[id] || run.nodes[id].status === 'running') out.delete(id)
  return out
}

/** 用到某节点结果的其它节点（删它之前提醒） */
export function dependents(graph, id) {
  return graph.nodes.filter(n => n.id !== id && referencesOf(n).some(r => r.ref === id))
}

/** 复制节点（不带连线），放在旁边一点 */
export function duplicateNode(graph, id) {
  const src = nodeById(graph, id)
  if (!src || src.type === 'start') return { graph, error: '「开始」节点只能有一个' }
  if (graph.nodes.length >= MAX_NODES) return { graph, error: LIMIT_MSG }
  const node = { id: nextNodeId(graph), type: src.type, position: freeSpot(graph, { x: src.position.x + 32, y: src.position.y + ROW }, null), data: clone(src.data) }
  return { graph: addNode(graph, node), error: '', id: node.id }
}

/** 毫秒 → 「0.8 秒」「12 秒」「1 分 5 秒」 */
export function fmtMs(ms) {
  const v = num(ms)
  if (v < 1000) return `${Math.max(0.1, Math.round(v / 100) / 10)} 秒`
  if (v < 10_000) return `${Math.round(v / 100) / 10} 秒`
  if (v < 60_000) return `${Math.round(v / 1000)} 秒`
  const m = Math.floor(v / 60_000)
  return `${m} 分 ${Math.round((v - m * 60_000) / 1000)} 秒`
}

/* ---------- 撤销 / 重做 ---------- */

export const HISTORY_LIMIT = 50
const MERGE_MS = 600

export function createHistory(present) {
  return { past: [], present, future: [], group: '', at: 0, base: null }
}

/**
 * 记一步。group 相同且间隔很短（连续打字）时合并成一步。
 */
export function commit(h, next, { group = '', now = Date.now() } = {}) {
  if (next === h.present && !h.base) return h
  const merge = !!group && group === h.group && now - h.at < MERGE_MS && !h.base
  const prev = h.base ?? h.present
  const past = merge ? h.past : [...h.past, prev].slice(-HISTORY_LIMIT)
  if (next === prev && h.base) return { ...h, present: next, base: null }
  return { past, present: next, future: [], group, at: now, base: null }
}

/** 临时改动（拖动中）：先不记步，settle 时整段算一步 */
export function transient(h, next) {
  if (next === h.present) return h
  return { ...h, present: next, base: h.base ?? h.present }
}

export function settle(h, opts) {
  if (!h.base) return h
  return commit({ ...h }, h.present, { ...opts, group: '' })
}

export function undo(h) {
  const s = settle(h)
  if (!s.past.length) return s
  return { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future], group: '', at: 0, base: null }
}

export function redo(h) {
  const s = settle(h)
  if (!s.future.length) return s
  return { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1), group: '', at: 0, base: null }
}

export const canUndo = h => h.past.length > 0 || !!h.base
export const canRedo = h => h.future.length > 0
