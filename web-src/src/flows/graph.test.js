import { describe, expect, it } from 'vitest'
import {
  addNode, ancestors, autoLayout, canConnect, canRedo, canUndo, cleanGraph, commit, conditionHandles, connect,
  createHistory, createNode, defaultOptions, edgeRunState, emptyGraph, fmtMs, handleLabel, hasCycle, humanize,
  insertAfter, insertOnEdge, issuesByNode, MAX_EDGES, MAX_NODES, moveNodes, nextEdgeId, nextNodeId, nodeSummary,
  normalizeGraph, outputsOf, parseVars, redo, referencesOf, removeEdges, removeNodes, renameRefs, runReducer,
  settle, splitVars, startRunState, topoOrder, transient, undo, updateNodeData, upstream, validateGraph, varLabel,
  varOptions,
} from './graph.js'

/* ---- 小工厂 ---- */
const N = (id, type, data = {}, x = 0, y = 0) => ({ id, type, position: { x, y }, data })
const E = (id, source, target, sourceHandle = null) => ({ id, source, target, sourceHandle })
const START = N('start', 'start', { title: '开始', fields: [{ key: 'text', label: '要处理的文字', type: 'paragraph', required: true }] })

/** start → n1(AI) → n2(条件: c1/else) → n3(拼接, c1) / n4(工具, else) → end */
function branchy() {
  return {
    nodes: [
      START,
      N('n1', 'llm', { title: 'AI 处理', prompt: '总结 {{start.text}}', output: 'text' }, 320),
      N('n2', 'condition', { title: '条件分支', cases: [{ id: 'c1', label: '有待办', logic: 'and', rules: [{ var: 'n1.text', op: 'contains', value: '待办' }] }] }, 640),
      N('n3', 'template', { title: '文本拼接', template: '待办：{{n1.text}}' }, 960, -80),
      N('n4', 'tool', { title: '查天气', plugin: 'weather', tool: 'weather__now', args: { city: '北京' } }, 960, 80),
      N('end', 'end', { title: '结束', output: '{{n3.text}}', page: false }, 1280),
    ],
    edges: [
      E('e1', 'start', 'n1'), E('e2', 'n1', 'n2'), E('e3', 'n2', 'n3', 'c1'), E('e4', 'n2', 'n4', 'else'),
      E('e5', 'n3', 'end'), E('e6', 'n4', 'end'),
    ],
  }
}

const TOOL_ITEM = {
  key: 'tool:weather:weather__now', type: 'tool', title: '查实时天气', available: true,
  args: [{ name: 'city', label: '城市', type: 'string', required: true }, { name: 'unit', label: '单位', required: false, default: '摄氏' }],
  data: { title: '查实时天气', plugin: 'weather', tool: 'weather__now', args: {} },
}
const itemOfFor = items => node => {
  if (node.type === 'tool') return items[`tool:${node.data.plugin}:${node.data.tool}`] ?? null
  if (node.type === 'step') return items[`step:${node.data.step}`] ?? null
  return undefined
}

describe('基础：id、空图、规整', () => {
  it('nextNodeId / nextEdgeId 取最大编号 + 1', () => {
    const g = branchy()
    expect(nextNodeId(g)).toBe('n5')
    expect(nextEdgeId(g)).toBe('e7')
    expect(nextNodeId({ nodes: [START], edges: [] })).toBe('n1')
  })

  it('emptyGraph 是 开始 → 结束，且能过校验的结构项', () => {
    const g = emptyGraph()
    expect(g.nodes.map(n => n.type)).toEqual(['start', 'end'])
    expect(g.edges).toHaveLength(1)
    expect(validateGraph(g).filter(i => i.block === 'save')).toEqual([])
  })

  it('normalizeGraph：空 / 坏数据给空白流程；补开始；丢悬空、重复、自连的线；补线 id', () => {
    expect(normalizeGraph(null).nodes[0].id).toBe('start')
    expect(normalizeGraph({ nodes: [] }).nodes).toHaveLength(2)
    const g = normalizeGraph({
      nodes: [N('n1', 'llm', { prompt: 'x' }, 10, 0), N('end', 'end', {}, 20, 0), { id: 'bad', type: 'nope' }, N('n1', 'llm')],
      edges: [{ source: 'n1', target: 'end' }, { source: 'n1', target: 'end' }, { source: 'n1', target: 'ghost' }, { source: 'n1', target: 'n1' }],
    })
    expect(g.nodes.map(n => n.id)).toEqual(['start', 'n1', 'end'])
    expect(g.edges).toEqual([{ id: 'e1', source: 'n1', target: 'end', sourceHandle: null }])
  })

  it('normalizeGraph：位置全挤在一处时自动整理', () => {
    const g = normalizeGraph({ nodes: [START, N('n1', 'llm'), N('end', 'end')], edges: [E('e1', 'start', 'n1'), E('e2', 'n1', 'end')] })
    const xs = g.nodes.map(n => n.position.x)
    expect(new Set(xs).size).toBe(3)
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
  })

  it('cleanGraph 只留契约字段并取整', () => {
    const g = cleanGraph({ nodes: [{ ...START, position: { x: 1.6, y: 2.2 }, selected: true, measured: {} }], edges: [{ ...E('e1', 'a', 'b'), animated: true }] })
    expect(g.nodes[0]).toEqual({ id: 'start', type: 'start', position: { x: 2, y: 2 }, data: START.data })
    expect(g.edges[0]).toEqual({ id: 'e1', source: 'a', target: 'b', sourceHandle: null })
  })
})

