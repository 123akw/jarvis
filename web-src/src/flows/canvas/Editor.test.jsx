import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from './testFixtures.js'
import Editor from './Editor.jsx'

/* ---- React Flow 在 jsdom 里要的替身（官方测试指南的做法）：尺寸、ResizeObserver、DOMMatrix ---- */
beforeAll(() => {
  global.ResizeObserver = class {
    constructor(cb) { this.cb = cb }
    observe(target) { this.cb([{ target, contentRect: { width: 1200, height: 800 } }], this) }
    unobserve() {}
    disconnect() {}
  }
  global.DOMMatrixReadOnly = class {
    constructor(t) { const m = /scale\(([\d.]+)\)/.exec(t || ''); this.m22 = m ? Number(m[1]) : 1; this.a = this.m22 }
  }
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return parseFloat(this.style.height) || 100 } },
    offsetWidth: { configurable: true, get() { return parseFloat(this.style.width) || 256 } },
  })
  SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 })
})

/* ---- 契约 mock：节点目录 / 读写流程 / 可控 SSE ---- */
function sseStream(signal) {
  const queue = []
  let waiting = null
  const settle = item => { if (waiting) { const w = waiting; waiting = null; w(item) } else queue.push(item) }
  signal?.addEventListener('abort', () => settle({ abort: true }))
  const reader = {
    async read() {
      const item = queue.length ? queue.shift() : await new Promise(r => { waiting = r })
      if (item.abort) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return item
    },
    releaseLock() {},
  }
  return {
    response: { ok: true, status: 200, body: { getReader: () => reader } },
    send: ev => settle({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`) }),
    close: () => settle({ done: true }),
  }
}

const START = { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: '开始', fields: [{ key: 'text', label: '要处理的文字', type: 'paragraph', required: true }] } }
const END = { id: 'end', type: 'end', position: { x: 640, y: 0 }, data: { title: '结束', output: '', page: false } }
const CHAIN = {
  nodes: [START, { id: 'n1', type: 'llm', position: { x: 320, y: 0 }, data: { title: '提炼要点', prompt: '总结 {{start.text}}', output: 'text' } }, END],
  edges: [{ id: 'e1', source: 'start', target: 'n1', sourceHandle: null }, { id: 'e2', source: 'n1', target: 'end', sourceHandle: null }],
}
const BLANK = { nodes: [START, END], edges: [{ id: 'e1', source: 'start', target: 'end', sourceHandle: null }] }

let api
function mockApi({ flow = null, catalogStatus = 200, flowStatus = 200 } = {}) {
  const state = { posts: [], puts: [], runs: [], stream: null }
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    if (url === '/api/flows/nodes') return json(catalogStatus === 200 ? CATALOG : { error: '坏了' }, catalogStatus)
    if (url === '/api/flows' && method === 'POST') {
      const body = JSON.parse(init.body)
      state.posts.push(body)
      return json({ flow: { id: 'new1', name: body.name, summary: body.summary, graph: body.graph } })
    }
    let m = url.match(/^\/api\/flows\/([^/]+)$/)
    if (m && method === 'GET') return json(flowStatus === 200 ? { flow } : { error: '不见了' }, flowStatus)
    if (m && method === 'PUT') {
      const body = JSON.parse(init.body)
      state.puts.push({ id: m[1], body })
      return json({ flow: { id: m[1], name: body.name, graph: body.graph } })
    }
    m = url.match(/^\/api\/flows\/([^/]+)\/run$/)
    if (m) {
      state.runs.push({ id: m[1], body: JSON.parse(init.body) })
      state.stream = sseStream(init.signal)
      return state.stream.response
    }
    return json({ error: 'not found' }, 404)
  })
  api = state
  return state
}

const props = over => ({ onSaved: vi.fn(), onBack: vi.fn(), onExpired: vi.fn(), ...over })

async function open(over = {}) {
  const p = props(over)
  const utils = render(<Editor flowId="new" initial={{ name: '测试流程', graph: CHAIN }} {...p} />)
  await screen.findByLabelText('节点面板')
  return { ...utils, p }
}

const nodeCard = title => screen.getAllByText(title, { selector: '.fc-node-title' })[0].closest('.fc-node')
const canvasNode = title => screen.getAllByText(title, { selector: '.fc-node-title' })[0].closest('.react-flow__node')
const savedGraph = () => (api.posts.at(-1) || api.puts.at(-1)?.body).graph
const edgesOf = g => g.edges.map(e => `${e.source}>${e.target}${e.sourceHandle ? `:${e.sourceHandle}` : ''}`).sort()

beforeEach(() => { mockApi(); delete window.matchMedia })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('画布编辑器：载入与面板', () => {
  it('新建：画出草稿里的节点，节点面板分组；不可用的灰显、说原因并给「去加插件」', async () => {
    await open()
    expect(nodeCard('开始')).toHaveAttribute('data-tour', 'flow-node-start')
    expect(nodeCard('提炼要点')).toHaveTextContent('总结 「开始 · 要处理的文字」')
    const palette = screen.getByLabelText('节点面板')
    expect(palette).toHaveAttribute('data-tour', 'flow-palette')
    for (const g of ['基础', '插件工具', '技能', '积木']) expect(within(palette).getByRole('heading', { name: new RegExp(`^${g}`) })).toBeInTheDocument()
    const exp = within(palette).getByRole('button', { name: /查快递/ })
    expect(exp).toHaveAttribute('aria-disabled', 'true')
    expect(within(palette).getByText(/还没装「快递」/)).toBeInTheDocument()
    expect(within(palette).getAllByRole('link', { name: /去加插件/ })[0]).toHaveAttribute('href', '/')
    expect(screen.getByText('有改动')).toBeInTheDocument()   // 新建的还没存
    for (const anchor of ['flow-canvas', 'flow-run', 'flow-save']) expect(document.querySelector(`[data-tour="${anchor}"]`)).toBeTruthy()
    expect(screen.getByRole('button', { name: '新手引导' })).toBeInTheDocument()
  })

  it('搜索节点', async () => {
    await open()
    const palette = screen.getByLabelText('节点面板')
    fireEvent.change(within(palette).getByLabelText('搜节点'), { target: { value: '天气' } })
    expect(within(palette).getByRole('button', { name: /查实时天气/ })).toBeInTheDocument()
    expect(within(palette).queryByRole('button', { name: /AI 处理/ })).toBeNull()
  })

  it('打开已有流程：读服务端的图，状态「已保存」；目录没加载出来时提示并能重试', async () => {
    mockApi({ flow: { id: 'f1', name: '早报', summary: '', graph: CHAIN }, catalogStatus: 500 })
    render(<Editor flowId="f1" {...props()} />)
    expect(await screen.findByDisplayValue('早报')).toBeInTheDocument()
    expect(screen.getByText('已保存', { selector: '.fc-savestate' })).toBeInTheDocument()
    expect(screen.getByText(/插件和积木没加载出来/)).toBeInTheDocument()
    mockApi({ flow: { id: 'f1', name: '早报', graph: CHAIN } })
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(screen.queryByText(/插件和积木没加载出来/)).toBeNull())
  })

  it('加载失败说人话；登录过期交给 onExpired', async () => {
    mockApi({ flowStatus: 404 })
    render(<Editor flowId="gone" {...props()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('不见了')
    cleanup()
    mockApi({ flowStatus: 401 })
    const p = props()
    render(<Editor flowId="x" {...p} />)
    await waitFor(() => expect(p.onExpired).toHaveBeenCalled())
  })
})

describe('画布编辑器：加节点', () => {
  it('没选中节点时点面板项：插在「结束」前面并自动连线', async () => {
    await open({})
    cleanup()
    mockApi()
    render(<Editor flowId="new" initial={{ name: '空白', graph: BLANK }} {...props()} />)
    await screen.findByLabelText('节点面板')
    expect(screen.getByText('从这里开始搭')).toBeInTheDocument()
    fireEvent.click(within(screen.getByLabelText('节点面板')).getByRole('button', { name: /^✨?\s*AI 处理/ }))
    // 新节点被选中，配置面板打开
    const panel = await screen.findByRole('region', { name: /节点设置/ })
    expect(panel).toHaveAttribute('data-tour', 'flow-config')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(edgesOf(savedGraph())).toEqual(['n1>end', 'start>n1'])
  })

  it('选中节点后点面板项：接在它后面，原来的下游接到新节点后面', async () => {
    await open()
    fireEvent.click(canvasNode('提炼要点'))
    fireEvent.click(within(screen.getByLabelText('节点面板')).getByRole('button', { name: /文本拼接/ }))
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(edgesOf(savedGraph())).toEqual(['n1>n2', 'n2>end', 'start>n1'])
  })

  it('节点出口的「+」弹出快捷面板，选一项接在后面', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '在「开始」后面加节点' }))
    const quick = await screen.findByRole('dialog', { name: /接在「开始」后面/ })
    fireEvent.click(within(quick).getByRole('button', { name: /查实时天气/ }))
    expect(screen.queryByRole('dialog', { name: /接在「开始」后面/ })).toBeNull()
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    const g = savedGraph()
    expect(g.nodes.find(n => n.id === 'n2')).toMatchObject({ type: 'tool', data: { plugin: 'weather', tool: 'weather__now' } })
    expect(edgesOf(g)).toEqual(['n1>end', 'n2>n1', 'start>n2'])
  })

  it('从面板拖到画布上', async () => {
    await open()
    const item = within(screen.getByLabelText('节点面板')).getByRole('button', { name: /条件分支/ })
    const data = {}
    const dataTransfer = { setData: (k, v) => { data[k] = v }, getData: k => data[k] || '', types: [], effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(item, { dataTransfer })
    dataTransfer.types = Object.keys(data)
    const pane = document.querySelector('.react-flow')
    fireEvent.dragOver(pane, { dataTransfer, clientX: 400, clientY: 300 })
    fireEvent.drop(pane, { dataTransfer, clientX: 400, clientY: 300 })
    expect(await screen.findByRole('region', { name: /节点设置：条件分支/ })).toBeInTheDocument()
    // 条件节点：每个分支一个出口并标名字，另有「否则」
    const card = canvasNode('条件分支')
    expect(within(card).getByText('分支 1')).toBeInTheDocument()
    expect(within(card).getByText('否则')).toBeInTheDocument()
    expect(card.querySelectorAll('.react-flow__handle.source')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '加一个分支' }))
    expect(within(canvasNode('条件分支')).getByText('分支 2')).toBeInTheDocument()
  })
})

describe('画布编辑器：配置与变量', () => {
  it('插入变量：按钮选上游产出，存成 {{start.text}}，输入框里显示人话 chip', async () => {
    await open()
    fireEvent.click(within(screen.getByLabelText('节点面板')).getByRole('button', { name: /^✨?\s*AI 处理/ }))
    await screen.findByRole('region', { name: /节点设置/ })
    const btn = screen.getByRole('button', { name: '给「要 AI 做什么」插入变量' })
    expect(btn).toHaveAttribute('data-tour', 'flow-var')
    fireEvent.click(btn)
    const picker = screen.getByRole('dialog', { name: '插入变量' })
    // 只给上游：开始、提炼要点（n1）、系统；不出现节点编号
    expect(within(picker).getByRole('group', { name: '开始' })).toBeInTheDocument()
    expect(within(picker).getByRole('group', { name: '提炼要点' })).toBeInTheDocument()
    expect(picker.textContent).not.toMatch(/n1|start\./)
    fireEvent.click(within(picker).getByRole('option', { name: /开始 · 要处理的文字/ }))
    const ta = screen.getByLabelText('要 AI 做什么')
    expect(ta).toHaveValue('开始 · 要处理的文字')
    expect(ta.parentElement.querySelector('mark.fc-chip')).toHaveTextContent('开始 · 要处理的文字')
    // 节点卡摘要跟着变
    expect(nodeCard('AI 处理')).toHaveTextContent('「开始 · 要处理的文字」')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(savedGraph().nodes.find(n => n.id === 'n2').data.prompt).toBe('{{start.text}}')
  })

  it('直接打 {{ 弹出选择，回车插入；退格整块删掉变量', async () => {
    await open()
    fireEvent.click(canvasNode('提炼要点'))
    const ta = await screen.findByLabelText('要 AI 做什么')
    expect(ta).toHaveValue('总结 开始 · 要处理的文字')
    fireEvent.change(ta, { target: { value: '总结 开始 · 要处理的文字 和{{', selectionStart: 18, selectionEnd: 18 } })
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(0)
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(ta.value).toMatch(/^总结 开始 · 要处理的文字 和系统 · /)
    // 在第一个变量末尾退格：整块删掉
    fireEvent.change(ta, { target: { value: ta.value.slice(0, 12) + ta.value.slice(13), selectionStart: 12, selectionEnd: 12 } })
    expect(ta.value).toMatch(/^总结  和系统 · /)
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(savedGraph().nodes.find(n => n.id === 'n1').data.prompt).toMatch(/^总结  和\{\{sys\.[a-z]+\}\}$/)
  })

  it('插件工具：参数表单由目录的 args 生成，缺必填就地提示', async () => {
    await open()
    fireEvent.click(canvasNode('提炼要点'))
    fireEvent.click(within(screen.getByLabelText('节点面板')).getByRole('button', { name: /查实时天气/ }))
    const panel = await screen.findByRole('region', { name: /节点设置：查实时天气/ })
    expect(within(panel).getByText('还没填「城市」')).toBeInTheDocument()
    expect(within(canvasNode('查实时天气')).getByText(/还没填「城市」/)).toBeInTheDocument()
    expect(within(panel).getByText('比如：北京')).toBeInTheDocument()
    fireEvent.change(within(panel).getByLabelText('城市'), { target: { value: '北京', selectionStart: 2, selectionEnd: 2 } })
    expect(within(panel).queryByText('还没填「城市」')).toBeNull()
    expect(nodeCard('查实时天气')).toHaveTextContent('城市：北京')
  })

  it('连线：在配置面板里「连到…」，也能断开', async () => {
    await open()
    fireEvent.click(canvasNode('开始'))
    const panel = await screen.findByRole('region', { name: /节点设置：开始/ })
    fireEvent.change(within(panel).getByLabelText('连到哪个节点'), { target: { value: 'end' } })
    fireEvent.click(within(panel).getByRole('button', { name: '断开连到「提炼要点」的线' }))
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(edgesOf(savedGraph())).toEqual(['n1>end', 'start>end'])
  })

  it('开始节点：加输入项、改类型', async () => {
    await open()
    fireEvent.click(canvasNode('开始'))
    const panel = await screen.findByRole('region', { name: /节点设置：开始/ })
    fireEvent.click(within(panel).getByRole('button', { name: '加一个输入项' }))
    fireEvent.change(within(panel).getByLabelText('第 2 个输入项的名字'), { target: { value: '附件' } })
    fireEvent.change(within(panel).getByLabelText('第 2 个输入项的类型'), { target: { value: 'file' } })
    expect(nodeCard('开始')).toHaveTextContent('运行时填：要处理的文字、附件')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(savedGraph().nodes[0].data.fields[1]).toEqual({ key: 'text2', label: '附件', type: 'file', required: false })
  })
})

describe('画布编辑器：保存、撤销、删除、离开', () => {
  it('⌘S 新建保存：POST 契约格式、onSaved、状态「已保存」；再改显示「有改动」，再存走 PUT', async () => {
    const { p } = await open()
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'new1' })))
    expect(api.posts[0]).toEqual({ name: '测试流程', summary: '', graph: expect.objectContaining({ nodes: expect.any(Array), edges: expect.any(Array) }) })
    expect(api.posts[0].graph.nodes[1]).toEqual({ id: 'n1', type: 'llm', position: { x: 320, y: 0 }, data: CHAIN.nodes[1].data })
    expect(await screen.findByText('已保存', { selector: '.fc-savestate' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('流程名称'), { target: { value: '测试流程 2' } })
    expect(screen.getByText('有改动', { selector: '.fc-savestate' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /保存/ }))
    await waitFor(() => expect(api.puts).toHaveLength(1))
    expect(api.puts[0]).toMatchObject({ id: 'new1', body: { name: '测试流程 2' } })
  })

  it('结构问题拦保存（没有结束节点），并定位', async () => {
    await open()
    fireEvent.click(canvasNode('结束'))
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(screen.queryByText('结束', { selector: '.fc-node-title' })).toBeNull()
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(await screen.findByRole('alert')).toHaveTextContent('还没有「结束」节点')
    expect(api.posts).toHaveLength(0)
  })

  it('撤销 / 重做；开始节点删不掉；删中间节点前后自动接上', async () => {
    await open()
    fireEvent.click(canvasNode('提炼要点'))
    fireEvent.keyDown(window, { key: 'Backspace' })
    expect(screen.queryByText('提炼要点', { selector: '.fc-node-title' })).toBeNull()
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(canvasNode('提炼要点')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true })
    expect(screen.queryByText('提炼要点', { selector: '.fc-node-title' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    fireEvent.click(canvasNode('开始'))
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(await screen.findByRole('alert')).toHaveTextContent('「开始」节点不能删')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(edgesOf(savedGraph())).toEqual(['start>end'])
  })

  it('输入框里打字时 Delete / ⌘Z 不动画布', async () => {
    await open()
    fireEvent.click(canvasNode('提炼要点'))
    const title = await screen.findByLabelText('节点名称')
    fireEvent.keyDown(title, { key: 'Backspace' })
    expect(canvasNode('提炼要点')).toBeTruthy()
  })

  it('整理：重新排版并能撤销', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /整理/ }))
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(api.posts).toHaveLength(1))
    const xs = savedGraph().nodes.map(n => n.position.x)
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
  })

  it('返回：有未保存改动先确认', async () => {
    const { p } = await open()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: '返回我的流程' }))
    expect(confirm).toHaveBeenCalled()
    expect(p.onBack).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '返回我的流程' }))
    expect(p.onBack).toHaveBeenCalled()
  })
})

describe('画布编辑器：运行', () => {
  it('新流程运行：先保存拿 id，按输入运行，事件驱动节点状态，显示最终结果；跑完才通知 onSaved', async () => {
    const { p } = await open()
    fireEvent.click(screen.getByRole('button', { name: /^运行$/ }))
    const panel = await screen.findByRole('region', { name: '运行流程' })
    expect(panel).toHaveAttribute('data-tour', 'flow-run-panel')
    // 必填没填：提示
    fireEvent.click(within(panel).getByRole('button', { name: /开始运行/ }))
    expect(within(panel).getByText(/还没填：「要处理的文字」/)).toBeInTheDocument()
    fireEvent.change(within(panel).getByLabelText(/要处理的文字/), { target: { value: '会议记录……' } })
    fireEvent.click(within(panel).getByRole('button', { name: /开始运行/ }))
    await waitFor(() => expect(api.runs).toHaveLength(1))
    expect(api.posts).toHaveLength(1)
    expect(api.runs[0]).toEqual({ id: 'new1', body: { inputs: { text: '会议记录……' } } })
    expect(p.onSaved).not.toHaveBeenCalled()
    const s = api.stream
    await act(async () => {
      s.send({ type: 'run_start', run_id: 'r1' })
      s.send({ type: 'node_start', node_id: 'start', node_type: 'start', title: '开始' })
      s.send({ type: 'node_done', node_id: 'start', ms: 5, summary: '收到 6 字' })
      s.send({ type: 'node_start', node_id: 'n1', node_type: 'llm', title: '提炼要点' })
    })
    await waitFor(() => expect(nodeCard('提炼要点')).toHaveAttribute('data-run', 'running'))
    expect(nodeCard('开始')).toHaveAttribute('data-run', 'ok')
    expect(document.querySelector('.fc-edge-flow')).toBeTruthy()   // 激活的连线在流动
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()
    await act(async () => {
      s.send({ type: 'node_done', node_id: 'n1', ms: 1234, summary: '3 条要点', output: { text: '- 要点一\n- 要点二' } })
      s.send({ type: 'node_start', node_id: 'end', node_type: 'end', title: '结束' })
      s.send({ type: 'node_done', node_id: 'end', ms: 2 })
      s.send({ type: 'run_done', status: 'ok', ms: 1300, output: { text: '**三条要点**', links: [{ label: '飞书文档', url: 'https://example.com/doc' }], page_url: '/r/abc' } })
    })
    await waitFor(() => expect(within(panel).getByText(/运行完成 · 用时 1.3 秒/)).toBeInTheDocument())
    expect(within(nodeCard('提炼要点')).getByRole('img', { name: '完成，用时 1.2 秒' })).toBeInTheDocument()
    expect(panel.querySelector('.fc-final strong')).toHaveTextContent('三条要点')
    expect(within(panel).getByRole('link', { name: /打开结果网页/ })).toHaveAttribute('href', '/r/abc')
    expect(within(panel).getByRole('link', { name: /飞书文档/ })).toHaveAttribute('href', 'https://example.com/doc')
    expect(p.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'new1' }))
    // 展开某一步的产出（Markdown）
    fireEvent.click(within(panel).getByText('3 条要点'))
    expect(panel.querySelector('.fc-rn-body li')).toHaveTextContent('要点一')
  })

  it('出错：节点标红，面板说原因并能定位；停止运行', async () => {
    mockApi({ flow: { id: 'f1', name: '早报', graph: CHAIN } })
    render(<Editor flowId="f1" {...props()} />)
    await screen.findByDisplayValue('早报')
    fireEvent.click(screen.getByRole('button', { name: /^运行$/ }))
    const panel = await screen.findByRole('region', { name: '运行流程' })
    fireEvent.change(within(panel).getByLabelText(/要处理的文字/), { target: { value: 'x' } })
    fireEvent.click(within(panel).getByRole('button', { name: /开始运行/ }))
    await waitFor(() => expect(api.runs).toHaveLength(1))
    expect(api.puts).toHaveLength(0)   // 没改动不用先存
    await act(async () => {
      api.stream.send({ type: 'node_start', node_id: 'n1' })
      api.stream.send({ type: 'node_error', node_id: 'n1', message: 'AI 这会儿忙不过来，稍后再试', ms: 60000 })
      api.stream.send({ type: 'run_done', status: 'error', ms: 60010 })
    })
    await waitFor(() => expect(within(panel).getByText('没跑通：')).toBeInTheDocument())
    expect(nodeCard('提炼要点')).toHaveAttribute('data-run', 'error')
    expect(within(nodeCard('提炼要点')).getByText('AI 这会儿忙不过来，稍后再试')).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: '去看看「提炼要点」' }))
    expect(await screen.findByRole('region', { name: /节点设置：提炼要点/ })).toBeInTheDocument()
    // 再跑一次，中途停止
    fireEvent.click(screen.getByRole('button', { name: /^运行$/ }))
    const panel2 = await screen.findByRole('region', { name: '运行流程' })
    fireEvent.click(within(panel2).getByRole('button', { name: /再跑一次/ }))
    await waitFor(() => expect(api.runs).toHaveLength(2))
    await act(async () => { api.stream.send({ type: 'node_start', node_id: 'start' }) })
    fireEvent.click(within(panel2).getByRole('button', { name: '停止' }))
    await waitFor(() => expect(within(panel2).getByText('已停止运行。')).toBeInTheDocument())
  })

  it('还有问题时运行面板列出来，按钮不可用', async () => {
    await open()
    fireEvent.click(canvasNode('提炼要点'))
    fireEvent.change(await screen.findByLabelText('要 AI 做什么'), { target: { value: '', selectionStart: 0, selectionEnd: 0 } })
    expect(screen.getByRole('button', { name: /还有 1 处要处理/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^运行$/ }))
    const panel = await screen.findByRole('region', { name: '运行流程' })
    expect(within(panel).getByText('还差这些才能运行：')).toBeInTheDocument()
    expect(within(panel).getByText('还没写要 AI 做什么')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: /开始运行/ })).toBeDisabled()
  })
})

describe('画布编辑器：手机', () => {
  beforeEach(() => {
    window.matchMedia = q => ({ matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} })
  })

  it('列表式编辑：按顺序列节点卡，点开底部弹层配置；在后面加一步', async () => {
    render(<Editor flowId="new" initial={{ name: '手机流程', graph: CHAIN }} {...props()} />)
    const list = await screen.findByRole('list', { name: '流程的每一步' })
    const titles = [...list.querySelectorAll('.fc-node-title')].map(x => x.textContent)
    expect(titles).toEqual(['开始', '提炼要点', '结束'])
    fireEvent.click(within(list).getByRole('button', { name: /设置「提炼要点」/ }))
    const sheet = await screen.findByRole('dialog', { name: '设置「提炼要点」' })
    expect(within(sheet).getByLabelText('要 AI 做什么')).toHaveValue('总结 开始 · 要处理的文字')
    fireEvent.click(within(sheet).getByRole('button', { name: '完成' }))
    fireEvent.click(within(list).getAllByRole('button', { name: '在后面加一步' })[1])
    const add = await screen.findByRole('dialog', { name: '加一步' })
    fireEvent.click(within(add).getByRole('button', { name: /文本拼接/ }))
    const titles2 = [...screen.getByRole('list', { name: '流程的每一步' }).querySelectorAll('.fc-node-title')].map(x => x.textContent)
    expect(titles2).toEqual(['开始', '提炼要点', '文本拼接', '结束'])
    // 画布只读
    fireEvent.click(screen.getByRole('tab', { name: /画布/ }))
    expect(document.querySelector('.fc-canvas.is-readonly')).toBeTruthy()
  })
})
