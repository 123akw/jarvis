import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Market from './Market.jsx'
import { DRAFT_KEY, normalizeCatalog } from './model.js'

// 本 jsdom 环境不带 Web Storage，按仓库惯例 stub 内存版
function memoryStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: k => { m.delete(k) },
    clear: () => m.clear(),
    dump: () => [...m.values()].join('\n'),
  }
}

const P = (id, name, icon, category, extra = {}) => ({
  id, name, icon, category, summary: `${name}的一句话`, kind: 'tool', tools: [], step: null, requires: [],
  tier: 'free', price: 0, professions: [], examples: [], available: true, ...extra,
})
const CATALOG = {
  categories: [{ id: 'efficiency', name: '效率' }, { id: 'info', name: '资讯' }, { id: 'output', name: '输出' }],
  plugins: [
    P('schedule', '日程提醒', '📅', 'efficiency', { examples: ['明天下午3点开会'] }),
    P('todo', '待办清单', '✅', 'efficiency'),
    P('memo', '随手记', '📝', 'efficiency', { tier: 'pro', price: 9 }),
    P('weather', '天气', '🌤️', 'info'),
    P('feishu', '飞书', '🪽', 'efficiency', { kind: 'channel', requires: ['feishu_bound'] }),
    P('input_text', '贴一段文字', '⌨️', 'output', { kind: 'step' }),
    P('web_page', '做成网页二维码', '🔗', 'output', { kind: 'step', future_field: { x: 1 } }),
  ],
  professions: [
    { id: 'shop_owner', name: '开店的', icon: '🧋', summary: '订单、排班', plugins: ['memo', 'todo', 'weather'],
      flows: [{ id: 'post', name: '上新文案', summary: '', steps: [{ plugin: 'input_text', options: {} }, { plugin: 'web_page', options: {} }] }],
      persona: '', home: { greeting: '老板早！', chips: ['今天谁上早班？'] } },
    { id: 'teacher', name: '老师', icon: '👩‍🏫', summary: '', plugins: ['schedule'], flows: [], home: {} },
  ],
  signup: 'open',
  some_new_field: true,
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/** 按「方法 路径」分派的 fetch mock；calls 记下每次请求体 */
function mockApi(overrides = {}) {
  const calls = []
  const routes = {
    'GET /api/market/catalog': () => json(CATALOG),
    'POST /api/market/recommend': () => json({
      plugins: ['memo', 'todo', 'weather'],
      flows: CATALOG.professions[0].flows,
      reason: '开店最费心的是记事和排班。', source: 'rules',
    }),
    'POST /api/market/signup': body => json({
      username: 'naicha_7k2m', password: 'Qe7v-X2pL-m9dK',
      platform: { ...body.platform, id: 1, slug: 'naicha-7k2m', url: 'https://x.test/p/naicha-7k2m' },
    }, 201),
    'POST /api/login': () => json({ ok: true }),
    'GET /api/session': () => json({ authed: true, username: 'owner', role: 'Owner', csrf_token: 't0k' }),
    'POST /api/logout': () => json({ ok: true }),
    ...overrides,
  }
  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase()
    const path = String(url).split('?')[0]
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body, headers: init.headers || {} })
    const handler = routes[`${method} ${path}`]
    if (!handler) return json({ error: 'not mocked' }, 404)
    return handler(body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}
const called = (calls, method, path) => calls.filter(c => c.method === method && c.path === path)

async function pickAndName(user, plugins = ['日程提醒'], name = '奶茶店小管家') {
  for (const p of plugins) await user.click(await screen.findByRole('button', { name: `加入工具箱：${p}` }))
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await user.type(await screen.findByRole('textbox', { name: '名字' }), name)
}

