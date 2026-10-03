import { afterEach, describe, expect, it } from 'vitest'
import {
  blankDraft, catalogIndex, chainLabel, clearDraft, copyName, describeNode, DRAFT_KEY, fmtMs, graphPlugins, humanVars,
  nextRun, nodeInfo, orderNodes, readDraft, relTime, safeHref, scheduleLabel, startFields, thumbLayout, whenLabel, writeDraft,
} from './flowkit.js'

const node = (id, type, data = {}, x = 0, y = 0) => ({ id, type, position: { x, y }, data })
const edge = (source, target, sourceHandle = null) => ({ id: `${source}-${target}`, source, target, sourceHandle })

/* 开始 → (查天气 / 查日程) → AI 写早报 → 发飞书 → 结束 */
const MORNING = {
  nodes: [
    node('end', 'end', { title: '结束', output: '{{n1.text}}', page: true }, 1200, 0),
    node('n1', 'llm', { title: '写成早报', prompt: '根据{{w.text}}和{{s.text}}写早报，今天是{{sys.weekday}}' }, 600, 0),
    node('s', 'tool', { title: '', plugin: 'schedule', tool: 'schedule__list', args: { range: '今天' } }, 300, 60),
    node('w', 'tool', { title: '查实时天气', plugin: 'weather', tool: 'weather__now', args: { city: '{{start.city}}' } }, 300, -60),
    node('start', 'start', { title: '开始', fields: [{ key: 'city', label: '城市', type: 'text', required: true }, { key: 'file', label: '附件', type: 'file' }] }, 0, 0),
    node('f', 'step', { step: 'feishu_send', options: {} }, 900, 0),
  ],
  edges: [edge('start', 'w'), edge('start', 's'), edge('w', 'n1'), edge('s', 'n1'), edge('n1', 'f'), edge('f', 'end')],
}

const CATALOG = {
  groups: [
    { id: 'tools', items: [
      { type: 'tool', title: '查日程', icon: '📅', plugin_name: '日程提醒', available: true,
        data: { plugin: 'schedule', tool: 'schedule__list' }, args: [{ name: 'range', label: '时间范围' }] },
      { type: 'tool', title: '查快递', icon: '📦', plugin_name: '快递查询', available: false, reason: '还没装「快递查询」',
        data: { plugin: 'kuaidi100', tool: 'kuaidi100__track' } },
    ] },
    { id: 'skills', items: [{ type: 'llm', title: '周报月报', icon: '📈', data: { skill: 'work_report' } }] },
    { id: 'steps', items: [{ type: 'step', title: '发到飞书', icon: '📨', available: false, reason: '先绑定飞书', role: 'output', data: { step: 'feishu_send' } }] },
  ],
}

