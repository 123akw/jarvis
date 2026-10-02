/* 流程拼接的纯逻辑：积木清单、步骤增删移动、校验（说人话）、运行事件 → 节点状态。
 * 不碰 DOM，方便单测；Flows.jsx 只负责把这些状态画出来。 */

export const MAX_STEPS = 8
export const ROLES = ['input', 'process', 'output']
export const ROLE_LABEL = { input: '输入', process: '处理', output: '输出' }

/** requires → 灰显原因（插件自带 reason 时优先用它） */
const REQUIRE_REASON = {
  feishu_bound: '先在设置里绑定飞书才能用',
  wechat_owner: '微信只对管理员账号开放',
  desktop: '需要先打开桌面端',
}

export function unavailableReason(plugin) {
  if (!plugin || plugin.available !== false) return ''
  if (plugin.reason) return plugin.reason
  const req = (plugin.requires || []).find(r => REQUIRE_REASON[r])
  return req ? REQUIRE_REASON[req] : '当前账号暂时用不了'
}

export const roleOf = plugin => plugin?.step?.role || null

/** catalog → 能当积木用的插件，按 id 建表。只认 kind=step：流程引擎只接受九个积木 id，
 *  feishu / wechat / todo 这类对话技能即使带了 step 也不能直接当积木 */
export function stepPlugins(catalog) {
  const list = (catalog?.plugins || []).filter(p => p && p.kind === 'step' && p.step && ROLES.includes(p.step.role))
  return { list, byId: Object.fromEntries(list.map(p => [p.id, p])) }
}

/** 积木面板分组：输入 / 处理 / 输出，组内可用的排前面 */
export function groupByRole(list) {
  return ROLES.map(role => ({
    role,
    label: ROLE_LABEL[role],
    items: list.filter(p => p.step.role === role)
      .sort((a, b) => Number(a.available === false) - Number(b.available === false)),
  })).filter(g => g.items.length)
}

/** 模板：当前职业的排前面，没有职业信息就按 catalog 顺序全列 */
export function templateGroups(catalog, profession) {
  const profs = (catalog?.professions || []).filter(p => Array.isArray(p.flows) && p.flows.length)
  const mine = profs.filter(p => p.id === profession)
  const rest = profs.filter(p => p.id !== profession)
  return [...mine.map(p => ({ ...p, mine: true })), ...rest]
}

let seq = 0
export const localId = () => `tmp-${++seq}`

/** option.choices 兼容字符串与 {value,label} 两种写法 */
export function choiceList(opt) {
  return (opt?.choices || []).map(c => (c && typeof c === 'object')
    ? { value: String(c.value ?? c.id ?? c.label), label: String(c.label ?? c.name ?? c.value) }
    : { value: String(c), label: String(c) })
}

export function defaultOptions(plugin) {
  const out = {}
  for (const opt of plugin?.step?.options || []) {
    if (opt.default !== undefined && opt.default !== null) out[opt.key] = opt.default
    else if (opt.type === 'select') { const first = choiceList(opt)[0]; if (first) out[opt.key] = first.value }
  }
  return out
}

/** 积木面板里某个积木现在能不能加：输入只能有一个且在第一步，结果网页一个流程只要一个 */
export function pickBlocker(plugin, steps, byId) {
  if (plugin.available === false) return unavailableReason(plugin)
  if (plugin.step?.role === 'input' && steps.some(s => roleOf(byId[s.plugin]) === 'input')) return '已经有输入了，一个流程只要一个输入'
  if (plugin.id === 'web_page' && steps.some(s => s.plugin === 'web_page')) return '一个流程只要一个结果网页'
  return ''
}

/** 选中的积木放哪：输入总是放第一步，其余放在点「+」的位置 */
export function insertIndex(plugin, at) {
  return plugin.step?.role === 'input' ? 0 : at
}

export function makeStep(plugin, options) {
  return { id: localId(), plugin: plugin.id, options: { ...defaultOptions(plugin), ...(options || {}) } }
}

/** 一行配置摘要：select 显示选项名，text 截断，number 带单位感；没配置的用插件简介兜底 */
export function optionSummary(step, plugin) {
  const opts = plugin?.step?.options || []
  const bits = []
  for (const opt of opts) {
    const v = step.options?.[opt.key]
    if (v === undefined || v === null || v === '') continue
    if (opt.type === 'select') {
      const hit = choiceList(opt).find(c => c.value === String(v))
      bits.push(hit ? hit.label : String(v))
    } else if (opt.type === 'number') {
      bits.push(`${opt.label || opt.key} ${v}`)
    } else {
      const s = String(v).trim()
      bits.push(s.length > 14 ? `${s.slice(0, 14)}…` : s)
    }
  }
  return bits.join(' · ') || plugin?.summary || ''
}

/* ---- 步骤编辑（都返回新数组） ---- */
export function insertStep(steps, index, step) {
  const next = steps.slice()
  next.splice(Math.max(0, Math.min(index, steps.length)), 0, step)
  return next
}
export function removeStep(steps, id) {
  return steps.filter(s => s.id !== id)
}
export function moveStep(steps, id, delta) {
  const i = steps.findIndex(s => s.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= steps.length) return steps
  const next = steps.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}
export function patchOptions(steps, id, patch) {
  return steps.map(s => (s.id === id ? { ...s, options: { ...s.options, ...patch } } : s))
}