describe('节点增删改', () => {
  it('createNode：按类型补默认值，深拷贝 data，开始节点造不了', () => {
    const g = emptyGraph()
    const llm = createNode(g, { type: 'llm', title: 'AI 处理', data: {} }, { x: 10.4, y: 3 })
    expect(llm).toMatchObject({ id: 'n1', type: 'llm', position: { x: 10, y: 3 }, data: { title: 'AI 处理', prompt: '', output: 'text' } })
    const tool = createNode(g, TOOL_ITEM)
    expect(tool.data.args).toEqual({ unit: '摄氏' })
    expect(TOOL_ITEM.data.args).toEqual({})   // 没改到目录
    const cond = createNode(g, { type: 'condition', data: {} })
    expect(conditionHandles(cond)).toEqual(['c1', 'else'])
    const step = createNode(g, { type: 'step', options: [{ key: 'task', type: 'select', choices: ['要点', '待办'] }, { key: 'n', type: 'number', default: 3 }], data: { step: 'ai_extract', options: {} } })
    expect(step.data.options).toEqual({ task: '要点', n: 3 })
    expect(createNode(g, { type: 'start' })).toBeNull()
    expect(createNode(g, { type: 'weird' })).toBeNull()
  })

  it('createNode：已有结束节点时新的结束用 n 编号', () => {
    const g = emptyGraph()
    expect(createNode(g, { type: 'end' }).id).toBe('n1')
    expect(createNode({ nodes: [START], edges: [] }, { type: 'end' }).id).toBe('end')
  })

  it('addNode 不重复加；updateNodeData 合并或函数改', () => {
    const g = emptyGraph()
    expect(addNode(g, g.nodes[0])).toBe(g)
    const g2 = updateNodeData(g, 'end', { page: true })
    expect(g2.nodes[1].data).toMatchObject({ title: '结束', page: true })
    const g3 = updateNodeData(g2, 'end', d => ({ ...d, output: 'x' }))
    expect(g3.nodes[1].data.output).toBe('x')
    expect(updateNodeData(g, 'ghost', { a: 1 })).toBe(g)
  })

  it('删掉条件分支时，挂在那个出口上的线一起去掉', () => {
    const g = branchy()
    const g2 = updateNodeData(g, 'n2', d => ({ ...d, cases: [] }))
    expect(g2.edges.find(e => e.id === 'e3')).toBeUndefined()
    expect(g2.edges.find(e => e.id === 'e4')).toBeDefined()
  })

  it('moveNodes 只改变了的', () => {
    const g = emptyGraph()
    expect(moveNodes(g, { start: { x: 0, y: 0 } })).toBe(g)
    expect(moveNodes(g, { end: { x: 5, y: 6 } }).nodes[1].position).toEqual({ x: 5, y: 6 })
  })

  it('removeNodes：开始删不掉；连着的线一起删；链中间删一步自动接上', () => {
    const g = branchy()
    expect(removeNodes(g, ['start'])).toBe(g)
    const g2 = removeNodes(g, ['n1'])
    expect(g2.nodes.find(n => n.id === 'n1')).toBeUndefined()
    expect(g2.edges.some(e => e.source === 'start' && e.target === 'n2')).toBe(true)
    // 删条件节点：前面一条线 → 接到它两个下游
    const g3 = removeNodes(g, ['n2'])
    expect(g3.edges.filter(e => e.source === 'n1').map(e => e.target).sort()).toEqual(['n3', 'n4'])
    // 不愈合
    const g4 = removeNodes(g, ['n1'], { heal: false })
    expect(g4.edges.some(e => e.source === 'start')).toBe(false)
    // 删多个不愈合
    const g5 = removeNodes(g, ['n3', 'n4'])
    expect(g5.edges.map(e => e.id)).toEqual(['e1', 'e2'])
  })
})

