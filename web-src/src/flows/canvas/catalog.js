/* 节点目录（GET /api/flows/nodes，契约 §3.2）→ 画布用的索引：分组、按 key 找项、节点 ↔ 目录项、搜索。
 * 纯逻辑，不碰 DOM。 */
import { DEFAULT_SYS, TYPE_INFO } from '../graph.js'

/** 目录没给基础节点时的兜底（接口没就绪 / 老后端） */
const BASIC_FALLBACK = [
  { key: 'llm', type: 'llm', title: 'AI 处理', summary: '让 AI 按你的要求处理前面的内容', data: { title: 'AI 处理', prompt: '', output: 'text' } },
  { key: 'condition', type: 'condition', title: '条件分支', summary: '按条件走不同的路', data: { title: '条件分支' } },
  { key: 'template', type: 'template', title: '文本拼接', summary: '把前面几步的结果拼成一段话', data: { title: '文本拼接', template: '' } },
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
 * 规整目录：{ groups: [{ id, label, hint, items }], byKey: Map, sys, skills, empty }。
 * 工具组另带 plugins: [{ id, name, category, items }]（按插件分类显示）。
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
    if (g.id === 'tools') g.plugins = byPlugin(g.items)
  }
  const sysRaw = Array.isArray(raw?.vars?.sys) ? raw.vars.sys.filter(s => s && s.key) : []
  const skills = (groups.find(g => g.id === 'skills')?.items || []).filter(it => it.data?.skill)
  return {
    groups: groups.filter(g => g.items.length),
    byKey,
    sys: sysRaw.length ? sysRaw.map(s => ({ key: String(s.key), label: String(s.label || s.key) })) : DEFAULT_SYS,
    skills,
    loaded: !!raw,
  }
}

const rank = id => { const i = GROUP_ORDER.indexOf(id); return i < 0 ? GROUP_ORDER.length : i }

function byPlugin(items) {
  const map = new Map()
  for (const it of items) {
    const pid = it.plugin || it.data?.plugin || ''
    if (!map.has(pid)) map.set(pid, { id: pid, name: it.plugin_name || '插件', category: it.category || '', icon: it.icon || '', items: [] })
    map.get(pid).items.push(it)
  }
  return [...map.values()].sort((a, b) => Number(a.items.every(i => i.available === false)) - Number(b.items.every(i => i.available === false))
    || String(a.category).localeCompare(String(b.category)))
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
  if (['llm', 'condition', 'template', 'end'].includes(node.type)) return index.byKey.get(node.type) || undefined
  return null
}

/** 搜索：标题、简介、插件名都算；返回与 groups 同形但只留命中的 */
export function searchCatalog(index, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return index.groups
  const hit = it => [it.title, it.summary, it.plugin_name, TYPE_INFO[it.type]?.label]
    .some(s => String(s || '').toLowerCase().includes(q))
  return index.groups.map(g => {
    const items = g.items.filter(hit)
    return { ...g, items, plugins: g.plugins ? g.plugins.map(p => ({ ...p, items: p.items.filter(hit) })).filter(p => p.items.length) : undefined }
  }).filter(g => g.items.length)
}

/** 节点在卡片 / 面板上的图标：目录项的 emoji 优先，没有就用类型图形 */
export function iconOf(index, node) {
  const item = itemOf(index, node)
  return item?.icon || ''
}
