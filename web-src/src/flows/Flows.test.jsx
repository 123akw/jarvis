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
import { defaultMessageField, hookFlags, lastStatusText } from './TriggerSheet.jsx'

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
      { node_id: 'start', title: '开始', node_type: 'start', status: 'ok', summary: '读到 10 字', preview: '', ms: 3,
        files: [{ name: '九月销售.xlsx', url: '/api/files/AbCdEf123456' }, { name: '坏的', url: 'javascript:alert(1)' }] },
      { node_id: 'w', title: '查实时天气', node_type: 'tool', status: 'ok', summary: '北京 晴', preview: '城市：北京\n天气：晴', ms: 820 },
      { node_id: 'x', title: '发到微信', node_type: 'step', status: 'skipped', summary: '', preview: '', ms: null },
    ] },
  { id: 'r1', status: 'error', started_at: new Date(Date.now() - 86400e3).toISOString(), ms: 2300, input_summary: '手动运行',
    page_url: '', output_text: '', error: '「查实时天气」没走通', nodes: [] },
] }

/** SSE 响应：一次把事件都给出去（重跑用） */
function sseResponse(events) {
  const chunks = events.map(ev => new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`))
  let i = 0
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), releaseLock() {} }) } }
}

let api
const CHANNELS = { feishu: { ready: true, reason: '' }, wechat: { ready: false, reason: '微信只有管理员账号能用' } }

function mockApi({ flows = FLOWS, listStatus = 200, composeFail = 0, trigger = null, feishuBound = false, runs = RUNS, hooks = {}, approvals = null } = {}) {
  const state = { flows: flows.map(f => ({ ...f })), calls: [], composeFail, trigger, feishuBound, rerun: null, hooks: { ...hooks }, tokens: 0, hookFail: '', approvals }
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    state.calls.push({ url, method, body })
    if (/^\/api\/flows\/[^/]+\/runs\/[^/]+\/rerun$/.test(url)) {
      const r = state.rerun || { events: [] }
      return r.status ? res(r.body || {}, r.status) : sseResponse(r.events)
    }
    if (/^\/api\/flows\/[^/]+\/runs/.test(url) && runs !== RUNS) return res(runs)
    if (url.startsWith('/api/approvals?')) return state.approvals ? res(state.approvals) : res({ error: 'not mocked' }, 404)
    // 第二十轮：触发方式（收到消息 / 通过链接）
    let h = url.match(/^\/api\/flows\/([^/]+)\/hooks$/)
    if (h) return res(state.hooks[h[1]] || { message: null, webhook: null, channels: CHANNELS })
    h = url.match(/^\/api\/flows\/([^/]+)\/hooks\/(message|webhook)$/)
    if (h) {
      const cur = state.hooks[h[1]] || { message: null, webhook: null, channels: CHANNELS }
      if (h[2] === 'message') {
        if (state.hookFail) return res({ error: state.hookFail }, 409)
        state.hooks[h[1]] = { ...cur, message: { ...body, last_hit_at: null } }
        return res({ message: state.hooks[h[1]].message })
      }
      if (method === 'DELETE') { state.hooks[h[1]] = { ...cur, webhook: null }; return res({ webhook: null }) }
      state.tokens += 1
      const webhook = { enabled: true, created_at: new Date().toISOString(), last_hit_at: null, url_hint: `…k${state.tokens}Zx` }
      state.hooks[h[1]] = { ...cur, webhook }
      return res({ webhook, url: `https://jarvis.example.com/api/hooks/tok${state.tokens}abcdefk${state.tokens}Zx` })
    }
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
    expect(items.map(i => i.textContent)).toEqual(['打开', '运行记录', '触发方式', '复制', '删除'])
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
    expect(screen.getByRole('dialog', { name: '触发方式' })).toBeInTheDocument()
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
    // 开始节点上传的原件（第十九轮）：只给站内文件的下载链接
    expect(within(steps).getAllByRole('link', { name: /原件：/ }).map(a => a.getAttribute('href'))).toEqual(['/api/files/AbCdEf123456'])
    expect(within(steps).getByRole('link', { name: /原件：九月销售\.xlsx/ })).toBeInTheDocument()
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

  it('运行记录：来源说人话（重复的不再标）；等你确认 / 没同意的状态；每条「再跑」，在等确认的不能再跑', async () => {
    const now = Date.now()
    const runs = { runs: [
      { id: 'r5', status: 'waiting', source: 'chat', started_at: new Date(now - 60e3).toISOString(), input_summary: '城市：北京', nodes: [],
        approval: { id: 'apv777', expires_at: new Date(now + 4.5 * 3600e3).toISOString() } },
      { id: 'r4', status: 'rejected', source: 'webhook', started_at: new Date(now - 600e3).toISOString(), input_summary: '', nodes: [] },
      { id: 'r3', status: 'ok', source: 'manual', started_at: new Date(now - 3600e3).toISOString(), input_summary: '手动运行', nodes: [] },
    ] }
    await renderHome({ runs })
    fireEvent.click(screen.getByRole('button', { name: '「工作日早报」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '运行记录' }))
    const drawer = screen.getByRole('dialog', { name: '运行记录：工作日早报' })
    const list = await within(drawer).findByRole('list', { name: '最近的运行' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('等你确认对话里叫跑的')
    expect(items[1]).toHaveTextContent('你没同意链接触发')
    expect(within(items[2]).queryByText('手动运行', { selector: '.fh-run-src' })).toBeNull()   // 摘要里说过了
    expect(within(items[0]).queryByRole('button', { name: /用这次的输入再跑/ })).toBeNull()
    expect(within(items[1]).getByRole('button', { name: /用这次的输入再跑/ })).toBeInTheDocument()
    // 等确认的那条：详情里给「去确认」
    fireEvent.click(within(items[0]).getByRole('button', { name: /等你确认/ }))
    expect(within(drawer).getByRole('heading', { name: '这次运行在等你确认' })).toBeInTheDocument()
    expect(within(drawer).getByText(/对话里叫跑的/)).toBeInTheDocument()
    const go = within(drawer).getByRole('link', { name: '去确认' })
    expect(go).toHaveAttribute('href', '/approve/apv777')
    expect(within(drawer).getByRole('note')).toHaveTextContent('还剩 4 小时')
    fireEvent.click(go)
    expect(where()).toBe('/approve/apv777')
  })

  it('用这次的输入再跑：就地显示每一步与结果；回到全部记录会重新加载；在详情里也能再跑；接口拒了说人话', async () => {
    await renderHome()
    api.rerun = { events: [
      { type: 'run_start', run_id: 'r9' },
      { type: 'node_start', node_id: 'w', node_type: 'tool', title: '查实时天气' },
      { type: 'node_done', node_id: 'w', ms: 900, summary: '北京 多云' },
      { type: 'node_start', node_id: 'n1', node_type: 'llm' },
      { type: 'node_done', node_id: 'n1', ms: 2100, summary: '写好了' },
      { type: 'run_done', status: 'ok', ms: 3100, output: { text: '**新的早报**', page_url: '/r/new', links: [] } },
    ] }
    fireEvent.click(screen.getByRole('button', { name: '「工作日早报」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '运行记录' }))
    const drawer = screen.getByRole('dialog', { name: '运行记录：工作日早报' })
    await within(drawer).findAllByRole('button', { name: /完成|失败/ })
    fireEvent.click(within(drawer).getAllByRole('button', { name: /用这次的输入再跑/ })[0])
    expect(await within(drawer).findByRole('heading', { name: '这次运行完成' })).toBeInTheDocument()
    expect(calls('/api/flows/f1/runs/r2/rerun', 'POST')).toHaveLength(1)
    const steps = within(drawer).getByRole('region', { name: '每一步的进度' })
    expect(within(steps).getByText('查实时天气')).toBeInTheDocument()
    expect(within(steps).getByText('北京 多云')).toBeInTheDocument()
    expect(within(steps).getByText('写成早报')).toBeInTheDocument()   // 事件没带名字：用那次记录里的
    const result = within(drawer).getByRole('region', { name: '最终结果' })
    expect(result.querySelector('strong')).toHaveTextContent('新的早报')
    expect(within(result).getByRole('link', { name: /打开结果网页/ })).toHaveAttribute('href', 'http://localhost/r/new')
    expect(within(drawer).getByText(/用的是 .* 的输入/)).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: /全部记录/ }))
    await waitFor(() => expect(calls('/api/flows/f1/runs?limit=20')).toHaveLength(2))
    // 详情里的完整按钮；这回接口说今天的用量到上限了
    api.rerun = { status: 429, body: { error: '今天的用量到上限了，明天再来，或请管理员调高' } }
    fireEvent.click((await within(drawer).findAllByRole('button', { name: /失败/ }))[0])
    fireEvent.click(within(drawer).getByRole('button', { name: '用这次的输入再跑' }))
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('今天的用量到上限了')
    expect(within(drawer).getByRole('heading', { name: '没能再跑' })).toBeInTheDocument()
  })

  it('顶部「等你确认 · N」：没有待确认不出现；有就出现，点开是列表（流程名、哪一步、预览、还剩多久），点一条进确认页', async () => {
    const { container } = await renderHome()
    await waitFor(() => expect(calls('/api/approvals?status=pending&limit=20')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: /等你确认/ })).toBeNull()
    cleanup()
    const now = Date.now()
    await renderHome({ approvals: { pending: 2, approvals: [
      { id: 'apv111', flow: { id: 'f1', name: '工作日早报' }, title: '发群前给我看看', preview: '今天北京晴，18–26 度。上午 10 点周会。', status: 'pending',
        created_at: new Date(now - 600e3).toISOString(), expires_at: new Date(now + 23.5 * 3600e3).toISOString() },
      { id: 'apv222', flow: { id: 'f2', name: '会议纪要转待办' }, title: '加待办前确认', preview: '1. 订会议室', status: 'pending',
        created_at: new Date(now - 7200e3).toISOString(), expires_at: new Date(now + 40 * 60e3).toISOString() },
    ] } })
    const bar = await screen.findByRole('button', { name: /等你确认 · 2/ })
    expect(bar).toHaveTextContent('「工作日早报」等 2 个流程停在发送前，等你看一眼')
    expect(bar.compareDocumentPosition(screen.getByRole('heading', { level: 1, name: '我的流程' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(bar)
    const drawer = screen.getByRole('dialog', { name: '等你确认' })
    const items = within(within(drawer).getByRole('list', { name: '等你确认的流程' })).getAllByRole('link')
    expect(items.map(a => a.getAttribute('href'))).toEqual(['/approve/apv111', '/approve/apv222'])
    expect(items[0]).toHaveTextContent('工作日早报还剩 23 小时停在「发群前给我看看」 · 10 分钟前今天北京晴')
    expect(within(items[1]).getByText('还剩 40 分钟')).toHaveClass('is-soon')
    fireEvent.click(items[1])
    expect(where()).toBe('/approve/apv222')
    expect(container).toBeTruthy()
  })

  it('触发方式的小工具：两种 hooks 写法都认；消息默认填进第一个长文字（没有再第一个文字）；上次触发的结果说人话', () => {
    expect(hookFlags({ message: true, webhook: false })).toEqual({ message: true, webhook: false })
    expect(hookFlags({ message: { enabled: true }, webhook: null })).toEqual({ message: true, webhook: false })
    expect(hookFlags(null)).toEqual({ message: false, webhook: false })
    expect(defaultMessageField([{ key: 'city', type: 'text' }, { key: 'note', type: 'paragraph' }])).toBe('note')
    expect(defaultMessageField([{ key: 'n', type: 'number' }, { key: 'city', type: 'text' }])).toBe('city')
    expect(defaultMessageField([{ key: 'f', type: 'file' }])).toBe('')
    expect(lastStatusText('error')).toMatch('上次没跑通')
    expect(lastStatusText('waiting')).toMatch('发送前确认')
    expect(lastStatusText('ok')).toBe('')
  })

  it('联调：列表项自带 hooks 两个布尔时直接用、不再逐个去读；当时文件没存下来的运行「再跑」置灰并说原因', async () => {
    const flows = [{ ...FLOWS[0], hooks: { message: true, webhook: false } }, { ...FLOWS[1], hooks: { message: false, webhook: true } }]
    const runs = { runs: [{ id: 'r8', status: 'ok', source: 'manual', started_at: new Date(Date.now() - 3600e3).toISOString(), input_summary: '合同：a.pdf',
      rerunnable: false, nodes: [] }] }
    await renderHome({ flows, runs })
    const card1 = screen.getByRole('link', { name: '工作日早报' }).closest('li')
    const card2 = screen.getByRole('link', { name: '会议纪要转待办' }).closest('li')
    expect(within(card1).getByText('收到消息')).toBeInTheDocument()
    expect(within(card1).queryByText('链接')).toBeNull()
    expect(within(card2).getByText('链接')).toBeInTheDocument()
    expect(api.calls.filter(c => /\/hooks$/.test(c.url))).toHaveLength(0)
    fireEvent.click(within(card1).getByRole('button', { name: '「工作日早报」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '运行记录' }))
    const drawer = screen.getByRole('dialog', { name: '运行记录：工作日早报' })
    const again = await within(drawer).findByRole('button', { name: /用这次的输入再跑.*要重新上传文件才能再跑/ })
    expect(again).toBeDisabled()
    fireEvent.click(within(drawer).getByRole('button', { name: /完成/ }))
    expect(within(drawer).getByRole('button', { name: '用这次的输入再跑' })).toBeDisabled()
    expect(within(drawer).getByText(/要重新上传文件才能再跑：这次用的文件当时没存下来/)).toBeInTheDocument()
  })

  it('卡片上的触发标记：⏰ 定时 / 💬 收到消息 / 🔗 链接，只显示开着的', async () => {
    await renderHome({ hooks: { f1: { message: { enabled: true }, webhook: { enabled: true }, channels: CHANNELS }, f2: { message: { enabled: false }, webhook: null, channels: CHANNELS } } })
    const card1 = screen.getByRole('link', { name: '工作日早报' }).closest('li')
    await within(card1).findByText('收到消息')
    expect(within(card1).getByText('链接')).toBeInTheDocument()
    expect(within(card1).getByText('每个工作日 08:00').closest('.fh-flow-timer')).toHaveTextContent('⏰每个工作日 08:00')
    const card2 = screen.getByRole('link', { name: '会议纪要转待办' }).closest('li')
    expect(within(card2).queryByText('收到消息')).toBeNull()
    expect(within(card2).queryByText('链接')).toBeNull()
    expect(calls('/api/flows/f1/hooks')).toHaveLength(1)
  })

  it('触发方式：三个页签（← → 切换）；收到消息时——渠道没绑好灰显、关键词胶囊（≤20 字）、消息填进哪一项、必填拦下，保存后卡片出 💬', async () => {
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: '「会议纪要转待办」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '触发方式' }))
    const dialog = screen.getByRole('dialog', { name: '触发方式' })
    const tabs = within(dialog).getAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['⏰定时', '💬收到消息时', '🔗通过链接'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    expect(tabs[1]).toHaveFocus()
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    const panel = within(dialog).getByRole('tabpanel')
    expect(await within(panel).findByRole('switch', { name: /收到消息时自动运行/ })).toHaveAttribute('aria-checked', 'true')
    // 渠道：飞书好的默认勾上；微信没接好灰显并说原因
    expect(within(panel).getByRole('checkbox', { name: /飞书/ })).toBeChecked()
    const wx = within(panel).getByRole('checkbox', { name: /微信/ })
    expect(wx).toBeDisabled()
    expect(wx).toHaveAccessibleDescription('微信只有管理员账号能用')
    // 没加关键词不让存
    fireEvent.click(within(panel).getByRole('button', { name: '保存' }))
    expect(within(panel).getByRole('alert')).toHaveTextContent('加至少一个关键词')
    const kw = within(panel).getByRole('textbox', { name: '关键词' })
    fireEvent.change(kw, { target: { value: '纪要' } })
    fireEvent.keyDown(kw, { key: 'Enter' })
    fireEvent.change(kw, { target: { value: '这是一个特别特别特别特别特别特别长的关键词啊' } })
    fireEvent.keyDown(kw, { key: 'Enter' })
    expect(within(panel).getByText('每个关键词不超过 20 个字')).toBeInTheDocument()
    fireEvent.change(kw, { target: { value: '会议，周会' } })
    fireEvent.keyDown(kw, { key: 'Enter' })
    expect(within(panel).getByRole('list', { name: '已加的关键词' })).toHaveTextContent('纪要会议周会')
    fireEvent.click(within(panel).getByRole('button', { name: '删掉关键词「周会」' }))
    fireEvent.keyDown(kw, { key: 'Backspace' })   // 空输入框退格删最后一个
    expect(within(panel).getByRole('list', { name: '已加的关键词' })).toHaveTextContent('纪要')
    // 消息填进哪一项：默认第一个文字输入；改成不填 → 必填的「会议记录」没人填，拦下
    const target = within(panel).getByRole('combobox', { name: '消息的文字填进哪一项' })
    expect(target).toHaveValue('text')
    expect(within(panel).getByText(/消息里带的文件会填进「录音或附件」/)).toBeInTheDocument()
    fireEvent.change(target, { target: { value: '' } })
    fireEvent.click(within(panel).getByRole('button', { name: '保存' }))
    expect(within(panel).getByRole('alert')).toHaveTextContent('「会议记录」必须填，收到消息时没人填它')
    fireEvent.change(target, { target: { value: 'text' } })
    fireEvent.click(within(panel).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls('/api/flows/f2/hooks/message', 'PUT')[0].body).toEqual({
      enabled: true, channels: ['feishu'], match: 'keywords', keywords: ['纪要'], input_field: 'text',
    })
    expect(screen.getByText('已保存：收到符合条件的消息就会自动运行')).toBeInTheDocument()
    expect(within(screen.getByRole('link', { name: '会议纪要转待办' }).closest('li')).getByText('收到消息')).toBeInTheDocument()
  })

  it('收到消息时：选「所有消息」不用关键词；服务端拒了（同渠道已有别的流程收所有消息）说人话', async () => {
    await renderHome()
    api.hookFail = '飞书的「所有消息」已经交给「工作日早报」了，一个渠道只能有一个'
    fireEvent.click(screen.getByRole('button', { name: '「会议纪要转待办」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '触发方式' }))
    const dialog = screen.getByRole('dialog', { name: '触发方式' })
    fireEvent.click(within(dialog).getByRole('tab', { name: /收到消息时/ }))
    const panel = within(dialog).getByRole('tabpanel')
    fireEvent.click(await within(panel).findByRole('radio', { name: '所有消息' }))
    expect(within(panel).queryByRole('textbox', { name: '关键词' })).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: '保存' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent('一个渠道只能有一个')
    expect(calls('/api/flows/f2/hooks/message', 'PUT')[0].body).toMatchObject({ match: 'all', keywords: [] })
  })

  it('通过链接：生成后地址只显示一次（醒目提示、复制、调用示例、202 / 限流说明）；重置要确认、换新地址；关掉后回到没开的样子', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: '「会议纪要转待办」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '触发方式' }))
    const dialog = screen.getByRole('dialog', { name: '触发方式' })
    fireEvent.click(within(dialog).getByRole('tab', { name: /通过链接/ }))
    const panel = within(dialog).getByRole('tabpanel')
    fireEvent.click(await within(panel).findByRole('button', { name: /生成链接/ }))
    expect(await within(panel).findByText('只显示这一次，请复制保存')).toBeInTheDocument()
    const url = within(panel).getByRole('textbox', { name: '链接触发的地址' })
    expect(url).toHaveValue('https://jarvis.example.com/api/hooks/tok1abcdefk1Zx')
    expect(url).toHaveAttribute('readonly')
    await waitFor(() => expect(url).toHaveFocus())
    fireEvent.click(within(panel).getByRole('button', { name: /复制地址/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://jarvis.example.com/api/hooks/tok1abcdefk1Zx'))
    expect(await within(panel).findByRole('button', { name: /已复制/ })).toBeInTheDocument()
    const example = within(panel).getByLabelText('调用示例')
    expect(example.textContent).toContain("curl -X POST 'https://jarvis.example.com/api/hooks/tok1abcdefk1Zx'")
    // 示例按开始节点里的名字填（服务端按名字或内部名字都认），有默认值的用默认值
    expect(example.textContent).toContain('"inputs":{"会议记录":"这里填会议记录","纪要风格":"简洁"}')
    expect(panel).toHaveTextContent('每一项写开始节点里的名字（「会议记录」、「纪要风格」）')
    expect(panel).toHaveTextContent('状态码 202')
    expect(panel).toHaveTextContent('waiting 是停在发送前确认')
    expect(panel).toHaveTextContent('这个流程正在跑时回 409')
    expect(panel).toHaveTextContent('每分钟最多 30 次、今天的用量用完了，都回 429')
    expect(panel).toHaveTextContent('链接关掉了、或流程删掉了回 410')
    expect(panel).not.toHaveTextContent(/token|令牌/i)
    expect(within(panel).getByText('链接触发已开启')).toBeInTheDocument()
    expect(calls('/api/flows/f2/hooks/webhook', 'POST')).toHaveLength(1)
    // 重置：先确认
    fireEvent.click(within(panel).getByRole('button', { name: '重置链接' }))
    expect(within(panel).getByText(/重置后旧地址马上失效/)).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: '确认重置' }))
    await waitFor(() => expect(within(panel).getByRole('textbox', { name: '链接触发的地址' })).toHaveValue('https://jarvis.example.com/api/hooks/tok2abcdefk2Zx'))
    // 卡片上出现 🔗
    expect(within(screen.getByRole('link', { name: '会议纪要转待办' }).closest('li')).getByText('链接')).toBeInTheDocument()
    // 关掉
    fireEvent.click(within(panel).getByRole('button', { name: '关掉' }))
    fireEvent.click(within(panel).getByRole('button', { name: '确认关掉' }))
    expect(await within(panel).findByRole('button', { name: /生成链接/ })).toBeInTheDocument()
    expect(within(panel).queryByRole('textbox', { name: '链接触发的地址' })).toBeNull()
    expect(calls('/api/flows/f2/hooks/webhook', 'DELETE')).toHaveLength(1)
    expect(within(screen.getByRole('link', { name: '会议纪要转待办' }).closest('li')).queryByText('链接')).toBeNull()
  })

  it('通过链接：已开着时只给地址末尾，不再显示完整地址', async () => {
    await renderHome({ hooks: { f2: { message: null, webhook: { enabled: true, created_at: '2026-10-01T08:00:00Z', last_hit_at: new Date(Date.now() - 7200e3).toISOString(), url_hint: '/api/hooks/Q7xz…', last_status: 'error' }, channels: CHANNELS } } })
    fireEvent.click(screen.getByRole('button', { name: '「会议纪要转待办」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '触发方式' }))
    const dialog = screen.getByRole('dialog', { name: '触发方式' })
    fireEvent.click(within(dialog).getByRole('tab', { name: /通过链接/ }))
    const panel = within(dialog).getByRole('tabpanel')
    expect(await within(panel).findByText('链接触发已开启')).toBeInTheDocument()
    expect(panel).toHaveTextContent('上次触发 2 小时前')
    expect(panel).toHaveTextContent('地址形如「/api/hooks/Q7xz…」')
    expect(panel).toHaveTextContent('上次没跑通，到运行记录里看看原因')
    expect(within(panel).queryByRole('textbox', { name: '链接触发的地址' })).toBeNull()
    expect(within(panel).getByLabelText('调用示例').textContent).toContain('这里换成你的地址')
    expect(within(dialog).getByRole('tab', { name: /通过链接/ })).toHaveAccessibleName('通过链接（已开启）')
  })

  it('定时运行：重复 / 时间 / 预填输入（文件字段说明）/ 飞书没绑定灰显 / 下次运行及之后 2 次；保存发契约格式并更新卡片', async () => {
    await renderHome()
    fireEvent.click(screen.getByRole('button', { name: '「会议纪要转待办」的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '触发方式' }))
    const dialog = screen.getByRole('dialog', { name: '触发方式' })
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
    fireEvent.click(screen.getByRole('menuitem', { name: '触发方式' }))
    const dialog = screen.getByRole('dialog', { name: '触发方式' })
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
    fireEvent.click(screen.getByRole('menuitem', { name: '触发方式' }))
    let dialog = screen.getByRole('dialog', { name: '触发方式' })
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
    fireEvent.click(screen.getByRole('menuitem', { name: '触发方式' }))
    dialog = screen.getByRole('dialog', { name: '触发方式' })
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