describe('连线', () => {
  it('canConnect 各种拒绝原因', () => {
    const g = branchy()
    expect(canConnect(g, { source: 'n1', target: 'n1' })).toMatch('自己')
    expect(canConnect(g, { source: 'n1', target: 'start' })).toMatch('「开始」前面')
    expect(canConnect(g, { source: 'end', target: 'n1' })).toMatch('「结束」后面')
    expect(canConnect(g, { source: 'n2', target: 'end', sourceHandle: null })).toMatch('分支')
    expect(canConnect(g, { source: 'n1', target: 'n2' })).toMatch('已经连上')
    expect(canConnect(g, { source: 'n3', target: 'n1' })).toMatch('绕圈')
    expect(canConnect(g, { source: 'n1', target: 'ghost' })).toMatch('不存在')
    expect(canConnect(g, { source: 'n2', target: 'end', sourceHandle: 'c1' })).toBe('')
    expect(canConnect(g, { source: 'start', target: 'end' })).toBe('')
  })

  it('连线上限', () => {
    const nodes = [START, ...Array.from({ length: 20 }, (_, i) => N(`n${i + 1}`, 'template', { template: 'x' }))]
    const edges = []
    for (let i = 1; i <= 20 && edges.length < MAX_EDGES; i += 1) {
      for (let j = i + 1; j <= 20 && edges.length < MAX_EDGES; j += 1) edges.push(E(`e${edges.length + 1}`, `n${i}`, `n${j}`))
    }
    expect(canConnect({ nodes, edges }, { source: 'start', target: 'n1' })).toMatch(`${MAX_EDGES}`)
  })

  it('connect 成功给新 id；失败原样返回带原因', () => {
    const g = emptyGraph()
    const a = addNode(g, N('n1', 'llm', { prompt: 'x' }))
    const r = connect(a, { source: 'start', target: 'n1' })
    expect(r.error).toBe('')
    expect(r.graph.edges.at(-1)).toEqual({ id: 'e2', source: 'start', target: 'n1', sourceHandle: null })
    const bad = connect(a, { source: 'end', target: 'n1' })
    expect(bad.graph).toBe(a)
    expect(bad.error).toBeTruthy()
  })

  it('removeEdges', () => {
    const g = branchy()
    expect(removeEdges(g, ['nope'])).toBe(g)
    expect(removeEdges(g, ['e1', 'e2']).edges).toHaveLength(4)
  })

  it('handleLabel：分支名、否则、没起名的按序号', () => {
    const cond = N('c', 'condition', { cases: [{ id: 'a', label: '' }, { id: 'b', label: '晴天' }] })
    expect(handleLabel(cond, 'a')).toBe('分支 1')
    expect(handleLabel(cond, 'b')).toBe('晴天')
    expect(handleLabel(cond, 'else')).toBe('否则')
    expect(handleLabel(N('x', 'llm'), null)).toBe('')
  })
})

describe('插入（自动连线）', () => {
  it('insertAfter：链中间插一步，原来的下游改接到新节点后面并右移让位', () => {
    const g = emptyGraph()
    const node = createNode(g, { type: 'llm', data: { prompt: 'x' } })
    const { graph, error } = insertAfter(g, 'start', null, node)
    expect(error).toBe('')
    expect(graph.edges.map(e => `${e.source}>${e.target}`).sort()).toEqual(['n1>end', 'start>n1'])
    const end = graph.nodes.find(n => n.id === 'end')
    const n1 = graph.nodes.find(n => n.id === 'n1')
    expect(end.position.x).toBeGreaterThan(n1.position.x)
  })

  it('insertAfter：新节点是结束时另起一条，不改原有连线', () => {
    const g = addNode(emptyGraph(), N('n1', 'llm', { prompt: 'x' }, 300))
    const g1 = connect(g, { source: 'start', target: 'n1' }).graph
    const node = createNode(g1, { type: 'end' })
    const { graph } = insertAfter(g1, 'n1', null, node)
    expect(graph.edges.some(e => e.source === 'n1' && e.target === node.id)).toBe(true)
    expect(graph.edges.some(e => e.source === 'start' && e.target === 'end')).toBe(true)
  })

  it('insertAfter：条件节点指定分支出口；新条件节点把原下游接在第一个分支上', () => {
    const g = branchy()
    const node = createNode(g, { type: 'template', data: { template: 'y' } })
    const r = insertAfter(g, 'n2', 'else', node)
    expect(r.graph.edges.find(e => e.target === node.id)).toMatchObject({ source: 'n2', sourceHandle: 'else' })
    expect(r.graph.edges.find(e => e.target === 'n4')).toMatchObject({ source: node.id, sourceHandle: null })
    const cond = createNode(g, { type: 'condition', data: {} })
    const r2 = insertAfter(g, 'n1', null, cond)
    expect(r2.graph.edges.find(e => e.target === 'n2')).toMatchObject({ source: cond.id, sourceHandle: 'c1' })
  })

  it('insertAfter：结束后面接不了；节点数到上限也加不了', () => {
    const g = emptyGraph()
    expect(insertAfter(g, 'end', null, createNode(g, { type: 'llm' })).error).toMatch('结束')
    const full = { nodes: [START, ...Array.from({ length: MAX_NODES - 1 }, (_, i) => N(`n${i + 1}`, 'llm'))], edges: [] }
    expect(insertAfter(full, 'start', null, createNode(full, { type: 'llm' })).error).toMatch(`${MAX_NODES}`)
  })

  it('insertOnEdge：source → 新节点 → target；结束插不进中间', () => {
    const g = emptyGraph()
    const node = createNode(g, { type: 'template', data: { template: 'z' } })
    const { graph, error } = insertOnEdge(g, 'e1', node)
    expect(error).toBe('')
    expect(graph.edges.map(e => `${e.source}>${e.target}`).sort()).toEqual(['n1>end', 'start>n1'])
    expect(insertOnEdge(g, 'e1', createNode(g, { type: 'end' })).error).toMatch('最后')
    expect(insertOnEdge(g, 'ghost', node).error).toBeTruthy()
  })
})