describe('智能体市场', () => {
  let store
  beforeEach(() => {
    store = memoryStorage()
    vi.stubGlobal('sessionStorage', store)
    vi.stubGlobal('localStorage', memoryStorage())
    window.history.replaceState({}, '', '/')
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.classList.remove('light')
  })

  it('游客完整旅程：挑插件 → 起名 → 生成 → 结果页账号口令 → 去登录带 ?u=', async () => {
    const calls = mockApi()
    const onAuthed = vi.fn()
    const user = userEvent.setup()
    render(<Market session={false} onAuthed={onAuthed} />)
    expect(await screen.findByRole('heading', { name: /拼出你的 AI 智能体/ })).toBeInTheDocument()

    // 没选插件不能往下走
    expect(await screen.findByRole('button', { name: '下一步' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '加入工具箱：日程提醒' }))
    await user.click(screen.getByRole('button', { name: '加入工具箱：待办清单' }))
    expect(screen.getByRole('button', { name: '移出工具箱：日程提醒' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('已选 2 个')

    await user.click(screen.getByRole('button', { name: '下一步' }))
    expect(await screen.findByRole('heading', { name: '给你的智能体起个名字' })).toBeInTheDocument()
    const go = screen.getByRole('button', { name: '生成我的智能体' })
    expect(go).toBeDisabled()
    expect(screen.getByText('给智能体起个名字就能生成')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '名字' }), '奶茶店小管家')
    await user.click(screen.getByRole('radio', { name: '图标 🧋' }))
    await user.click(screen.getByRole('radio', { name: '主题色 玫红' }))
    expect(screen.getByRole('figure', { name: /奶茶店小管家在手机里的样子/ })).toBeInTheDocument()

    await user.click(go)
    expect(await screen.findByRole('heading', { name: '奶茶店小管家' })).toBeInTheDocument()
    const [req] = called(calls, 'POST', '/api/market/signup')
    expect(req.body).toEqual({ platform: { name: '奶茶店小管家', icon: '🧋', accent: '#FF375F', plugins: ['schedule', 'todo'] } })

    const secret = screen.getByRole('region', { name: '专属账号与口令' })
    expect(within(secret).getByText('naicha_7k2m')).toBeInTheDocument()
    expect(within(secret).getByText('Qe7v-X2pL-m9dK')).toBeInTheDocument()
    expect(within(secret).getByText('只显示这一次，请保存')).toBeInTheDocument()
    expect(within(secret).getByRole('button', { name: '复制账号和口令' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /装了这些插件/ })).toHaveTextContent('日程提醒')
    // 二维码内容 = location.origin + loginHref(username)
    expect(screen.getByRole('img', { name: '在手机上打开的二维码：http://localhost/login?u=naicha_7k2m' })).toBeInTheDocument()
    expect(screen.queryByText(/\/p\/naicha-7k2m/)).not.toBeInTheDocument()
    // 口令不落盘
    expect(store.dump()).not.toContain('Qe7v-X2pL-m9dK')

    await user.click(screen.getByRole('button', { name: '去登录' }))
    expect(window.location.pathname + window.location.search).toBe('/login?u=naicha_7k2m')
    expect(onAuthed).not.toHaveBeenCalled()
    expect(called(calls, 'POST', '/api/logout')).toHaveLength(0)
  })

  it('帮我推荐：选职业 → 推荐理由与流程 → 一键全部加入（含流程积木）', async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    // 帮我推荐不再是常驻面板：搜索框下一行「试试：…」点职业，结果就地展开
    expect(screen.queryByRole('region', { name: '为你推荐' })).toBeNull()
    await user.click(await screen.findByRole('radio', { name: /开店的/ }))
    expect(await screen.findByText('开店最费心的是记事和排班。')).toBeInTheDocument()
    expect(called(calls, 'POST', '/api/market/recommend')[0].body).toEqual({ profession: 'shop_owner' })
    expect(screen.getByRole('list', { name: '上新文案的步骤' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '一键全部加入（5 个）' }))
    expect(screen.getByRole('button', { name: /都在工具箱里了/ })).toBeDisabled()
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('已选 5 个')
    const rec = screen.getByRole('region', { name: '推荐结果' })
    expect(within(rec).getAllByRole('button', { name: /^移出工具箱/ })).toHaveLength(3)

    // 一句话描述就打在首屏搜索框里：像一句话时下拉第一行「让 AI 按这句推荐一套」，回车即推荐（带上已选职业）
    const box = screen.getByRole('searchbox', { name: '搜索插件' })
    await user.type(box, '我开奶茶店，想管订单')
    expect(screen.getByRole('option', { name: /让 AI 按这句推荐一套/ })).toBeInTheDocument()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(called(calls, 'POST', '/api/market/recommend')).toHaveLength(2))
    expect(called(calls, 'POST', '/api/market/recommend')[1].body).toEqual({ profession: 'shop_owner', description: '我开奶茶店，想管订单' })
    expect(box).toHaveValue('')
    expect(await screen.findByRole('region', { name: '为你推荐' })).toHaveTextContent('我开奶茶店，想管订单')
    // 面板可以收起，收起后「试试」那行末尾能再打开
    await user.click(screen.getByRole('button', { name: '收起推荐' }))
    expect(screen.queryByRole('region', { name: '为你推荐' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /看推荐结果/ }))
    expect(screen.getByRole('region', { name: '为你推荐' })).toBeInTheDocument()
  })

  it('推荐失败说人话，可以重试', async () => {
    let fail = true
    mockApi({ 'POST /api/market/recommend': () => (fail ? json({ error: 'Too Many Requests' }, 429) : json({ plugins: ['todo'], flows: [], reason: '好了', source: 'model' })) })
    const user = userEvent.setup()
    render(<Market session={false} />)
    await user.click(await screen.findByRole('radio', { name: /老师/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('操作太频繁了，歇一会儿再试')
    fail = false
    await user.click(screen.getByRole('button', { name: '再试一次' }))
    expect(await screen.findByText('好了')).toBeInTheDocument()
    expect(screen.getByText('AI 推荐')).toBeInTheDocument()
  })

  it('注册关闭：提示暂未开放，管理员登录后照样生成（不改 App 会话）', async () => {
    const calls = mockApi({ 'GET /api/market/catalog': () => json({ ...CATALOG, signup: 'off' }) })
    const onAuthed = vi.fn()
    const user = userEvent.setup()
    render(<Market session={false} onAuthed={onAuthed} />)
    await pickAndName(user)
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    const dialog = await screen.findByRole('dialog', { name: '市场注册暂未开放' })
    expect(called(calls, 'POST', '/api/market/signup')).toHaveLength(0)
    expect(within(dialog).queryByRole('textbox', { name: '邀请码' })).not.toBeInTheDocument()

    await user.type(within(dialog).getByRole('textbox', { name: '管理员用户名' }), 'owner')
    await user.type(within(dialog).getByLabelText('口令'), 'pw')
    await user.click(within(dialog).getByRole('button', { name: '登录并生成' }))
    expect(await screen.findByText('Qe7v-X2pL-m9dK')).toBeInTheDocument()
    expect(called(calls, 'POST', '/api/login')[0].body).toEqual({ username: 'owner', password: 'pw' })
    expect(called(calls, 'POST', '/api/market/signup')[0].headers['X-JWS-CSRF']).toBe('t0k')
    expect(onAuthed).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '账号：owner' })).toBeInTheDocument()
  })

  it('注册关闭时管理员口令错了：留在拦路口并提示', async () => {
    mockApi({
      'GET /api/market/catalog': () => json({ ...CATALOG, signup: 'off' }),
      'POST /api/login': () => json({ error: 'bad' }, 401),
    })
    const user = userEvent.setup()
    render(<Market session={false} />)
    await pickAndName(user)
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    const dialog = await screen.findByRole('dialog', { name: '市场注册暂未开放' })
    await user.type(within(dialog).getByRole('textbox', { name: '管理员用户名' }), 'owner')
    await user.type(within(dialog).getByLabelText('口令'), 'nope')
    await user.click(within(dialog).getByRole('button', { name: '登录并生成' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('用户名或口令不对')
  })

  it('邀请码：填码生成；码不对时说服务端的人话', async () => {
    let good = false
    const calls = mockApi({
      'GET /api/market/catalog': () => json({ ...CATALOG, signup: 'invite' }),
      'POST /api/market/signup': body => (good
        ? json({ username: 'u1', password: 'p1', platform: { ...body.platform, slug: 's1' } }, 201)
        : json({ error: '邀请码不对' }, 403)),
    })
    const user = userEvent.setup()
    render(<Market session={false} />)
    await pickAndName(user)
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    const dialog = await screen.findByRole('dialog', { name: '凭邀请码开通' })
    await user.type(within(dialog).getByRole('textbox', { name: '邀请码' }), 'WRONG')
    await user.click(within(dialog).getByRole('button', { name: '开通并生成' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('邀请码不对')

    good = true
    const input = within(dialog).getByRole('textbox', { name: '邀请码' })
    await user.clear(input)
    await user.type(input, 'JWS2026')
    await user.click(within(dialog).getByRole('button', { name: '开通并生成' }))
    expect(await screen.findByText('p1')).toBeInTheDocument()
    expect(called(calls, 'POST', '/api/market/signup').at(-1).body.invite_code).toBe('JWS2026')
    // 也能切到管理员登录
  })

  it('已登录 Owner：不受注册开关限制直接生成；去登录前先退出当前账号', async () => {
    const calls = mockApi({ 'GET /api/market/catalog': () => json({ ...CATALOG, signup: 'off' }) })
    const onAuthed = vi.fn()
    const user = userEvent.setup()
    render(<Market session={{ authed: true, username: 'owner', role: 'Owner' }} onAuthed={onAuthed} />)
    expect(screen.getByRole('button', { name: '账号：owner' })).toBeInTheDocument()
    await pickAndName(user)
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    expect(await screen.findByText('Qe7v-X2pL-m9dK')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '退出当前账号，去登录' }))
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/login?u=naicha_7k2m'))
    expect(called(calls, 'POST', '/api/logout')).toHaveLength(1)
    expect(onAuthed).toHaveBeenCalledWith(false)
  })

  it('已登录 Member 生成得 403：说人话，不弹拦路口', async () => {
    mockApi({ 'POST /api/market/signup': () => json({ error: 'forbidden' }, 403) })
    const user = userEvent.setup()
    render(<Market session={{ authed: true, username: 'amy', role: 'Member' }} />)
    await pickAndName(user)
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    expect(await screen.findByText('这个账号不能在市场里开新账号，请让管理员来操作')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('口令只展示一次：刷新后结果页只剩账号；「再做一个」后彻底清掉', async () => {
    mockApi()
    const user = userEvent.setup()
    const { unmount } = render(<Market session={false} />)
    await pickAndName(user)
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    expect(await screen.findByText('Qe7v-X2pL-m9dK')).toBeInTheDocument()
    unmount()   // 模拟刷新：sessionStorage 还在，内存没了

    render(<Market session={false} />)
    expect(await screen.findByRole('heading', { name: '奶茶店小管家' })).toBeInTheDocument()
    expect(screen.getByText('naicha_7k2m')).toBeInTheDocument()
    expect(screen.queryByText('Qe7v-X2pL-m9dK')).not.toBeInTheDocument()
    expect(screen.getByText(/口令只在生成时显示一次/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '再做一个' }))
    expect(await screen.findByRole('heading', { name: /拼出你的 AI 智能体/ })).toBeInTheDocument()
    expect(screen.queryByText('naicha_7k2m')).not.toBeInTheDocument()
    expect(store.getItem(DRAFT_KEY) || '').not.toContain('naicha_7k2m')
  })

  it('刷新恢复选择：插件、步骤、名字都还在；存储不可用也照常工作', async () => {
    mockApi()
    const user = userEvent.setup()
    const { unmount } = render(<Market session={false} />)
    await pickAndName(user, ['日程提醒', '天气'], '小店')
    unmount()
    render(<Market session={false} />)
    expect(await screen.findByRole('textbox', { name: '名字' })).toHaveValue('小店')
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('已选 2 个')
    cleanup()

    const deny = () => { throw new Error('denied') }
    vi.stubGlobal('sessionStorage', { getItem: deny, setItem: deny, removeItem: deny })
    render(<Market session={false} />)
    await user.click(await screen.findByRole('button', { name: '加入工具箱：天气' }))
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('已选 1 个')
  })

  it('工具箱：点开能移除；存成图片在画不出时提示截图', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    await user.click(await screen.findByRole('button', { name: '加入工具箱：日程提醒' }))
    await user.click(screen.getByRole('button', { name: '加入工具箱：天气' }))
    await user.click(screen.getByRole('button', { name: '工具箱：已选 2 个插件，点开查看' }))
    const sheet = await screen.findByRole('dialog', { name: '我的工具箱' })
    await user.click(within(sheet).getByRole('button', { name: '移除 天气' }))
    expect(within(sheet).queryByText('天气')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('已选 1 个')

    await user.click(screen.getByRole('button', { name: '下一步' }))
    await user.type(await screen.findByRole('textbox', { name: '名字' }), '小店')
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await user.click(await screen.findByRole('button', { name: '存成图片' }))
    expect(await screen.findByText('这台设备画不出图片，请直接截图保存。')).toBeInTheDocument()
    getContext.mockRestore()
  })

  it('目录打不开：说人话并能重试', async () => {
    let down = true
    mockApi({ 'GET /api/market/catalog': () => (down ? json({}, 502) : json(CATALOG)) })
    const user = userEvent.setup()
    render(<Market session={false} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('服务器开小差了，稍后再试')
    down = false
    await user.click(screen.getByRole('button', { name: '再试一次' }))
    expect(await screen.findByRole('button', { name: '加入工具箱：日程提醒' })).toBeInTheDocument()
  })
})

describe('目录容错', () => {
  it('缺字段补默认、未知分类归「其他」、主题色预设兜底', () => {
    const c = normalizeCatalog({
      categories: [{ id: 'efficiency', name: '效率' }],
      plugins: [{ id: 'x' }, { id: 'y', category: 'mystery', icon: '🛸', tier: 'pro' }, null, { name: '没 id' }],
      professions: [{ id: 'p', flows: [{ steps: [{ plugin: 'x' }, { bad: 1 }] }] }],
      signup: 'weird',
    })
    expect(c.plugins.map(p => p.id)).toEqual(['x', 'y'])
    expect(c.plugins[0]).toMatchObject({ name: 'x', icon: '🧩', kind: 'tool', tier: 'free', requires: [] })
    expect(c.categories.map(x => x.id)).toEqual(['other'])
    expect(c.professions[0].flows[0].steps).toHaveLength(1)
    expect(c.signup).toBe('off')
    expect(c.accents).toHaveLength(6)
    expect(c.accents[0]).toEqual({ hex: '#0A84FF', name: '晴空蓝' })
  })
})