/** 校验（与流程引擎一致）：返回给人看的问题列表，空数组 = 可以保存。名字可以空，服务端会叫它「未命名流程」 */
export function validate(name, steps, byId) {
  const problems = []
  if (!steps.length) return ['先加一个积木，从「输入」开始']
  if (steps.some(s => !byId[s.plugin])) problems.push('有个积木已经下架了，删掉它再保存')
  if (roleOf(byId[steps[0].plugin]) !== 'input' && byId[steps[0].plugin]) problems.push('第一步要是输入，比如「文字输入」或「资料上传」')
  if (steps.slice(1).some(s => roleOf(byId[s.plugin]) === 'input')) problems.push('输入只能放在第一步')
  if (!steps.some(s => roleOf(byId[s.plugin]) === 'output')) problems.push('还差一个输出，比如「生成网页与二维码」')
  if (steps.filter(s => s.plugin === 'web_page').length > 1) problems.push('「生成网页与二维码」一个流程只要一个')
  if (steps.length > MAX_STEPS) problems.push(`最多 ${MAX_STEPS} 步，先删掉 ${steps.length - MAX_STEPS} 步`)
  return problems
}

/** 能保存但跑不了的：积木对当前账号不可用（引擎在运行开始时才查，这里提前说） */
export function runBlockers(steps, byId) {
  return steps.map(s => byId[s.plugin]).filter(p => p?.available === false)
    .map(p => `「${p.name}」现在用不了：${unavailableReason(p)}`)
    .filter((v, i, a) => a.indexOf(v) === i)
}

/* ---- 运行：事件 → 节点状态 ----
 * 节点状态：idle（没在跑）· pending（排队）· running · done · error · skipped（前面失败了）· cancelled
 * step_id 对不上时（老数据 / 服务端换了 id）按 step_start 的先后顺序落到第 n 个节点。 */
export function startRun(steps) {
  return {
    status: 'running', runId: null, output: null, error: '', cursor: -1,
    nodes: Object.fromEntries(steps.map(s => [s.id, { state: 'pending' }])),
    order: steps.map(s => s.id),
  }
}

function resolveIndex(run, stepId, fallback) {
  const i = run.order.indexOf(stepId)
  return i >= 0 ? i : fallback
}

export function applyEvent(run, ev) {
  if (!run || !ev) return run
  const set = (i, patch) => {
    const id = run.order[i]
    if (id === undefined) return run
    return { ...run, nodes: { ...run.nodes, [id]: { ...run.nodes[id], ...patch } } }
  }
  switch (ev.type) {
    case 'run_start':
      return { ...run, runId: ev.run_id ?? null }
    case 'step_start': {
      const i = resolveIndex(run, ev.step_id, run.cursor + 1)
      return { ...set(i, { state: 'running' }), cursor: i }
    }
    case 'step_done': {
      const i = resolveIndex(run, ev.step_id, run.cursor)
      return set(i, { state: 'done', summary: ev.summary || '', preview: ev.preview || '', ms: ev.ms ?? null })
    }
    case 'step_error': {
      const i = resolveIndex(run, ev.step_id, run.cursor)
      const next = set(i, { state: 'error', message: ev.message || '这一步没走通', ms: ev.ms ?? null })
      return { ...skipRest(next, i), status: 'error', error: ev.message || '这一步没走通', cursor: i }
    }
    case 'run_done': {
      const status = ev.status === 'ok' ? 'ok' : 'error'
      let next = { ...run, status, output: ev.output || null }
      if (status === 'error' && !next.error) next.error = ev.message || '流程没跑完'
      return status === 'error' ? skipRest(next, -1) : next
    }
    default:
      return run
  }
}

/** 失败 / 取消后：还在排队或跑着的节点收尾 */
function skipRest(run, errIndex, state = 'skipped') {
  const nodes = { ...run.nodes }
  run.order.forEach((id, i) => {
    if (i === errIndex) return
    if (nodes[id].state === 'pending' || nodes[id].state === 'running') nodes[id] = { ...nodes[id], state }
  })
  return { ...run, nodes }
}

export function cancelRun(run) {
  if (!run || run.status !== 'running') return run
  return { ...skipRest(run, -1, 'cancelled'), status: 'cancelled' }
}

/** 流没正常收尾（连接断了、没等到 run_done） */
export function abortRun(run, message) {
  if (!run || run.status !== 'running') return run
  return { ...skipRest(run, -1), status: 'error', error: message }
}

/** 第 i 段连线（节点 i → i+1）的状态：flowing（信号在走）· lit（已通过）· idle */
export function linkState(run, i) {
  if (!run) return 'idle'
  const from = run.nodes[run.order[i]]?.state
  const to = run.nodes[run.order[i + 1]]?.state
  if (to === 'done' || to === 'error') return 'lit'
  if (to === 'running') return 'flowing'
  if (from === 'done' && to === 'pending' && run.status === 'running') return 'flowing'
  return 'idle'
}

/* ---- 时间与状态文案 ---- */
export const RUN_STATUS = { ok: '成功', error: '失败', running: '运行中', cancelled: '已取消' }

export function relTime(iso, now = Date.now()) {
  if (!iso) return ''
  const t = typeof iso === 'number' ? (iso < 1e12 ? iso * 1000 : iso) : Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 耗时：800 毫秒 / 1.2 秒 / 1 分 5 秒 */
export function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`
}

/** 运行记录里的输入说明：文件名 / 字数 */
export function inputLabel(input) {
  if (!input) return ''
  if (input.kind === 'file') return input.name || '一个文件'
  if (input.kind === 'text') return input.chars ? `${input.chars} 字` : '一段文字'
  return ''
}

/** 结果链接补成绝对地址（二维码要给手机扫） */
export function absUrl(url) {
  if (!url) return ''
  try { return new URL(url, window.location.origin).href } catch { return url }
}