describe('拓扑序 / 祖先', () => {
  it('topoOrder：开始最先，同层按位置', () => {
    expect(topoOrder(branchy())).toEqual(['start', 'n1', 'n2', 'n3', 'n4', 'end'])
  })

  it('有环时 hasCycle 为真，topoOrder 仍列出全部节点', () => {
    const g = branchy()
    const cyc = { ...g, edges: [...g.edges, E('x', 'n3', 'n1')] }
    expect(hasCycle(cyc)).toBe(true)
    expect(hasCycle(g)).toBe(false)
    expect(topoOrder(cyc).sort()).toEqual(['end', 'n1', 'n2', 'n3', 'n4', 'start'])
  })

  it('ancestors / upstream 按拓扑序', () => {
    const g = branchy()
    expect([...ancestors(g, 'n3')].sort()).toEqual(['n1', 'n2', 'start'])
    expect(upstream(g, 'end').map(n => n.id)).toEqual(['start', 'n1', 'n2', 'n3', 'n4'])
    expect(upstream(g, 'start')).toEqual([])
  })
})

describe('变量', () => {
  it('parseVars / splitVars：识别 {{节点.字段}} 与 {{item}}，容忍空格', () => {
    const vs = parseVars('A {{n1.text}} B {{ sys.date }} {{item}} {{bad}} {{x.}}')
    expect(vs.map(v => [v.ref, v.field])).toEqual([['n1', 'text'], ['sys', 'date'], ['item', '']])
    expect(splitVars('前{{n1.text}}后')).toEqual([
      { kind: 'text', text: '前' }, { kind: 'var', raw: '{{n1.text}}', ref: 'n1', field: 'text' }, { kind: 'text', text: '后' },
    ])
    expect(splitVars('')).toEqual([])
  })

  it('outputsOf 按类型', () => {
    expect(outputsOf(START)).toEqual([{ field: 'text', label: '要处理的文字' }])
    expect(outputsOf(N('a', 'llm', { output: 'text' })).map(o => o.field)).toEqual(['text'])
    expect(outputsOf(N('a', 'llm', { output: 'list' })).map(o => o.field)).toEqual(['text', 'items'])
    expect(outputsOf(N('a', 'step'), { produces: ['links'] }).map(o => o.field)).toEqual(['text', 'links'])
    expect(outputsOf(N('a', 'step')).length).toBe(5)
    expect(outputsOf(N('a', 'condition'))).toEqual([])
    expect(outputsOf(N('a', 'end'))).toEqual([])
  })

  it('varLabel：人话标签，引用不在了标 broken', () => {
    const g = branchy()
    expect(varLabel(g, 'n1', 'text')).toEqual({ label: 'AI 处理 · 文字', broken: false })
    expect(varLabel(g, 'start', 'text')).toEqual({ label: '开始 · 要处理的文字', broken: false })
    expect(varLabel(g, 'start', 'gone').broken).toBe(true)
    expect(varLabel(g, 'sys', 'date')).toEqual({ label: '系统 · 今天日期', broken: false })
    expect(varLabel(g, 'ghost', 'text')).toEqual({ label: '已删除的节点 · 文字', broken: true })
    expect(varLabel(g, 'item', '').label).toBe('当前这一条')
  })

  it('humanize 把变量换成「标签」', () => {
    expect(humanize('总结 {{start.text}}，日期 {{sys.date}}', branchy())).toBe('总结 「开始 · 要处理的文字」，日期 「系统 · 今天日期」')
  })

  it('varOptions：只给祖先（按拓扑序）+ 系统变量；条件 / 结束没有产出不列', () => {
    const groups = varOptions(branchy(), 'n3')
    expect(groups.map(g => g.id)).toEqual(['start', 'n1', 'sys'])
    expect(groups[1].vars[0]).toMatchObject({ token: '{{n1.text}}', label: 'AI 处理 · 文字', short: '文字' })
    expect(varOptions(branchy(), 'start').map(g => g.id)).toEqual(['sys'])
    const fe = updateNodeData(branchy(), 'n3', { foreach: '{{n1.items}}' })
    expect(varOptions(fe, 'n3')[0].vars[0].token).toBe('{{item}}')
  })

  it('referencesOf 含条件规则的 var；renameRefs 换引用', () => {
    const g = branchy()
    expect(referencesOf(g.nodes[2])).toEqual([{ ref: 'n1', field: 'text', raw: 'n1.text' }])
    expect(referencesOf(g.nodes[3]).map(r => r.ref)).toEqual(['n1'])
    const d = renameRefs({ a: '{{n1.text}} {{n10.text}}', cases: [{ rules: [{ var: 'n1.items' }] }] }, 'n1', 'n9')
    expect(d).toEqual({ a: '{{n9.text}} {{n10.text}}', cases: [{ rules: [{ var: 'n9.items' }] }] })
  })
})

