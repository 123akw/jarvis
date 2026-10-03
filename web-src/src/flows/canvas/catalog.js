/* 节点目录（GET /api/flows/nodes，契约 §3.2）→ 画布用的索引：分组、按 key 找项、节点 ↔ 目录项、搜索。
 * 纯逻辑，不碰 DOM。 */
import { DEFAULT_SYS, TYPE_INFO } from '../graph.js'

/** 目录没给基础节点时的兜底（接口没就绪 / 老后端） */
const BASIC_FALLBACK = [
  { key: 'llm', type: 'llm', title: 'AI 处理', summary: '让 AI 按你的要求处理前面的内容', data: { title: 'AI 处理', prompt: '', output: 'text' } },
  { key: 'condition', type: 'condition', title: '条件分支', summary: '按条件走不同的路', data: { title: '条件分支' } },
  { key: 'template', type: 'template', title: '文本拼接', summary: '把前面几步的结果拼成一段话', data: { title: '文本拼接', template: '' } },
  { key: 'approval', type: 'approval', title: '发送前确认', icon: '✋', summary: '跑到这里先停下，你看过、点同意再往下发',
    data: { title: '发送前确认', message: '', editable: true, timeout_hours: 24 } },
  { key: 'end', type: 'end', title: '结束', summary: '最终结果长什么样，要不要生成结果网页', data: { title: '结束', output: '', page: false } },
]

const GROUP_ORDER = ['basic', 'tools', 'skills', 'steps']
const GROUP_LABEL = { basic: '基础', tools: '插件工具', skills: '技能', steps: '积木' }
export const GROUP_HINT = {
  basic: '每个流程都用得上',
  tools: '已装插件的功能，直接当一步用',
  skills: '带说明书的 AI 处理',
  steps: '现成的处理 / 输出积木',
}

/** 节点 → 它在目录里的 key（与契约里的 key 写法一致） */
export function itemKeyOf(node) {
  const d = node?.data || {}
  if (node?.type === 'tool') return `tool:${d.plugin || ''}:${d.tool || ''}`
  if (node?.type === 'step') return `step:${d.step || ''}`
  if (node?.type === 'llm' && d.skill) return `skill:${d.skill}`
  return node?.type || ''
}

/** 目录项自己的 key：优先用接口给的 key，没有就按 data 推 */
function keyOfItem(item, groupId) {
  if (item.key) return String(item.key)
  const d = item.data || {}
  if (item.type === 'tool') return `tool:${d.plugin || item.plugin || ''}:${d.tool || ''}`
  if (item.type === 'step') return `step:${d.step || ''}`
  if (groupId === 'skills' || d.skill) return `skill:${d.skill || ''}`
  return item.type
}

export function unavailableReason(item) {
  if (!item || item.available !== false) return ''
  return String(item.reason || '').trim() || '当前账号暂时用不了'
}

/** 让「去加插件」按钮出现：智能体账号没装插件、需要启用的情况 */
export function needsPlugin(item) {
  if (!item || item.available !== false) return false
  return item.type === 'tool' || item.type === 'step' || !!item.plugin || /插件|装|加上/.test(String(item.reason || ''))
}

/**
 * 规整目录：{ groups: [{ id, label, hint, items }], byKey: Map, sys, skills, outputs, loaded }。
 * 工具组另带 sections: [{ id, label, items }]（按插件分类：效率、沟通、资料、资讯、生活…）。
 */
export function indexCatalog(raw) {
  const groupsIn = Array.isArray(raw?.groups) ? raw.groups : []
  const byKey = new Map()
  const groups = []
  for (const g of groupsIn) {
    if (!g || !Array.isArray(g.items)) continue
    const id = String(g.id || '')
    const items = []
    for (const it of g.items) {
      if (!it || !TYPE_INFO[it.type] || it.type === 'start') continue
      const item = { ...it, key: keyOfItem(it, id), group: id, title: it.title || it.data?.title || TYPE_INFO[it.type].label }
      if (byKey.has(item.key)) continue
      byKey.set(item.key, item)
      items.push(item)
    }
    groups.push({ id, label: g.label || GROUP_LABEL[id] || '其它', hint: GROUP_HINT[id] || '', items })
  }
  // 基础组兜底：缺哪个补哪个
  let basic = groups.find(g => g.id === 'basic')
  if (!basic) { basic = { id: 'basic', label: GROUP_LABEL.basic, hint: GROUP_HINT.basic, items: [] }; groups.unshift(basic) }
  for (const fb of BASIC_FALLBACK) {
    if (!byKey.has(fb.key)) {
      const item = { ...fb, group: 'basic' }
      byKey.set(item.key, item)
      basic.items.push(item)
    }
  }
  groups.sort((a, b) => rank(a.id) - rank(b.id))
  for (const g of groups) {
    // 组内可用的排前面
    g.items = g.items.slice().sort((a, b) => Number(a.available === false) - Number(b.available === false))
    if (g.id === 'tools') g.sections = toolSections(g.items, Array.isArray(raw?.categories) ? raw.categories : [])
  }
  const sysRaw = Array.isArray(raw?.vars?.sys) ? raw.vars.sys.filter(s => s && s.key) : []
  const skills = (groups.find(g => g.id === 'skills')?.items || []).filter(it => it.data?.skill)
  return {
    groups: groups.filter(g => g.items.length),
    byKey,
    sys: sysRaw.length ? sysRaw.map(s => ({ key: String(s.key), label: String(s.label || s.key) })) : DEFAULT_SYS,
    skills,
    outputs: raw?.outputs && typeof raw.outputs === 'object' ? raw.outputs : null,
    loaded: !!raw,
  }
}

