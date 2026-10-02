import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Flows from './Flows.jsx'

/* ---- 契约 mock：catalog / flows / runs / 可控 SSE ---- */
const step = (id, role, name, extra = {}) => ({
  id, name, icon: '·', kind: 'step', summary: `${name}简介`, requires: [], tier: 'free', available: true,
  step: { role, accepts: [], produces: [], options: [] }, ...extra,
})
const CATALOG = {
  categories: [],
  plugins: [
    step('input_text', 'input', '文字输入'),
    step('input_file', 'input', '资料上传'),
    step('split_file', 'process', '文件拆分'),
    step('ai_extract', 'process', 'AI 提炼', { step: { role: 'process', options: [
      { key: 'task', label: '提炼什么', type: 'select', default: '要点', choices: ['要点', '待办', '摘要'] },
    ] } }),
    step('web_page', 'output', '生成网页与二维码'),
    step('feishu_send', 'output', '发到飞书', { available: false, requires: ['feishu_bound'] }),
    { id: 'schedule', name: '日程助手', kind: 'tool', step: null, available: true },
  ],
  professions: [
    { id: 'teacher', name: '老师', icon: '👩‍🏫', flows: [{ id: 'c', name: '课件提炼', summary: '', steps: [{ plugin: 'input_file' }, { plugin: 'web_page' }] }] },
    { id: 'project_manager', name: '项目经理', icon: '📋', flows: [{ id: 'pm', name: '项目资料归档', summary: '拆分提炼再出网页',
      steps: [{ plugin: 'input_file', options: {} }, { plugin: 'split_file', options: {} }, { plugin: 'ai_extract', options: { task: '待办' } }, { plugin: 'web_page', options: {} }] }] },
  ],
}
const FLOW = {
  id: 'f1', name: '会议纪要速发', summary: '', updated_at: '2026-10-02T10:00:00Z', last_run: null,
  steps: [{ id: 's1', plugin: 'input_text', options: {} }, { id: 's2', plugin: 'ai_extract', options: { task: '待办' } }, { id: 's3', plugin: 'web_page', options: {} }],
}

/** 可逐条放行的 SSE 响应；signal 中止时挂起的 read 以 AbortError 结束 */
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

let api
function mockApi({ flows = [FLOW], profession = 'project_manager', listStatus = 200 } = {}) {
  const state = { flows: [...flows], posts: [], puts: [], runBodies: [], stream: null }
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    if (url === '/api/market/catalog') return json(CATALOG)
    if (url === '/api/platform') return json({ platform: profession ? { profession } : null })
    if (url === '/api/flows' && method === 'GET') return json(listStatus === 200 ? { flows: state.flows } : {}, listStatus)
    if (url === '/api/flows' && method === 'POST') {
      const body = JSON.parse(init.body)
      state.posts.push(body)
      return json({ flow: { id: 'new1', name: body.name, last_run: null, steps: body.steps.map((s, i) => ({ id: `n${i}`, ...s })) } })
    }
    let m = url.match(/^\/api\/flows\/([^/]+)$/)
    if (m && method === 'PUT') {
      const body = JSON.parse(init.body)
      state.puts.push({ id: m[1], body })
      return json({ flow: { id: m[1], name: body.name, last_run: null, steps: body.steps.map((s, i) => ({ id: `${m[1]}-${i}`, ...s })) } })
    }
    if (m && method === 'DELETE') return json({ ok: true })
    if (/^\/api\/flows\/[^/]+\/runs/.test(url)) return json({ runs: [] })
    m = url.match(/^\/api\/flows\/([^/]+)\/run$/)
    if (m) {
      state.runBodies.push(JSON.parse(init.body))
      state.stream = sseStream(init.signal)
      return state.stream.response
    }
    return json({ error: 'not mocked' }, 404)
  })
  return state
}

const nodes = c => [...c.querySelectorAll('.fl-chain > .fl-step:not(.fl-step--add)')]
const states = c => nodes(c).map(li => li.dataset.state)
const names = c => nodes(c).map(li => li.querySelector('.fl-card-name').textContent)
const links = c => [...c.querySelectorAll('.fl-chain .fl-link:not(.fl-link--ghost)')].map(l => l.dataset.flow)

async function renderPage(opts) {
  api = mockApi(opts)
  const onExpired = vi.fn()
  const utils = render(<Flows session={{ username: 'demo' }} onExpired={onExpired} />)
  return { ...utils, onExpired }
}