describe('flowkit：节点与图', () => {
  it('按连线排先后：开始在最前，同一批按位置从上到下', () => {
    expect(orderNodes(MORNING).map(n => n.id)).toEqual(['start', 'w', 's', 'n1', 'f', 'end'])
    // 坏连线（指向不存在的节点）忽略，有环的节点排在后面也不丢
    const g = { nodes: [node('a', 'llm'), node('b', 'llm'), node('start', 'start')], edges: [edge('a', 'b'), edge('b', 'a'), edge('x', 'a')] }
    expect(orderNodes(g).map(n => n.id)).toEqual(['start', 'a', 'b'])
    expect(orderNodes(null)).toEqual([])
  })

  it('节点名字与图标：标题优先，没标题按目录 / 核心积木兜底', () => {
    const idx = catalogIndex(CATALOG)
    const s = MORNING.nodes.find(n => n.id === 's')
    expect(nodeInfo(s)).toMatchObject({ name: '插件工具', icon: '🧩', tone: 'tool' })
    expect(nodeInfo(s, idx)).toMatchObject({ name: '查日程', icon: '📅' })
    expect(nodeInfo(node('x', 'step', { step: 'web_page' }))).toMatchObject({ name: '生成网页与二维码', icon: '🔗', tone: 'out' })
    expect(nodeInfo(node('x', 'llm', { skill: 'work_report' }), idx)).toMatchObject({ name: '周报月报', icon: '📈', tone: 'ai' })
    expect(chainLabel(MORNING)).toBe('开始 → 查实时天气 → 插件工具 → 写成早报 → 发到飞书 → 结束')
  })

  it('目录 → 插件能不能用；流程用到的插件', () => {
    const idx = catalogIndex(CATALOG)
    expect(idx.plugin.kuaidi100).toMatchObject({ name: '快递查询', available: false, reason: '还没装「快递查询」' })
    expect(idx.plugin.feishu_send).toMatchObject({ available: false })
    expect(graphPlugins(MORNING)).toEqual(['schedule', 'weather', 'feishu_send'])
  })

  it('变量说人话；每个节点一句话说明', () => {
    const idx = catalogIndex(CATALOG)
    expect(humanVars('根据{{w.text}}，城市{{start.city}}，{{sys.date}}，{{zz.text}}，{{ item }}', MORNING))
      .toBe('根据「查实时天气 · 文字」，城市「城市」，「今天日期」，「前面的结果」，「当前这一条」')
    const by = id => MORNING.nodes.find(n => n.id === id)
    expect(describeNode(by('start'), MORNING)).toBe('运行时填：城市（一行字）、附件（一个文件）')
    expect(describeNode(by('s'), MORNING, idx)).toBe('用插件「日程提醒」，时间范围：今天')
    expect(describeNode(by('n1'), MORNING)).toContain('「查实时天气 · 文字」')
    expect(describeNode(by('end'), MORNING)).toContain('结果网页')
    expect(describeNode(node('c', 'condition', { cases: [{ id: 'a', label: '下雨' }] }), MORNING)).toBe('按条件分开走：下雨 / 其他情况')
    expect(startFields(MORNING).map(f => f.key)).toEqual(['city', 'file'])
  })

  it('缩略图：按 position 等比缩放进框里，连线右出左进', () => {
    const lay = thumbLayout(MORNING, { w: 360, h: 128, pad: 16, maxScale: 0.42 })
    expect(lay.nodes).toHaveLength(6)
    expect(lay.edges).toHaveLength(6)
    for (const n of lay.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(15.9)
      expect(n.x + n.w).toBeLessThanOrEqual(344.1)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y + n.h).toBeLessThanOrEqual(128)
    }
    const start = lay.nodes.find(n => n.id === 'start')
    const w = lay.nodes.find(n => n.id === 'w')
    const nums = lay.edges[0].d.match(/-?\d+(\.\d+)?/g).map(Number)
    expect(nums[0]).toBeCloseTo(start.x + start.w, 0)
    expect(nums[1]).toBeCloseTo(start.y + start.h / 2, 0)
    expect(nums[6]).toBeCloseTo(w.x, 0)
    expect(nums[7]).toBeCloseTo(w.y + w.h / 2, 0)
    // 节点很少时不画得太大
    expect(thumbLayout(blankDraft().graph, { w: 600, h: 200, pad: 16, maxScale: 0.42 }).scale).toBe(0.42)
  })

  it('缩略图：位置缺失或全挤在一处时按层次自动排开', () => {
    const g = { nodes: MORNING.nodes.map(n => ({ ...n, position: { x: 0, y: 0 } })), edges: MORNING.edges }
    const lay = thumbLayout(g)
    const at = id => lay.nodes.find(n => n.id === id)
    expect(at('start').x).toBeLessThan(at('w').x)
    expect(at('w').x).toBe(at('s').x)
    expect(at('w').y).not.toBe(at('s').y)
    expect(at('n1').x).toBeLessThan(at('end').x)
    expect(thumbLayout({ nodes: [] }).nodes).toEqual([])
  })
})