describe('校验', () => {
  const msgs = (issues, nodeId) => issues.filter(i => i.nodeId === nodeId).map(i => i.message)

  it('完整的分支流程没有拦运行的问题', () => {
    const issues = validateGraph(branchy(), { itemOf: itemOfFor({ 'tool:weather:weather__now': TOOL_ITEM }) })
    expect(issues.filter(i => i.block)).toEqual([])
  })

  it('结构问题拦保存：没开始、没结束、环、超上限、连错', () => {
    const noEnd = { nodes: [START, N('n1', 'llm', { prompt: 'x' })], edges: [E('e1', 'start', 'n1')] }
    expect(validateGraph(noEnd).find(i => i.key === 'g-end')).toMatchObject({ block: 'save' })
    const noStart = { nodes: [N('end', 'end')], edges: [] }
    expect(validateGraph(noStart).find(i => i.key === 'g-start')).toMatchObject({ block: 'save' })
    const g = branchy()
    const cyc = { ...g, edges: [...g.edges, E('x', 'n3', 'n1')] }
    expect(validateGraph(cyc).some(i => i.key === 'g-cycle' && i.block === 'save')).toBe(true)
    const big = { nodes: [START, ...Array.from({ length: MAX_NODES }, (_, i) => N(`n${i + 1}`, 'end'))], edges: [] }
    expect(validateGraph(big).some(i => i.key === 'g-nodes')).toBe(true)
    const bad = { ...g, edges: [...g.edges, E('x1', 'end', 'n1'), E('x2', 'n1', 'start'), E('x3', 'n1', 'ghost')] }
    const keys = validateGraph(bad).filter(i => i.key.startsWith('x-')).map(i => i.message)
    expect(keys).toEqual(['「结束」后面不能再接节点', '「开始」前面不能再接节点', '有连线连到了不存在的节点'])
  })

  it('缺必填拦运行：AI 没写要求、工具缺参数 / 不可用 / 下架、拼接为空、条件没设、积木下架', () => {
    const g = {
      nodes: [
        START,
        N('n1', 'llm', { prompt: '  ' }),
        N('n2', 'tool', { plugin: 'weather', tool: 'weather__now', args: {} }),
        N('n3', 'tool', { plugin: 'x', tool: 'y', args: {} }),
        N('n4', 'template', { template: '' }),
        N('n5', 'condition', { cases: [{ id: 'c1', label: '', rules: [] }, { id: 'c2', label: '晴', rules: [{ var: '', op: 'equals' }, { var: 'n1.text', op: 'equals', value: '' }, { var: 'n1.text', op: 'empty', value: '' }] }] }),
        N('n6', 'step', { step: 'gone', options: {} }),
        N('n7', 'tool', { plugin: 'off', tool: 't', args: {} }),
        N('end', 'end'),
      ],
      edges: [],
    }
    for (let i = 1; i <= 7; i += 1) g.edges.push(E(`e${i}`, i === 1 ? 'start' : `n${i - 1}`, `n${i}`, i === 6 ? null : null))
    g.edges = g.edges.filter(e => e.source !== 'n5')
    g.edges.push(E('e8', 'n5', 'n6', 'c1'), E('e9', 'n7', 'end'))
    const itemOf = itemOfFor({ 'tool:weather:weather__now': TOOL_ITEM, 'tool:off:t': { type: 'tool', available: false, reason: '这个智能体还没装「快递」，到智能体设置里加上就能用', args: [] } })
    const issues = validateGraph(g, { itemOf })
    expect(msgs(issues, 'n1')).toContain('还没写要 AI 做什么')
    expect(msgs(issues, 'n2')).toContain('还没填「城市」')
    expect(msgs(issues, 'n3')).toContain('这个插件工具不在了，删掉换一个')
    expect(msgs(issues, 'n4')).toContain('还没写要拼成什么样')
    expect(msgs(issues, 'n5')).toEqual(expect.arrayContaining(['「分支 1」还没设条件', '「晴」有一条条件没选要比较的内容', '「晴」有一条条件没填比较的值']))
    expect(msgs(issues, 'n5').filter(m => m.includes('比较的值'))).toHaveLength(1)   // 「是空的」不用填值
    expect(msgs(issues, 'n6')).toContain('这个积木已经下架了，删掉换一个')
    expect(msgs(issues, 'n7')[0]).toMatch('还没装「快递」')
    expect(issues.filter(i => i.nodeId && i.level === 'error').every(i => i.block === 'run')).toBe(true)
  })

  it('目录没加载（itemOf 返回 undefined）时不判断工具 / 积木', () => {
    const g = { nodes: [START, N('n1', 'tool', { plugin: 'x', tool: 'y' }), N('end', 'end')], edges: [E('e1', 'start', 'n1'), E('e2', 'n1', 'end')] }
    expect(validateGraph(g).filter(i => i.nodeId === 'n1')).toEqual([])
  })

  it('孤立节点、没连到开始、结果没送到结束、分支没接', () => {
    const g = {
      nodes: [START, N('n1', 'llm', { prompt: 'x' }), N('n2', 'llm', { prompt: 'y' }), N('n3', 'template', { template: 'z' }),
        N('n4', 'condition', { cases: [{ id: 'c1', label: '是', rules: [{ var: 'start.text', op: 'not_empty' }] }] }), N('end', 'end')],
      edges: [E('e1', 'start', 'n1'), E('e2', 'n2', 'n3'), E('e3', 'start', 'n4'), E('e4', 'n4', 'end', 'c1')],
    }
    const issues = validateGraph(g)
    expect(msgs(issues, 'n1')).toContain('后面还没接节点，这一步的结果没送到「结束」')
    expect(msgs(issues, 'n2')).toContain('还没连上：从前面的节点拉一条线过来')
    expect(msgs(issues, 'n3')).toContain('没有连到「开始」，运行时走不到这里')
    expect(msgs(issues, 'n4')[0]).toMatch('「否则」后面还没接节点')
    expect(issues.find(i => i.nodeId === 'n1' && i.key.endsWith('-out')).level).toBe('warn')
    const deadBranch = { ...g, edges: [...g.edges, E('e5', 'n1', 'n2')] }
    expect(msgs(validateGraph(deadBranch), 'n1')).toContain('这一路没有接到「结束」，结果不会出现在最终结果里')
  })

  it('变量引用：已删除节点拦保存；不在前面、输入项删了、item 不在逐条里拦运行', () => {
    const g = {
      nodes: [START, N('n1', 'llm', { prompt: '{{ghost.text}} {{n2.text}} {{start.nope}} {{item}} {{sys.date}} {{sys.bogus}}' }), N('n2', 'llm', { prompt: 'x' }), N('end', 'end')],
      edges: [E('e1', 'start', 'n1'), E('e2', 'n1', 'n2'), E('e3', 'n2', 'end')],
    }
    const issues = validateGraph(g).filter(i => i.nodeId === 'n1')
    expect(issues.find(i => i.message.includes('已删除节点')).block).toBe('save')
    expect(issues.map(i => i.message)).toEqual(expect.arrayContaining([
      '用到了「AI 处理」的结果，但它不在这一步前面', '用到的输入项已经删了，请重新选',
      '「当前这一条」只能在逐条处理时用', '用到了不认识的系统变量，请重新选',
    ]))
    expect(issues.some(i => i.message.includes('今天日期'))).toBe(false)
  })

  it('开始节点的输入项：超 8 个、内部名字不对、没名字、选项没写选项', () => {
    const fields = Array.from({ length: 9 }, (_, i) => ({ key: `f${i}`, label: `项${i}`, type: 'text' }))
    fields[1] = { key: 'Bad', label: 'x', type: 'text' }
    fields[2] = { key: 'f2', label: ' ', type: 'text' }
    fields[3] = { key: 'f3', label: '颜色', type: 'select', options: ['', ' '] }
    const g = { nodes: [N('start', 'start', { fields }), N('end', 'end')], edges: [E('e1', 'start', 'end')] }
    const m = msgs(validateGraph(g), 'start')
    expect(m).toEqual(expect.arrayContaining(['输入项最多 8 个', '第 2 个输入项的内部名字不对，删掉重加一个', '第 3 个输入项还没起名字', '「颜色」是选项，还没写有哪些选项']))
  })

  it('issuesByNode 分组', () => {
    const map = issuesByNode([{ nodeId: 'a', message: '1' }, { nodeId: null, message: '2' }, { nodeId: 'a', message: '3' }])
    expect(map.a).toHaveLength(2)
    expect(map['']).toHaveLength(1)
  })
})

