import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* 画布与新手引导归别的代理：这里用替身，只看 Flows 怎么挂它们、传了什么 */
const seen = vi.hoisted(() => ({ editor: [], mounts: 0, tours: [] }))
vi.mock('./canvas/Editor.jsx', async () => {
  const { useEffect } = await import('react')
  return {
    default: function EditorStub(props) {
      seen.editor.push(props)
      useEffect(() => { seen.mounts += 1 }, [])
      return (
        <div data-testid="editor" data-flow-id={props.flowId}>
          <span>{props.initial?.name || '无草稿'}</span>
          <button type="button" onClick={() => props.onSaved({ id: 'new1', name: props.initial?.name })}>假装保存</button>
          <button type="button" onClick={props.onBack}>假装返回</button>
        </div>
      )
    },
  }
})
vi.mock('../tour/index.jsx', () => ({
  TOUR_IDS: ['flows-home'],
  startTour: () => {},
  useTour: (id, opts) => { seen.tours.push({ id, ready: Boolean(opts?.ready) }); return { start() {}, running: false } },
  TourButton: ({ tour, className }) => <button type="button" className={className} data-tour-button={tour}>新手引导</button>,
}))

import { DRAFT_KEY, nextRuns, whenLabel } from './flowkit.js'
import Flows from './Flows.jsx'

/* ---- 契约假数据（docs/proposals/2026-10-round18-flows.md §3） ---- */
const n = (id, type, data = {}, x = 0, y = 0) => ({ id, type, position: { x, y }, data })
const e = (source, target) => ({ id: `${source}-${target}`, source, target, sourceHandle: null })
const MORNING = {
  nodes: [
    n('start', 'start', { title: '开始', fields: [] }),
    n('w', 'tool', { title: '查实时天气', plugin: 'weather', tool: 'weather__now', args: { city: '北京' } }, 300, 0),
    n('n1', 'llm', { title: '写成早报', prompt: '根据{{w.text}}写早报' }, 600, 0),
    n('f', 'step', { step: 'feishu_send', options: {} }, 900, 0),
    n('end', 'end', { title: '结束', output: '{{n1.text}}' }, 1200, 0),
  ],
  edges: [e('start', 'w'), e('w', 'n1'), e('n1', 'f'), e('f', 'end')],
}
const MINUTES = {
  nodes: [
    n('start', 'start', { title: '开始', fields: [
      { key: 'text', label: '会议记录', type: 'paragraph', required: true },
      { key: 'style', label: '纪要风格', type: 'select', options: ['简洁', '详细'], default: '简洁' },
      { key: 'att', label: '录音或附件', type: 'file' },
    ] }),
    n('n1', 'llm', { title: '整理纪要', skill: 'meeting_notes', prompt: '{{start.text}}' }, 300, 0),
    n('end', 'end', { title: '结束', output: '{{n1.text}}' }, 600, 0),
  ],
  edges: [e('start', 'n1'), e('n1', 'end')],
}
const FLOWS = [
  { id: 'f1', name: '工作日早报', summary: '天气和日程发到飞书', node_count: 5, plugins: ['weather'],
    trigger: { kind: 'schedule', label: '每个工作日 08:00', next_run_at: '2026-10-06T00:00:00Z' },
    last_run: { status: 'ok', started_at: new Date(Date.now() - 3 * 3600e3).toISOString() }, updated_at: '', graph: MORNING },
  { id: 'f2', name: '会议纪要转待办', summary: '', node_count: 3, plugins: [], trigger: null,
    last_run: { status: 'error', started_at: new Date(Date.now() - 2 * 86400e3).toISOString() }, updated_at: '', graph: MINUTES },
]
const TEMPLATES = {
  categories: [{ id: 'office', label: '办公' }, { id: 'life', label: '生活资讯' }, { id: 'empty', label: '没有模板的分类' }],
  templates: [
    { id: 'morning', name: '天气和日程早报', summary: '每天早上发到飞书', category: 'life', icon: '🌅', plugins: ['weather', 'feishu_send'],
      graph: MORNING, needs: ['需要绑定飞书'] },
    { id: 'minutes', name: '会议纪要转待办', summary: '贴进会议记录', category: 'office', icon: '🗒️', plugins: [], graph: MINUTES, needs: [] },
    { id: 'weekly', name: '周报写手', summary: '写成周报网页', category: 'office', icon: '📈', plugins: [], graph: MINUTES, needs: [] },
    { id: 'promo', name: '店铺活动方案', summary: '出一份活动方案', category: 'office', icon: '🎉', plugins: [], graph: MINUTES, needs: [] },
  ],
}
const NODES = { groups: [
  { id: 'tools', items: [{ type: 'tool', title: '查实时天气', icon: '🌤️', plugin_name: '查天气', available: false, reason: '这个智能体还没装「查天气」',
    data: { plugin: 'weather', tool: 'weather__now' }, args: [{ name: 'city', label: '城市' }] }] },
] }
const COMPOSE = { draft: { name: '天气早报', summary: '早上发天气', graph: MORNING }, notes: ['天气默认查北京，可以改'], source: 'model' }
const RUNS = { runs: [
  { id: 'r2', status: 'ok', started_at: new Date(Date.now() - 3600e3).toISOString(), ms: 12400, input_summary: '定时运行 · 没有输入',
    page_url: '/r/tok', output_text: '**早报**：晴<script>window.__pwned = 1</script>', error: '',
    links: [{ label: '打开飞书文档', url: 'https://feishu.cn/docx/abc' }, { label: '坏链接', url: 'javascript:alert(1)' }],
    nodes: [
      { node_id: 'w', title: '查实时天气', node_type: 'tool', status: 'ok', summary: '北京 晴', preview: '城市：北京\n天气：晴', ms: 820 },
      { node_id: 'x', title: '发到微信', node_type: 'step', status: 'skipped', summary: '', preview: '', ms: null },
    ] },
  { id: 'r1', status: 'error', started_at: new Date(Date.now() - 86400e3).toISOString(), ms: 2300, input_summary: '手动运行',
    page_url: '', output_text: '', error: '「查实时天气」没走通', nodes: [] },
] }

