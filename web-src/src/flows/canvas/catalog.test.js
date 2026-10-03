import { describe, expect, it } from 'vitest'
import { indexCatalog, itemKeyOf, itemOf, needsPlugin, searchCatalog, unavailableReason } from './catalog.js'
import { CATALOG } from './testFixtures.js'

describe('节点目录索引', () => {
  const idx = indexCatalog(CATALOG)

  it('分组按 基础 / 插件工具 / 技能 / 积木 排；基础缺的补上；开始节点不进面板', () => {
    expect(idx.groups.map(g => g.id)).toEqual(['basic', 'tools', 'skills', 'steps'])
    expect(idx.groups[0].items.map(i => i.key)).toEqual(['llm', 'condition', 'template', 'end'])
    expect(idx.byKey.has('start')).toBe(false)
    expect(idx.sys.map(s => s.key)).toEqual(['date', 'time'])
    expect(idx.skills.map(s => s.key)).toEqual(['skill:work_report'])
  })

  it('插件工具按插件分类分小组；可用的排前面', () => {
    const tools = idx.groups.find(g => g.id === 'tools')
    expect(tools.sections.map(p => p.label)).toEqual(['效率', '生活'])
    expect(tools.sections[1].items.map(i => i.title)).toEqual(['查实时天气', '查快递'])
    expect(idx.outputs.tool).toEqual(['text', 'items', 'links', 'files'])
    const steps = idx.groups.find(g => g.id === 'steps')
    expect(steps.items.map(i => i.key)).toEqual(['step:to_todo', 'step:feishu_send'])
  })

  it('节点 ↔ 目录项：没加载返回 undefined，下架返回 null', () => {
    const tool = { type: 'tool', data: { plugin: 'weather', tool: 'weather__now' } }
    expect(itemKeyOf(tool)).toBe('tool:weather:weather__now')
    expect(itemOf(idx, tool).title).toBe('查实时天气')
    expect(itemOf(idx, { type: 'tool', data: { plugin: 'x', tool: 'y' } })).toBeNull()
    expect(itemOf(idx, { type: 'llm', data: { skill: 'gone' } })).toBeNull()
    expect(itemOf(idx, { type: 'llm', data: {} }).key).toBe('llm')
    expect(itemOf(idx, { type: 'condition', data: {} }).key).toBe('condition')
    expect(itemOf(indexCatalog(null), tool)).toBeUndefined()
    expect(indexCatalog(null).groups[0].items).toHaveLength(4)
  })

  it('不可用原因与「去加插件」', () => {
    const exp = idx.byKey.get('tool:express:express__track')
    expect(unavailableReason(exp)).toMatch('还没装「快递」')
    expect(needsPlugin(exp)).toBe(true)
    expect(unavailableReason(idx.byKey.get('llm'))).toBe('')
    expect(unavailableReason({ available: false })).toBe('当前账号暂时用不了')
  })

  it('搜索：标题、简介、插件名都算', () => {
    expect(searchCatalog(idx, '天气').map(g => g.id)).toEqual(['tools'])
    expect(searchCatalog(idx, '快递')[0].sections[0].items.map(p => p.title)).toEqual(['查快递'])
    expect(searchCatalog(idx, '').length).toBe(4)
    expect(searchCatalog(idx, '不存在的东西')).toEqual([])
  })
})