describe('节点卡摘要', () => {
  it('各类型一句话，变量换成人话', () => {
    const g = branchy()
    expect(nodeSummary(g.nodes[0], g)).toBe('运行时填：要处理的文字')
    expect(nodeSummary(g.nodes[1], g)).toBe('总结 「开始 · 要处理的文字」')
    expect(nodeSummary(g.nodes[1], g, { skillName: '周报写手' })).toMatch(/^技能「周报写手」/)
    expect(nodeSummary(g.nodes[2], g)).toBe('1 个分支，都不满足时走「否则」')
    expect(nodeSummary(g.nodes[3], g)).toBe('待办：「AI 处理 · 文字」')
    expect(nodeSummary(g.nodes[4], g, { item: TOOL_ITEM })).toBe('城市：北京')
    expect(nodeSummary(g.nodes[5], g)).toBe('输出：「文本拼接 · 文字」')
    expect(nodeSummary(N('e', 'end', { output: '', page: true }), g)).toBe('输出：前一步的结果 · 生成结果网页')
    expect(nodeSummary(N('s', 'step', { options: { task: 'b' } }), g, { item: { options: [{ key: 'task', type: 'select', choices: [{ value: 'b', label: '待办' }] }] } })).toBe('待办')
    expect(nodeSummary(N('s', 'start', { fields: [] }), g)).toBe('运行时不用填东西')
    expect(nodeSummary(N('x', 'llm', { prompt: 'a'.repeat(100) }), g).length).toBeLessThan(60)
  })

  it('defaultOptions', () => {
    expect(defaultOptions([{ key: 'a', type: 'select', choices: [{ value: 'x', label: 'X' }] }, { key: 'b', type: 'text' }, { key: 'c', default: 0 }])).toEqual({ a: 'x', c: 0 })
  })
})