let api
function mockApi({ flows = FLOWS, listStatus = 200, composeFail = 0, trigger = null, feishuBound = false } = {}) {
  const state = { flows: flows.map(f => ({ ...f })), calls: [], composeFail, trigger, feishuBound }
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    state.calls.push({ url, method, body })
    if (url === '/api/flows' && method === 'GET') return listStatus === 200 ? res({ flows: state.flows }) : res({ error: '数据库开小差了' }, listStatus)
    if (url === '/api/flows' && method === 'POST') return res({ flow: { id: 'copy1', name: body.name, summary: body.summary, graph: body.graph } })
    if (url === '/api/flows/templates') return res(TEMPLATES)
    if (url === '/api/flows/nodes') return res(NODES)
    if (url === '/api/flows/compose') {
      if (state.composeFail > 0) { state.composeFail -= 1; return res({ error: '模型暂时不可用' }, 503) }
      return res(COMPOSE)
    }
    if (url === '/api/feishu/status') return res({ configured: true, bound: state.feishuBound })
    if (/^\/api\/flows\/[^/]+\/runs/.test(url)) return res(RUNS)
    let m = url.match(/^\/api\/flows\/([^/]+)\/trigger$/)
    if (m && method === 'PUT') return res({ trigger: { ...body, label: body.enabled ? '每周三 07:30' : '', next_run_at: '' } })
    if (m) return res({ trigger: state.trigger })
    m = url.match(/^\/api\/flows\/([^/]+)$/)
    if (m && method === 'DELETE') return res({ ok: true })
    if (m) return res({ flow: state.flows.find(f => f.id === m[1]) })
    return res({ error: 'not mocked' }, 404)
  })
  return state
}