const rank = id => { const i = GROUP_ORDER.indexOf(id); return i < 0 ? GROUP_ORDER.length : i }

/** 插件工具按插件分类分小组（分类顺序沿用接口给的 categories），组内可用的排前面 */
function toolSections(items, categories) {
  const order = categories.map(c => String(c.id))
  const label = Object.fromEntries(categories.map(c => [String(c.id), c.name || c.label || '']))
  const map = new Map()
  for (const it of items) {
    const cat = String(it.category || '')
    if (!map.has(cat)) map.set(cat, { id: cat || 'other', label: label[cat] || '其它', items: [] })
    map.get(cat).items.push(it)
  }
  const at = id => { const i = order.indexOf(id); return i < 0 ? order.length : i }
  return [...map.values()].sort((a, b) => at(a.id) - at(b.id))
}

/**
 * 节点在目录里的那项：目录没加载返回 undefined（不判断），加载了但找不到返回 null（下架了）。
 * 基础节点（AI 处理、条件…）总能找到。
 */
export function itemOf(index, node) {
  if (!index?.loaded || !node) return undefined
  if (node.type === 'start') return undefined
  const key = itemKeyOf(node)
  if (index.byKey.has(key)) return index.byKey.get(key)
  if (node.type === 'llm' && node.data?.skill) return null
  if (BASIC_TYPES.includes(node.type)) return index.byKey.get(node.type) || undefined
  return null
}

const BASIC_TYPES = ['llm', 'condition', 'template', 'approval', 'end']

/* 试跑一步时的提醒（契约 §3.2）：会往外发东西的积木 / 会写数据的工具，试跑只看内容、不真的发送 / 写入。
 * 目录项带 side_effect（'send' | 'write'）时以它为准；老目录没有就按积木 / 工具名推。 */
const SEND_STEPS = new Set(['feishu_send', 'wechat_send'])
const WRITE_STEPS = new Set(['feishu_doc', 'to_todo'])
const WRITE_TOOL = /(^|_)(add|del|delete|remove|done|remember|forget|create|update|write|set|send|post|save|start|stop|book|cancel)(_|$)/i

/** 节点试跑时的副作用：'send'（会发出去）· 'write'（会写进去）· 'confirm'（发送前确认）· ''（没有） */
export function sideEffectOf(node, item) {
  if (!node) return ''
  if (node.type === 'approval') return 'confirm'
  const flag = item?.side_effect
  if (flag === 'send' || flag === 'write') return flag
  if (flag === true) return node.type === 'step' && item?.role === 'output' ? 'send' : 'write'
  if (flag === false) return ''
  if (node.type === 'step') {
    const step = node.data?.step || ''
    if (SEND_STEPS.has(step)) return 'send'
    if (WRITE_STEPS.has(step)) return 'write'
    return ''
  }
  if (node.type === 'tool') return WRITE_TOOL.test(String(node.data?.tool || '').split('__').pop()) ? 'write' : ''
  return ''
}

/** 试跑前的一句提醒（人话） */
export const SIDE_EFFECT_HINT = {
  send: '试跑只看要发的内容，不会真的发送',
  write: '试跑不会真的写入，只看看会写什么',
  confirm: '试跑只看给你确认的内容，不会真的发给你确认',
}

/** 搜索：标题、简介、插件名都算；返回与 groups 同形但只留命中的 */
export function searchCatalog(index, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return index.groups
  const hit = it => [it.title, it.summary, it.plugin_name, TYPE_INFO[it.type]?.label]
    .some(s => String(s || '').toLowerCase().includes(q))
  return index.groups.map(g => {
    const items = g.items.filter(hit)
    return { ...g, items, sections: g.sections ? g.sections.map(p => ({ ...p, items: p.items.filter(hit) })).filter(p => p.items.length) : undefined }
  }).filter(g => g.items.length)
}

/** 节点在卡片 / 面板上的图标：目录项的 emoji 优先，没有就用类型图形 */
export function iconOf(index, node) {
  const item = itemOf(index, node)
  return item?.icon || ''
}