describe('自动整理', () => {
  it('左 → 右分层；开始在原点；同层不重叠；分支上下错开', () => {
    const g = autoLayout(branchy())
    const p = Object.fromEntries(g.nodes.map(n => [n.id, n.position]))
    expect(p.start).toEqual({ x: 0, y: 0 })
    expect(p.start.x).toBeLessThan(p.n1.x)
    expect(p.n1.x).toBeLessThan(p.n2.x)
    expect(p.n3.x).toBe(p.n4.x)
    expect(Math.abs(p.n3.y - p.n4.y)).toBeGreaterThanOrEqual(104)
    expect(p.n3.y).toBeLessThan(p.n4.y)   // 第一个分支在上
    expect(p.end.x).toBeGreaterThan(p.n3.x)
  })

  it('用量出来的尺寸排；孤立节点放第一列', () => {
    const g = { nodes: [START, N('lone', 'llm', {}, 999, 999), N('end', 'end')], edges: [E('e1', 'start', 'end')] }
    const out = autoLayout(g, { start: { width: 400, height: 100 } })
    const p = Object.fromEntries(out.nodes.map(n => [n.id, n.position]))
    expect(p.lone.x).toBe(0)
    expect(p.end.x).toBeGreaterThanOrEqual(400)
    expect(Math.abs(p.lone.y - p.start.y)).toBeGreaterThanOrEqual(100)
  })
})