async function pickFromPalette(name) {
  const dialog = await screen.findByRole('dialog', { name: '加一个积木' })
  fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`^${name}`) }))
}

describe('流程拼接页', () => {
  beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true) })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('从职业模板新建：当前职业的模板排最前，保存走 POST 契约', async () => {
    const { container } = await renderPage()
    await screen.findByRole('textbox', { name: '流程名称' })   // 桌面上直接打开最近的流程
    fireEvent.click(screen.getByRole('button', { name: /新建流程/ }))
    const mine = await screen.findByRole('region', { name: '为你推荐：项目经理' })
    const groups = container.querySelectorAll('.fl-tpl-group')
    expect(groups[0]).toBe(mine)
    fireEvent.click(within(mine).getByRole('button', { name: /项目资料归档/ }))
    expect(screen.getByRole('textbox', { name: '流程名称' })).toHaveValue('项目资料归档')
    expect(names(container)).toEqual(['资料上传', '文件拆分', 'AI 提炼', '生成网页与二维码'])
    expect(container.querySelectorAll('.fl-card-sum')[2]).toHaveTextContent('待办')
    expect(screen.getByText('未保存')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存', { selector: '.fl-notice' })
    expect(api.posts).toEqual([{ name: '项目资料归档', steps: [
      { plugin: 'input_file', options: {} }, { plugin: 'split_file', options: {} },
      { plugin: 'ai_extract', options: { task: '待办' } }, { plugin: 'web_page', options: {} },
    ] }])
    // 列表里多了这一条，并且是当前项
    const side = screen.getByRole('complementary', { name: '流程列表' })
    expect(within(side).getByRole('button', { name: /项目资料归档/ })).toHaveAttribute('aria-current', 'true')
  })

  it('没有职业信息时模板全列', async () => {
    const { container } = await renderPage({ flows: [], profession: null })
    await screen.findByRole('heading', { name: '新建流程' })
    expect([...container.querySelectorAll('.fl-tpl-group .fl-sub')].map(h => h.textContent)).toEqual(['👩‍🏫 老师', '📋 项目经理'])
    expect(screen.getByText('还没有流程')).toBeInTheDocument()
  })

  it('空白开始：增删移动积木，校验提示说人话，不合格不发请求', async () => {
    const { container } = await renderPage({ flows: [] })
    fireEvent.click(await screen.findByRole('button', { name: /空白开始/ }))
    expect(screen.getByText('先加一个积木，从「输入」开始')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /添加第一步/ }))
    // 不可用的积木灰显并说明原因，点了也不加
    const dialog = await screen.findByRole('dialog', { name: '加一个积木' })
    const feishu = within(dialog).getByRole('button', { name: /^发到飞书/ })
    expect(feishu).toHaveAttribute('aria-disabled', 'true')
    expect(feishu).toHaveAccessibleDescription('先在设置里绑定飞书才能用')
    fireEvent.click(feishu)
    expect(screen.getByRole('dialog', { name: '加一个积木' })).toBeInTheDocument()
    // 只列积木：对话技能（日程助手）不在面板里
    expect(within(dialog).queryByRole('button', { name: /日程助手/ })).toBeNull()
    await pickFromPalette('AI 提炼')
    expect(names(container)).toEqual(['AI 提炼'])
    expect(screen.getByText('第一步要是输入，比如「文字输入」或「资料上传」')).toBeInTheDocument()

    // 输入积木从末尾加，也会放到第一步
    fireEvent.click(screen.getByRole('button', { name: /加一步/ }))
    await pickFromPalette('文字输入')
    expect(names(container)).toEqual(['文字输入', 'AI 提炼'])
    expect(screen.queryByText(/第一步要是输入/)).toBeNull()
    expect(screen.getByText('还差一个输出，比如「生成网页与二维码」')).toBeInTheDocument()

    // 校验没过：点保存只把提示变醒目，不发请求
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(container.querySelector('.fl-hints')).toHaveClass('is-loud')
    expect(api.posts).toHaveLength(0)

    // 连线中点插入；已经有输入了，另一个输入积木灰显
    fireEvent.click(screen.getByRole('button', { name: '在第 1 步和第 2 步之间插入积木' }))
    const d2 = await screen.findByRole('dialog', { name: '加一个积木' })
    expect(within(d2).getByRole('button', { name: /^资料上传/ })).toHaveAccessibleDescription('已经有输入了，一个流程只要一个输入')
    await pickFromPalette('文件拆分')
    expect(names(container)).toEqual(['文字输入', '文件拆分', 'AI 提炼'])

    // 选中节点：往前挪 / 往后挪
    fireEvent.click(screen.getByRole('button', { name: /^第 3 步，处理：AI 提炼/ }))
    fireEvent.click(screen.getByRole('button', { name: /往前挪/ }))
    expect(names(container)).toEqual(['文字输入', 'AI 提炼', '文件拆分'])
    fireEvent.click(screen.getByRole('button', { name: /往后挪/ }))
    expect(names(container)).toEqual(['文字输入', '文件拆分', 'AI 提炼'])
    expect(screen.getByRole('button', { name: /往后挪/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /加一步/ }))
    await pickFromPalette('生成网页与二维码')
    expect(container.querySelector('.fl-hints')).toBeNull()
    // 结果网页一个流程只要一个
    fireEvent.click(screen.getByRole('button', { name: /加一步/ }))
    const d3 = await screen.findByRole('dialog', { name: '加一个积木' })
    expect(within(d3).getByRole('button', { name: /^生成网页与二维码/ })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(within(d3).getByRole('button', { name: '关闭' }))

    // 点节点打开配置，删除这一步
    fireEvent.click(screen.getByRole('button', { name: /^第 2 步，处理：文件拆分/ }))
    fireEvent.click(screen.getByRole('button', { name: /删除这一步/ }))
    expect(names(container)).toEqual(['文字输入', 'AI 提炼', '生成网页与二维码'])

    fireEvent.change(screen.getByRole('textbox', { name: '流程名称' }), { target: { value: '周报速写' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(api.posts[0]).toEqual({ name: '周报速写', steps: [
      { plugin: 'input_text', options: {} }, { plugin: 'ai_extract', options: { task: '要点' } }, { plugin: 'web_page', options: {} },
    ] })
  })

  it('带了不可用积木：能保存，但运行前就说清楚为什么跑不了', async () => {
    const flow = { ...FLOW, steps: [{ id: 'a', plugin: 'input_text', options: {} }, { id: 'b', plugin: 'feishu_send', options: {} }] }
    const { container } = await renderPage({ flows: [flow] })
    await screen.findByRole('textbox', { name: '流程名称' })
    expect(container.querySelector('.fl-hints')).toHaveTextContent('「发到飞书」现在用不了：先在设置里绑定飞书才能用')
    fireEvent.click(screen.getByRole('button', { name: '运行', exact: true }))
    expect(await screen.findByRole('alert')).toHaveTextContent('先换掉它再运行')
    expect(screen.queryByRole('dialog', { name: '试运行' })).toBeNull()
  })

  it('运行历史：状态、时间、输入、结果链接', async () => {
    api = mockApi()
    const runs = [{ id: 'r1', flow_id: 'f1', status: 'ok', started_at: '2026-10-02T10:00:00Z', finished_at: '2026-10-02T10:00:04Z',
      input: { kind: 'file', name: '周报.pdf', bytes: 1200 }, steps: [], error: null, output: { url: '/r/abc', title: '周报' } },
    { id: 'r0', flow_id: 'f1', status: 'error', started_at: '2026-10-02T09:00:00Z', finished_at: '2026-10-02T09:00:01Z',
      input: { kind: 'text', chars: 80 }, steps: [], error: '飞书没绑定', output: null }]
    const base = global.fetch
    global.fetch = vi.fn(async (url, init) => (/\/runs/.test(url) ? { ok: true, status: 200, json: async () => ({ runs }) } : base(url, init)))
    render(<Flows session={{ username: 'demo' }} onExpired={() => {}} />)
    const hist = await screen.findByRole('region', { name: '最近运行' })
    await within(hist).findByText('成功')
    expect(within(hist).getByText('周报.pdf · 4.0 秒')).toBeInTheDocument()
    expect(within(hist).getByRole('link', { name: /打开结果/ })).toHaveAttribute('href', 'http://localhost/r/abc')
    expect(within(hist).getByText('飞书没绑定')).toBeInTheDocument()
  })

  it('改配置后保存走 PUT', async () => {
    await renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^第 2 步，处理：AI 提炼/ }))
    const panel = screen.getByRole('region', { name: '第 2 步设置：AI 提炼' })
    fireEvent.change(within(panel).getByRole('combobox', { name: '提炼什么' }), { target: { value: '摘要' } })
    expect(screen.getByRole('button', { name: /^第 2 步，处理：AI 提炼。摘要/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.puts).toHaveLength(1))
    expect(api.puts[0].id).toBe('f1')
    expect(api.puts[0].body.steps[1]).toEqual({ plugin: 'ai_extract', options: { task: '摘要' } })
  })

  async function startRun(container, text = '今天开会定了三件事') {
    await screen.findByRole('textbox', { name: '流程名称' })
    fireEvent.click(screen.getByRole('button', { name: '运行', exact: true }))
    const sheet = await screen.findByRole('dialog', { name: '试运行' })
    expect(within(sheet).getByRole('button', { name: '开始运行' })).toBeDisabled()
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: text } })
    fireEvent.click(within(sheet).getByRole('button', { name: '开始运行' }))
    await waitFor(() => expect(api.stream).not.toBeNull())
    await waitFor(() => expect(states(container)).toEqual(['pending', 'pending', 'pending']))
    return api.stream
  }

  it('运行成功：事件驱动节点逐个亮起，结果卡给链接与二维码', async () => {
    const { container } = await renderPage()
    const s = await startRun(container)
    expect(api.runBodies[0]).toEqual({ text: '今天开会定了三件事' })
    await act(async () => { s.send({ type: 'run_start', run_id: 'r1' }); s.send({ type: 'step_start', step_id: 's1', plugin: 'input_text' }) })
    await waitFor(() => expect(states(container)).toEqual(['running', 'pending', 'pending']))
    expect(screen.getByRole('button', { name: /取消运行/ })).toBeInTheDocument()
    await act(async () => { s.send({ type: 'step_done', step_id: 's1', summary: '读入 9 个字', preview: '今天开会定了三件事', ms: 1234 }) })
    await waitFor(() => expect(states(container)[0]).toBe('done'))
    expect(nodes(container)[0]).toHaveTextContent('1.2 秒')
    expect(links(container)).toEqual(['flowing', 'idle'])   // 信号正流向下一个节点
    await act(async () => {
      s.send({ type: 'step_start', step_id: 's2' })
      s.send({ type: 'step_done', step_id: 's2', summary: '提炼出 3 条待办' })
    })
    await waitFor(() => expect(states(container)).toEqual(['done', 'done', 'pending']))
    expect(links(container)).toEqual(['lit', 'flowing'])
    // 中间结果可展开
    fireEvent.click(screen.getAllByRole('button', { name: '展开看看' })[0])
    expect(container.querySelector('.fl-preview')).toHaveTextContent('今天开会定了三件事')
    await act(async () => {
      s.send({ type: 'step_start', step_id: 's3' })
      s.send({ type: 'step_done', step_id: 's3', summary: '结果网页已生成' })
      s.send({ type: 'run_done', status: 'ok', output: { url: '/r/tok123', title: '会议纪要 · 10 月 2 日' } })
    })
    const card = await screen.findByRole('region', { name: '运行结果' })
    expect(states(container)).toEqual(['done', 'done', 'done'])
    expect(within(card).getByRole('heading', { name: '会议纪要 · 10 月 2 日' })).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: '打开结果网页' })).toHaveAttribute('href', 'http://localhost/r/tok123')
    expect(within(card).getByRole('img', { name: /结果网页二维码/ })).toBeInTheDocument()
    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.click(within(card).getByRole('button', { name: /复制链接/ }))
    await within(card).findByRole('button', { name: /已复制/ })
    expect(writeText).toHaveBeenCalledWith('http://localhost/r/tok123')
    // 列表里的「上次运行」跟着更新
    expect(within(screen.getByRole('complementary')).getByText(/上次运行成功/)).toBeInTheDocument()
  })

  it('结果是文件（生成 Excel / Word 积木）：结果卡给下载按钮，不给二维码', async () => {
    const { container } = await renderPage()
    const s = await startRun(container)
    await act(async () => {
      s.send({ type: 'run_start', run_id: 'r9' })
      s.send({ type: 'run_done', status: 'ok', output: { url: '/api/files/AbC123xyz', title: '会议纪要.xlsx', kind: 'file' } })
    })
    const card = await screen.findByRole('region', { name: '运行结果' })
    expect(within(card).getByRole('heading', { name: '会议纪要.xlsx' })).toBeInTheDocument()
    const download = within(card).getByRole('link', { name: '下载文件' })
    expect(download).toHaveAttribute('href', '/api/files/AbC123xyz')
    expect(download).toHaveAttribute('download')
    expect(within(card).queryByRole('img', { name: /二维码/ })).toBeNull()
    expect(within(card).queryByRole('link', { name: '打开结果网页' })).toBeNull()
  })

  it('中途失败：失败节点标红并说原因，后面的节点不再亮', async () => {
    const { container } = await renderPage()
    const s = await startRun(container)
    await act(async () => {
      s.send({ type: 'step_start', step_id: 's1' })
      s.send({ type: 'step_done', step_id: 's1', summary: 'ok' })
      s.send({ type: 'step_start', step_id: 's2' })
      s.send({ type: 'step_error', step_id: 's2', message: '模型这会儿没响应，稍后再试' })
      s.send({ type: 'run_done', status: 'error', output: null })
    })
    const card = await screen.findByRole('region', { name: '运行结果' })
    expect(states(container)).toEqual(['done', 'error', 'skipped'])
    expect(container.querySelector('.fl-out--error')).toHaveTextContent('模型这会儿没响应，稍后再试')
    expect(card).toHaveTextContent('卡在第 2 步「AI 提炼」')
    expect(within(card).getByRole('button', { name: '再试一次' })).toBeInTheDocument()
  })

  it('中途取消：停在当前步骤，结果卡说明前面的结果还在', async () => {
    const { container } = await renderPage()
    const s = await startRun(container)
    await act(async () => {
      s.send({ type: 'step_start', step_id: 's1' })
      s.send({ type: 'step_done', step_id: 's1', summary: 'ok' })
      s.send({ type: 'step_start', step_id: 's2' })
    })
    await waitFor(() => expect(states(container)).toEqual(['done', 'running', 'pending']))
    fireEvent.click(screen.getByRole('button', { name: /取消运行/ }))
    const card = await screen.findByRole('region', { name: '运行结果' })
    expect(states(container)).toEqual(['done', 'cancelled', 'cancelled'])
    expect(card).toHaveTextContent('前面完成的 1 步结果还留在节点下面')
    expect(screen.getByRole('button', { name: '运行', exact: true })).toBeEnabled()
  })

  it('资料上传：选文件转 base64 发出，超过 10MB 说人话', async () => {
    const flow = { ...FLOW, steps: [{ id: 'a', plugin: 'input_file', options: {} }, { id: 'b', plugin: 'web_page', options: {} }] }
    await renderPage({ flows: [flow] })
    await screen.findByRole('textbox', { name: '流程名称' })
    fireEvent.click(screen.getByRole('button', { name: '运行', exact: true }))
    const sheet = await screen.findByRole('dialog', { name: '试运行' })
    const input = sheet.querySelector('input[type=file]')
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 })
    fireEvent.change(input, { target: { files: [big] } })
    expect(within(sheet).getByText('文件超过 10MB 上限，换个小一点的')).toBeInTheDocument()
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.exe')] } })
    expect(within(sheet).getByText(/只支持 PDF/)).toBeInTheDocument()
    fireEvent.change(input, { target: { files: [new File(['ABC'], '纪要.txt', { type: 'text/plain' })] } })
    fireEvent.click(within(sheet).getByRole('button', { name: '开始运行' }))
    await waitFor(() => expect(api.runBodies).toHaveLength(1))
    expect(api.runBodies[0]).toEqual({ file: { name: '纪要.txt', data_base64: 'QUJD' } })
  })

  it('上层重渲染换了 onExpired 也不重新加载（不冲掉正在编辑的内容）', async () => {
    const { rerender } = await renderPage()
    const box = await screen.findByRole('textbox', { name: '流程名称' })
    fireEvent.change(box, { target: { value: '改了一半' } })
    rerender(<Flows session={{ username: 'demo' }} onExpired={() => {}} />)
    await act(async () => {})
    expect(global.fetch.mock.calls.filter(([u]) => u === '/api/flows')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: '流程名称' })).toHaveValue('改了一半')
  })

  it('登录过期调 onExpired', async () => {
    const { onExpired } = await renderPage({ listStatus: 401 })
    await waitFor(() => expect(onExpired).toHaveBeenCalled())
  })
})