describe('flowkit：定时运行', () => {
  const MON_9 = new Date(2026, 9, 5, 9, 0)   // 2026-10-05 周一 09:00

  it('下次运行：每天 / 工作日 / 每周几', () => {
    expect(nextRun({ repeat: 'daily', time: '08:00' }, MON_9)).toEqual(new Date(2026, 9, 6, 8, 0))
    expect(nextRun({ repeat: 'daily', time: '21:30' }, MON_9)).toEqual(new Date(2026, 9, 5, 21, 30))
    expect(nextRun({ repeat: 'weekdays', time: '08:00' }, new Date(2026, 9, 9, 9, 0))).toEqual(new Date(2026, 9, 12, 8, 0))   // 周五 → 下周一
    expect(nextRun({ repeat: 'weekly', time: '08:00', weekday: 1 }, MON_9)).toEqual(new Date(2026, 9, 12, 8, 0))
    expect(nextRun({ repeat: 'weekly', time: '08:00', weekday: 7 }, MON_9)).toEqual(new Date(2026, 9, 11, 8, 0))
    expect(nextRun({ repeat: 'daily', time: '25:00' }, MON_9)).toBeNull()
  })

  it('「明天 08:00」这样的人话', () => {
    expect(whenLabel(new Date(2026, 9, 5, 21, 30), MON_9)).toBe('今天 21:30')
    expect(whenLabel(new Date(2026, 9, 6, 8, 0), MON_9)).toBe('明天 08:00')
    expect(whenLabel(new Date(2026, 9, 7, 8, 0), MON_9)).toBe('后天 08:00')
    expect(whenLabel(new Date(2026, 9, 9, 8, 0), MON_9)).toBe('周五 08:00')
    expect(whenLabel(new Date(2026, 9, 12, 8, 0), MON_9)).toBe('10月12日（周一）08:00')
    expect(whenLabel(null, MON_9)).toBe('')
  })

  it('定时标记文案', () => {
    expect(scheduleLabel({ repeat: 'weekdays', time: '08:00' })).toBe('每个工作日 08:00')
    expect(scheduleLabel({ repeat: 'weekly', time: '18:30', weekday: 5 })).toBe('每周五 18:30')
    expect(scheduleLabel({ repeat: 'daily', time: '07:05' })).toBe('每天 07:05')
    expect(scheduleLabel({ repeat: 'daily', time: 'x' })).toBe('')
  })
})

describe('flowkit：草稿与文案', () => {
  afterEach(() => { sessionStorage.clear() })

  it('草稿交接：写进 jvf-draft，读出来，清掉；坏数据当没有', () => {
    const d = blankDraft()
    expect(d.graph.nodes.map(n => n.type)).toEqual(['start', 'llm', 'end'])
    expect(writeDraft({ ...d, name: '很长'.repeat(30) })).toBe(true)
    expect(readDraft().name).toHaveLength(30)
    expect(readDraft().graph).toEqual(d.graph)
    clearDraft()
    expect(readDraft()).toBeNull()
    sessionStorage.setItem(DRAFT_KEY, '{坏')
    expect(readDraft()).toBeNull()
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name: 'x' }))
    expect(readDraft()).toBeNull()
  })

  it('复制的名字不超过 30 字', () => {
    expect(copyName('早报')).toBe('早报 副本')
    expect(copyName('长'.repeat(30))).toHaveLength(30)
    expect(copyName('')).toBe('未命名流程 副本')
  })

  it('时间、用时、链接', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    expect(relTime('2026-10-05T11:59:30Z', now)).toBe('刚刚')
    expect(relTime('2026-10-05T09:00:00Z', now)).toBe('3 小时前')
    expect(relTime('2026-10-03T12:00:00Z', now)).toBe('2 天前')
    expect(relTime('', now)).toBe('')
    expect(fmtMs(820)).toBe('820 毫秒')
    expect(fmtMs(12400)).toBe('12.4 秒')
    expect(fmtMs(65000)).toBe('1 分 5 秒')
    expect(fmtMs(null)).toBe('')
    expect(safeHref('/r/abc')).toBe('/r/abc')
    expect(safeHref('https://x.cn/r')).toBe('https://x.cn/r')
    expect(safeHref('javascript:alert(1)')).toBe('')
    expect(safeHref('//evil.com')).toBe('')
  })
})