describe('运行事件 → 节点状态', () => {
  it('完整一次运行', () => {
    let s = startRunState(1)
    s = runReducer(s, { type: 'run_start', run_id: 'r1' })
    s = runReducer(s, { type: 'node_start', node_id: 'start', node_type: 'start', title: '开始' })
    s = runReducer(s, { type: 'node_done', node_id: 'start', ms: 3, summary: '收到 12 字', output: { text: 'hi' } })
    s = runReducer(s, { type: 'node_start', node_id: 'n1' })
    expect(s.nodes.n1.status).toBe('running')
    s = runReducer(s, { type: 'node_skip', node_id: 'n3', reason: '没走到这条分支' })
    s = runReducer(s, { type: 'node_done', node_id: 'n1', ms: 1200, preview: '…' })
    s = runReducer(s, { type: 'run_done', status: 'ok', ms: 1500, output: { text: '结果', links: [] } })
    expect(s).toMatchObject({ status: 'ok', runId: 'r1', ms: 1500, output: { text: '结果' } })
    expect(s.order).toEqual(['start', 'n1', 'n3'])
    expect(s.nodes.start).toMatchObject({ status: 'ok', ms: 3, summary: '收到 12 字' })
    expect(s.nodes.n3).toMatchObject({ status: 'skipped', reason: '没走到这条分支' })
  })

  it('出错：节点标红，整条带上错误原因', () => {
    let s = runReducer(startRunState(), { type: 'node_start', node_id: 'n1' })
    s = runReducer(s, { type: 'node_error', node_id: 'n1', message: '天气接口超时', ms: 30000 })
    s = runReducer(s, { type: 'run_done', status: 'error', ms: 30100 })
    expect(s).toMatchObject({ status: 'error', error: '天气接口超时', errorNode: 'n1' })
    expect(s.nodes.n1.status).toBe('error')
  })

  it('停止 / 断线：正在跑的节点收尾', () => {
    let s = runReducer(startRunState(), { type: 'node_start', node_id: 'n1' })
    expect(runReducer(s, { type: 'stopped' })).toMatchObject({ status: 'stopped', nodes: { n1: { status: 'stopped' } } })
    expect(runReducer(s, { type: 'failed', message: '网络断了' })).toMatchObject({ status: 'error', error: '网络断了', nodes: { n1: { status: 'error' } } })
    expect(runReducer(s, { type: 'whatever' })).toBe(s)
    expect(runReducer(s, null)).toBe(s)
  })

  it('edgeRunState', () => {
    const run = { status: 'running', nodes: { a: { status: 'ok' }, b: { status: 'running' }, c: { status: 'skipped' }, d: { status: 'ok' } } }
    expect(edgeRunState(E('1', 'a', 'b'), run)).toBe('flowing')
    expect(edgeRunState(E('2', 'a', 'c'), run)).toBe('skipped')
    expect(edgeRunState(E('3', 'a', 'd'), run)).toBe('done')
    expect(edgeRunState(E('4', 'a', 'x'), run)).toBe('flowing')
    expect(edgeRunState(E('5', 'b', 'x'), run)).toBe('')
    expect(edgeRunState(E('6', 'a', 'x'), { ...run, status: 'ok' })).toBe('')
    expect(edgeRunState(E('7', 'a', 'b'), null)).toBe('')
  })

  it('fmtMs', () => {
    expect(fmtMs(30)).toBe('0.1 秒')
    expect(fmtMs(850)).toBe('0.9 秒')
    expect(fmtMs(1234)).toBe('1.2 秒')
    expect(fmtMs(12_400)).toBe('12 秒')
    expect(fmtMs(65_000)).toBe('1 分 5 秒')
  })
})

describe('撤销 / 重做', () => {
  it('commit / undo / redo', () => {
    let h = createHistory('a')
    expect(canUndo(h)).toBe(false)
    h = commit(h, 'b', { now: 0 })
    h = commit(h, 'c', { now: 5000 })
    expect(h.past).toEqual(['a', 'b'])
    h = undo(h)
    expect(h.present).toBe('b')
    expect(canRedo(h)).toBe(true)
    h = redo(h)
    expect(h.present).toBe('c')
    h = undo(undo(h))
    expect(h.present).toBe('a')
    expect(undo(h)).toEqual(h)
    h = commit(h, 'x', { now: 9000 })
    expect(canRedo(h)).toBe(false)
    expect(commit(h, 'x')).toBe(h)
  })

  it('同一组连续改动（打字）合并成一步，隔久了或换组就分开', () => {
    let h = createHistory('')
    h = commit(h, 'a', { group: 'n1.prompt', now: 0 })
    h = commit(h, 'ab', { group: 'n1.prompt', now: 300 })
    h = commit(h, 'abc', { group: 'n1.prompt', now: 600 })
    expect(h.past).toEqual([''])
    h = commit(h, 'abcd', { group: 'n1.prompt', now: 5000 })
    expect(h.past).toEqual(['', 'abc'])
    h = commit(h, 'abcde', { group: 'n2.prompt', now: 5100 })
    expect(h.past).toEqual(['', 'abc', 'abcd'])
  })

  it('拖动中的临时改动整段算一步', () => {
    let h = createHistory('p0')
    h = transient(h, 'p1')
    h = transient(h, 'p2')
    expect(h.present).toBe('p2')
    expect(canUndo(h)).toBe(true)
    h = settle(h)
    expect(h.past).toEqual(['p0'])
    expect(undo(h).present).toBe('p0')
    // 拖了一圈回到原处：不记步
    let h2 = transient(createHistory('q'), 'q1')
    h2 = transient(h2, 'q')
    expect(transient(createHistory('q'), 'q')).toEqual(createHistory('q'))
    expect(settle(h2).past).toEqual([])
    // 拖动中直接撤销：先收尾再撤
    expect(undo(transient(createHistory('r'), 'r1')).present).toBe('r')
  })

  it('历史有上限', () => {
    let h = createHistory(0)
    for (let i = 1; i <= 100; i += 1) h = commit(h, i, { now: i * 10_000 })
    expect(h.past.length).toBe(60)
  })
})