const where = () => window.location.pathname
const calls = (url, method = 'GET') => api.calls.filter(c => c.url === url && c.method === method)
const sectionOrder = container => [...container.querySelectorAll('[data-tour]')].map(el => el.dataset.tour)

async function renderAt(path, opts) {
  window.history.replaceState({}, '', path)
  api = mockApi(opts)
  const onExpired = vi.fn()
  const utils = render(<Flows session={{ username: 'demo' }} onExpired={onExpired} />)
  return { ...utils, onExpired }
}
/** 首页：等列表、模板、节点目录、飞书状态都到了（模板卡出现「需先加」说明目录到了） */
async function renderHome(opts) {
  const r = await renderAt('/flows', opts)
  await screen.findByText('需先加「查天气」')
  await waitFor(() => expect(calls('/api/feishu/status')).toHaveLength(1))
  await screen.findByText(/需先绑定飞书|需要：飞书/)
  return r
}

describe('「我的流程」首页', () => {
  beforeEach(() => { seen.editor = []; seen.mounts = 0; seen.tours = []; sessionStorage.clear() })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/') })

  it('老用户：页头 → 单行输入框 → 已保存的流程（缩略图 / 上次运行 / 定时）→ 模板；数据好了才开新手引导', async () => {
    const { container } = await renderHome()
    expect(screen.getByRole('heading', { level: 1, name: '我的流程' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新建流程/ })).toHaveAttribute('data-tour', 'flows-new')
    expect(container.querySelector('[data-tour-button="flows-home"]')).toBeInTheDocument()
    expect(sectionOrder(container)).toEqual(['flows-new', 'flows-compose', 'flows-list', 'flows-templates'])
    // 输入框收成单行，不再摆「试试这些」
    expect(screen.getByRole('textbox', { name: '说说你想自动化什么' })).toHaveAttribute('rows', '1')
    expect(screen.queryByRole('group', { name: '试试这些' })).not.toBeInTheDocument()
    const list = container.querySelector('[data-tour="flows-list"]')
    const card = within(list).getByRole('link', { name: '工作日早报' }).closest('li')
    expect(within(card).getByText(/上次运行完成 · 3 小时前/)).toBeInTheDocument()
    expect(within(card).getByText('每个工作日 08:00')).toBeInTheDocument()
    expect(within(card).getByRole('img', { name: /流程图：开始 → 查实时天气 → 写成早报 → 发到飞书 → 结束/ })).toBeInTheDocument()
    expect(within(list).getByText(/上次运行失败/)).toBeInTheDocument()
    await waitFor(() => expect(seen.tours.at(-1)).toEqual({ id: 'flows-home', ready: true }))
    expect(seen.tours[0]).toEqual({ id: 'flows-home', ready: false })
    expect(document.title).toBe('我的流程 · 贾维斯')
  })

  it('新用户：「你想自动化什么？」+ 试试这些 → 3 张精选模板 → 空的「已保存的流程」', async () => {
    const { container } = await renderHome({ flows: [] })
    expect(screen.getByRole('heading', { name: '你想自动化什么？' })).toBeInTheDocument()
    expect(sectionOrder(container)).toEqual(['flows-new', 'flows-compose', 'flows-templates', 'flows-list'])
    expect(within(container.querySelector('[data-tour="flows-list"]')).getByText('还没有流程')).toBeInTheDocument()
    // 「试试这些」：固定列表，按能用的插件过滤（查天气没装 → 不推荐发天气那条），一次 4 条，可换一批
    const group = screen.getByRole('group', { name: '试试这些' })
    const chips = () => within(group).getAllByRole('button').filter(b => b.textContent !== '换一批').map(b => b.textContent)
    expect(chips()).toHaveLength(4)
    expect(chips()).not.toContain('每天早上把天气和今天的日程发到飞书')
    const first = chips()
    fireEvent.click(within(group).getByRole('button', { name: '换一批' }))
    expect(chips()).not.toEqual(first)
  })

  it('列表没加载出来：说人话、能重试；登录过期交给 onExpired', async () => {
    await renderAt('/flows', { listStatus: 500 })
    expect(await screen.findByText('数据库开小差了')).toBeInTheDocument()
    global.fetch.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ flows: FLOWS }) }))
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(await screen.findByRole('link', { name: '工作日早报' })).toBeInTheDocument()
    cleanup()
    const { onExpired } = await renderAt('/flows', { listStatus: 401 })
    await waitFor(() => expect(onExpired).toHaveBeenCalled())
  })

  it('新建流程：默认草稿（开始 → AI 处理 → 结束）交给画布，草稿用完就清掉', async () => {
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: /新建流程/ }))
    expect(where()).toBe('/flows/new')
    const editor = await screen.findByTestId('editor')
    expect(editor).toHaveAttribute('data-flow-id', 'new')
    const { initial } = seen.editor.at(-1)
    expect(initial.graph.nodes.map(x => x.type)).toEqual(['start', 'llm', 'end'])
    expect(initial.graph.edges).toHaveLength(2)
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('一句话生成：太短先提示；生成中只给骨架和预计时间 → 预览（它会做什么 / 需要准备 / 提醒）→ 打开编辑', async () => {
    await renderHome({ flows: [] })
    const box = screen.getByRole('textbox', { name: '说说你想自动化什么' })
    fireEvent.change(box, { target: { value: '天气' } })
    expect(screen.getByRole('button', { name: '生成流程' })).toBeDisabled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByText(/再多说几个字/)).toBeInTheDocument()
    expect(calls('/api/flows/compose', 'POST')).toHaveLength(0)
    fireEvent.change(box, { target: { value: '每天早上发天气到飞书' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByRole('status')).toHaveTextContent('一般要 5–15 秒')
    expect(box).toHaveAttribute('readonly')
    const dialog = await screen.findByRole('dialog', { name: '生成的流程' })
    expect(calls('/api/flows/compose', 'POST')[0].body).toEqual({ description: '每天早上发天气到飞书' })
    expect(within(dialog).getByRole('heading', { name: '天气早报' })).toBeInTheDocument()
    expect(within(dialog).getByText('每天早上发天气到飞书')).toBeInTheDocument()
    const steps = within(dialog).getAllByRole('listitem').filter(li => li.classList.contains('fh-step'))
    expect(steps.map(li => li.querySelector('b').textContent.replace(/^第 \d 步：/, ''))).toEqual(['开始', '查实时天气', '写成早报', '发到飞书', '结束'])
    expect(within(dialog).getByText('天气默认查北京，可以改')).toBeInTheDocument()
    // 需要准备：查天气没装（缺插件也允许用，照样能打开编辑）
    expect(within(dialog).getByText('这个智能体还没装「查天气」').closest('li')).toHaveAttribute('data-ok', 'no')
    expect(within(dialog).getAllByRole('button').map(b => b.getAttribute('aria-label') || b.textContent)).toEqual(['关闭', '换个说法', '打开编辑'])
    fireEvent.click(within(dialog).getByRole('button', { name: /打开编辑/ }))
    expect(where()).toBe('/flows/new')
    await screen.findByTestId('editor')
    expect(seen.editor.at(-1).initial).toEqual({ name: '天气早报', summary: '早上发天气', graph: MORNING })
  })

  it('一句话生成失败：就地说清楚，可以再试；生成中可以取消', async () => {
    await renderHome({ flows: [], composeFail: 1 })
    fireEvent.click(screen.getByRole('button', { name: '把会议记录整理成待办，加到我的待办里' }))
    expect(screen.getByRole('textbox', { name: '说说你想自动化什么' })).toHaveValue('把会议记录整理成待办，加到我的待办里')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('这次没想明白：模型暂时不可用。换个说法试试，或者从模板开始')
    fireEvent.click(within(alert).getByRole('button', { name: '再试一次' }))
    expect(await screen.findByRole('dialog', { name: '生成的流程' })).toBeInTheDocument()
    expect(calls('/api/flows/compose', 'POST')).toHaveLength(2)
    cleanup()
    await renderHome({ flows: [] })
    fireEvent.change(screen.getByRole('textbox', { name: '说说你想自动化什么' }), { target: { value: '每周五下午写周报' } })
    fireEvent.click(screen.getByRole('button', { name: '生成流程' }))
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '说说你想自动化什么' })).not.toHaveAttribute('readonly')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('预览里「换个说法」：回到输入框，原文还在', async () => {
    await renderHome({ flows: [] })
    fireEvent.click(screen.getByRole('button', { name: '把长文章拆成学习卡片，做成网页' }))
    const dialog = await screen.findByRole('dialog', { name: '生成的流程' })
    fireEvent.click(within(dialog).getByRole('button', { name: '换个说法' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: '说说你想自动化什么' })
    expect(box).toHaveValue('把长文章拆成学习卡片，做成网页')
    await waitFor(() => expect(box).toHaveFocus())
    expect(where()).toBe('/flows')
  })

  it('模板：默认 3 张精选，「全部模板」展开分类页签（← → 切换）；预览列「需要准备」，用这个模板 → 草稿进画布', async () => {
    await renderHome()
    const section = screen.getByRole('region', { name: /从模板开始/ })
    expect(section.querySelectorAll('.fh-tpl')).toHaveLength(3)
    expect(within(section).queryByRole('tab')).not.toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: /全部模板（4）/ }))
    // 没有模板的分类不出页签
    expect(within(section).getAllByRole('tab').map(t => t.textContent)).toEqual(['全部', '办公', '生活资讯'])
    const tab = within(section).getByRole('tab', { name: '办公' })
    fireEvent.click(tab)
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(within(screen.getByRole('tabpanel')).queryByRole('button', { name: /天气和日程早报/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: /店铺活动方案/ })).toBeInTheDocument()
    fireEvent.keyDown(tab, { key: 'ArrowRight' })
    expect(within(section).getByRole('tab', { name: '生活资讯' })).toHaveFocus()
    // 卡片标签：飞书没绑定 → 橙色「需先绑定飞书」
    const card = within(screen.getByRole('tabpanel')).getByRole('button', { name: /天气和日程早报/ })
    expect(within(card).getByText('需先绑定飞书')).toHaveClass('is-warn')
    fireEvent.click(card)
    const dialog = await screen.findByRole('dialog', { name: '模板预览' })
    const need = within(dialog).getByText('需要绑定飞书').closest('li')
    expect(need).toHaveAttribute('data-ok', 'no')
    expect(within(need).getByRole('button', { name: /去绑定飞书/ })).toBeInTheDocument()
    expect(within(dialog).getAllByRole('button').map(b => b.getAttribute('aria-label') || b.textContent)).toEqual(['关闭', '去绑定飞书', '关闭', '用这个模板'])
    fireEvent.click(within(dialog).getByRole('button', { name: /用这个模板/ }))
    expect(where()).toBe('/flows/new')
    await screen.findByTestId('editor')
    expect(seen.editor.at(-1).initial).toMatchObject({ name: '天气和日程早报', summary: '每天早上发到飞书', graph: MORNING })
  })

  it('「去绑定飞书」就地打开飞书绑定；绑好后「需要准备」变成已满足', async () => {
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: /天气和日程早报/ }))
    const dialog = await screen.findByRole('dialog', { name: '模板预览' })
    api.feishuBound = true
    fireEvent.click(within(dialog).getByRole('button', { name: /去绑定飞书/ }))
    expect(await screen.findByRole('dialog', { name: '接入飞书' })).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByText('需要绑定飞书').closest('li')).toHaveAttribute('data-ok', 'yes'))
  })

  it('卡片菜单：键盘可用（↓ / Esc 还焦点），打开进画布', async () => {
    await renderHome()
    const more = screen.getByRole('button', { name: '「工作日早报」的更多操作' })
    fireEvent.click(more)
    const menu = screen.getByRole('menu', { name: '「工作日早报」的操作' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map(i => i.textContent)).toEqual(['打开', '运行记录', '定时运行', '复制', '删除'])
    expect(items[0]).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(items[4]).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(more).toHaveFocus()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: '打开' }))
    expect(where()).toBe('/flows/f1')
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-flow-id', 'f1')
    expect(seen.editor.at(-1).initial).toBeUndefined()
  })

  it('定时标记：上次定时运行失败变红、点开看运行记录；被自动暂停的点开定时设置', async () => {
    const flows = [
      { ...FLOWS[0], trigger: { ...FLOWS[0].trigger, last_status: 'error' } },
      { ...FLOWS[1], trigger: { kind: 'schedule', enabled: false, label: '每天 08:00', last_status: 'error' } },
    ]
    await renderHome({ flows })
    fireEvent.click(screen.getByRole('button', { name: '上次定时运行失败' }))
    expect(screen.getByRole('dialog', { name: '运行记录：工作日早报' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '定时已暂停' }))
    expect(screen.getByRole('dialog', { name: '定时运行' })).toBeInTheDocument()
  })

  it('复制：存一份「副本」放到最前面', async () => {
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: '「工作日早报」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }))
    expect(await screen.findByRole('link', { name: '工作日早报 副本' })).toBeInTheDocument()
    expect(calls('/api/flows', 'POST')[0].body).toEqual({ name: '工作日早报 副本', summary: '天气和日程发到飞书', graph: MORNING })
    const names = screen.getAllByRole('link').map(a => a.textContent)
    expect(names.slice(0, 2)).toEqual(['工作日早报 副本', '工作日早报'])
    expect(screen.getByText('已复制为「工作日早报 副本」')).toBeInTheDocument()
  })

  it('删除要确认：取消不删，确认后走 DELETE 并从列表拿掉', async () => {
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: '「工作日早报」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    let dialog = screen.getByRole('dialog', { name: '删除流程' })
    expect(dialog).toHaveTextContent('「每个工作日 08:00」的定时运行也会一起取消')
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(calls('/api/flows/f1', 'DELETE')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '「工作日早报」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    dialog = screen.getByRole('dialog', { name: '删除流程' })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: '工作日早报' })).not.toBeInTheDocument())
    expect(calls('/api/flows/f1', 'DELETE')).toHaveLength(1)
    expect(screen.getByText('已删除「工作日早报」')).toBeInTheDocument()
  })

  it('运行记录：列表 → 单次详情（逐节点、可展开产出、Markdown 安全渲染、结果网页与链接）→ 返回', async () => {
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: '「工作日早报」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '运行记录' }))
    const drawer = screen.getByRole('dialog', { name: '运行记录：工作日早报' })
    const rows = await within(drawer).findAllByRole('button', { name: /完成|失败/ })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('用时 12.4 秒 · 定时运行 · 没有输入')
    expect(calls('/api/flows/f1/runs?limit=20')).toHaveLength(1)
    fireEvent.click(rows[0])
    expect(within(drawer).getByRole('heading', { name: '这次运行完成' })).toHaveFocus()
    const steps = within(drawer).getByRole('region', { name: '每一步的结果' })
    expect(within(steps).getByText('北京 晴')).toBeInTheDocument()
    expect(within(steps).getByText('条件没走到这一步')).toBeInTheDocument()
    fireEvent.click(within(steps).getByRole('button', { name: '看看产出' }))
    expect(within(steps).getByText(/城市：北京/)).toBeInTheDocument()
    const result = within(drawer).getByRole('region', { name: '最终结果' })
    expect(result.querySelector('strong')).toHaveTextContent('早报')
    expect(result.querySelector('script')).toBeNull()
    expect(within(result).getByRole('link', { name: /打开结果网页/ })).toHaveAttribute('href', 'http://localhost/r/tok')
    expect(within(result).getByRole('link', { name: '打开飞书文档' })).toHaveAttribute('href', 'https://feishu.cn/docx/abc')
    expect(within(result).queryByRole('link', { name: '坏链接' })).not.toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: /全部记录/ }))
    fireEvent.click(within(drawer).getAllByRole('button', { name: /失败/ })[0])
    expect(within(drawer).getByText('「查实时天气」没走通')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('定时运行：重复 / 时间 / 预填输入（文件字段说明）/ 飞书没绑定灰显 / 下次运行及之后 2 次；保存发契约格式并更新卡片', async () => {
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: '「会议纪要转待办」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '定时运行' }))
    const dialog = screen.getByRole('dialog', { name: '定时运行' })
    const sw = await within(dialog).findByRole('switch', { name: /按时自动运行/ })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    // 飞书没绑定：灰显并给「去绑定飞书」
    expect(within(dialog).getByRole('checkbox', { name: /飞书/ })).toBeDisabled()
    expect(within(dialog).getByText('还没绑定飞书')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /去绑定飞书/ })).toBeInTheDocument()
    // 文件字段（非必填）：说明会留空
    expect(within(dialog).getByText(/定时运行没法带文件，这一项会留空/)).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: '纪要风格' })).toHaveValue('简洁')
    // 默认每天 08:00：下次 + 之后 2 次
    const [d1, d2, d3] = nextRuns({ repeat: 'daily', time: '08:00' })
    expect(within(dialog).getByText(whenLabel(d1))).toBeInTheDocument()
    expect(within(dialog).getByText(`之后：${whenLabel(d2)}、${whenLabel(d3)}`)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('radio', { name: '每周' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: '周三' }))
    fireEvent.change(within(dialog).getByLabelText('时间'), { target: { value: '07:30' } })
    expect(within(dialog).getByText(whenLabel(nextRuns({ repeat: 'weekly', time: '07:30', weekday: 3 })[0]))).toBeInTheDocument()
    // 必填没填不让保存
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('「会议记录」定时运行时没人填，先在这里填好')
    fireEvent.change(within(dialog).getByRole('textbox', { name: /会议记录/ }), { target: { value: '周会要点' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls('/api/flows/f2/trigger', 'PUT')[0].body).toEqual({
      kind: 'schedule', enabled: true, schedule: { repeat: 'weekly', time: '07:30', weekday: 3 },
      inputs: { text: '周会要点', style: '简洁' }, notify: { feishu: false, desktop: true },
    })
    const card = screen.getByRole('link', { name: '会议纪要转待办' }).closest('li')
    expect(within(card).getByText('每周三 07:30')).toBeInTheDocument()
    expect(screen.getByText('定时运行已保存：每周三 07:30')).toBeInTheDocument()
  })

  it('定时运行：读回已有设置；关掉开关保存为手动，卡片上的定时标记消失', async () => {
    await renderHome({
      feishuBound: true,
      trigger: { kind: 'schedule', enabled: true, schedule: { repeat: 'weekdays', time: '08:00' }, inputs: { text: '固定内容' },
        notify: { feishu: true, desktop: false }, label: '每个工作日 08:00' },
    })
    fireEvent.click(screen.getByRole('button', { name: '「工作日早报」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '定时运行' }))
    const dialog = screen.getByRole('dialog', { name: '定时运行' })
    const sw = await within(dialog).findByRole('switch')
    expect(within(dialog).getByRole('radio', { name: '工作日' })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: /飞书/ })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: /桌面通知/ })).not.toBeChecked()
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(within(dialog).getByText(/关掉后不会自动运行/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls('/api/flows/f1/trigger', 'PUT')[0].body).toMatchObject({ kind: 'manual', enabled: false })
    const card = screen.getByRole('link', { name: '工作日早报' }).closest('li')
    expect(within(card).queryByText(/每/)).not.toBeInTheDocument()
    expect(screen.getByText('已关掉定时运行')).toBeInTheDocument()
  })

  it('定时运行：连续失败被暂停的给出说明，打开开关保存就恢复；开始必须传文件的不能定时', async () => {
    await renderHome({
      trigger: { kind: 'schedule', enabled: false, schedule: { repeat: 'daily', time: '09:00' }, inputs: { text: 'x' },
        notify: { feishu: false, desktop: true }, label: '每天 09:00', last_status: 'error' },
    })
    fireEvent.click(screen.getByRole('button', { name: '「会议纪要转待办」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '定时运行' }))
    let dialog = screen.getByRole('dialog', { name: '定时运行' })
    expect(await within(dialog).findByText('定时运行已暂停')).toBeInTheDocument()
    const sw = within(dialog).getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls('/api/flows/f2/trigger', 'PUT')).toHaveLength(1))
    expect(calls('/api/flows/f2/trigger', 'PUT')[0].body).toMatchObject({ kind: 'schedule', enabled: true, schedule: { repeat: 'daily', time: '09:00' } })
    cleanup()
    const mustFile = { ...FLOWS[1], id: 'f9', name: '合同速查',
      graph: { nodes: [n('start', 'start', { fields: [{ key: 'doc', label: '合同', type: 'file', required: true }] })], edges: [] } }
    await renderHome({ flows: [mustFile] })
    fireEvent.click(screen.getByRole('button', { name: '「合同速查」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '定时运行' }))
    dialog = screen.getByRole('dialog', { name: '定时运行' })
    const blocked = await within(dialog).findByRole('switch')
    expect(blocked).toBeDisabled()
    expect(blocked).toHaveAttribute('aria-checked', 'false')
    expect(within(dialog).getByText(/开始时必须上传「合同」，定时运行没法带文件，所以不能定时/)).toBeInTheDocument()
  })
})

describe('/flows/<id>：画布外壳', () => {
  beforeEach(() => { seen.editor = []; seen.mounts = 0; seen.tours = []; sessionStorage.clear() })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/') })

  it('打开已有流程：懒加载画布，传 flowId / session，不带草稿；返回回到首页', async () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name: '别的草稿', graph: MORNING }))
    await renderAt('/flows/abc')
    const editor = await screen.findByTestId('editor')
    expect(editor).toHaveAttribute('data-flow-id', 'abc')
    const props = seen.editor.at(-1)
    expect(props.initial).toBeUndefined()
    expect(props.session).toEqual({ username: 'demo' })
    expect(typeof props.onExpired).toBe('function')
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toBeNull()   // 不是新建，不动草稿
    fireEvent.click(screen.getByRole('button', { name: '假装返回' }))
    expect(where()).toBe('/flows')
    expect(await screen.findByRole('heading', { level: 1, name: '我的流程' })).toBeInTheDocument()
  })

  it('/flows/new 读走草稿当 initial；第一次保存后地址换成 /flows/<id>，画布不重新挂载', async () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name: '我的早报', summary: '', graph: MORNING }))
    await renderAt('/flows/new')
    expect(await screen.findByText('我的早报')).toBeInTheDocument()
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull()
    const before = window.history.length
    fireEvent.click(screen.getByRole('button', { name: '假装保存' }))
    expect(where()).toBe('/flows/new1')
    expect(window.history.length).toBe(before)   // replace，不多一条历史
    await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-flow-id', 'new1'))
    expect(seen.mounts).toBe(1)
    expect(seen.editor.at(-1).initial.name).toBe('我的早报')
    // 之后再去新建：是新的画布
    act(() => { window.history.pushState({}, '', '/flows/new'); window.dispatchEvent(new PopStateEvent('popstate')) })
    await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-flow-id', 'new'))
    expect(seen.mounts).toBe(2)
    expect(seen.editor.at(-1).initial.graph.nodes.map(x => x.type)).toEqual(['start', 'llm', 'end'])   // 没草稿 → 默认草稿
  })

  it('画布里登录过期交给 onExpired', async () => {
    const { onExpired } = await renderAt('/flows/abc')
    await screen.findByTestId('editor')
    seen.editor.at(-1).onExpired()
    expect(onExpired).toHaveBeenCalled()
  })
})
