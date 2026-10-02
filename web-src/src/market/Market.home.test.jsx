import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GROUP_PREVIEW } from './Catalog.jsx'
import Market from './Market.jsx'
import {
  badgesFor, blockReason, bundlesFrom, filterPlugins, kindCounts, normalizeCatalog, relatedPlugins, searchPlugins, sourceOf,
} from './model.js'

/* 第十五轮：市场成为首页（/）——顶栏、搜索、筛选、精选套装、?plugin= 详情、工具箱排序 */

function memoryStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: k => { m.delete(k) }, clear: () => m.clear() }
}

const P = (id, name, icon, category, extra = {}) => ({
  id, name, icon, category, summary: `${name}的一句话`, kind: 'tool', tools: [], step: null, requires: [], tier: 'free', price: 0,
  professions: [], examples: [], available: true, builtin: true, status: 'ok', reason: '', version: '1.0.0', author: 'JWS-Agent',
  homepage: '', source: { type: 'builtin' }, license: 'MIT-0', ...extra,
})
const CATALOG = {
  categories: [{ id: 'efficiency', name: '效率' }, { id: 'info', name: '资讯' }, { id: 'life', name: '生活' }, { id: 'ai', name: 'AI 处理' }],
  plugins: [
    P('schedule', '日程提醒', '📅', 'efficiency', { tools: ['schedule_add', 'schedule_list'], examples: ['明天下午三点开会', '这周有什么安排'] }),
    P('todo', '待办清单', '✅', 'efficiency', { tools: ['todo_add'] }),
    P('memo', '随手记', '📝', 'efficiency'),
    P('weather', '查天气', '🌤️', 'life', { tools: ['weather', 'weather_here'], examples: ['明天会下雨吗'] }),
    P('search', '联网搜索', '🔎', 'info', { tools: ['web_search'] }),
    P('weekly', '周报写手', '🗓️', 'ai', { kind: 'skill', examples: ['帮我写这周的周报'] }),
    P('xhs', '小红书文案', '📕', 'ai', { kind: 'skill', summary: '爆款标题加分段正文' }),
    P('deepwiki', 'DeepWiki', '📚', 'info', { kind: 'mcp', hosts: ['mcp.deepwiki.com'],
      tools: [{ name: 'ask_question', description: '就这个仓库提一个问题' }] }),
    P('amap', '高德地图', '🗺️', 'life', { kind: 'mcp', hosts: ['mcp.amap.com'], status: 'needs_config', reason: '需要管理员填写高德 Key',
      config: [{ key: 'AMAP_KEY', label: '高德 Web 服务 Key', required: true, configured: false }] }),
    P('echo', '回声测试', '🔊', 'efficiency', { builtin: false, author: 'acme', source: { type: 'github', repo: 'acme/echo', ref: 'main' } }),
    P('ai_extract', 'AI 提炼', '✨', 'ai', { kind: 'step', step: { role: 'process', options: [{ key: 'task', label: '提炼什么' }] } }),
  ],
  professions: [
    { id: 'shop_owner', name: '个体店主', icon: '🏪', summary: '小店的事都能交代', plugins: ['memo', 'todo', 'weather', 'amap'],
      flows: [{ id: 'post', name: '上新文案', summary: '', steps: [{ plugin: 'ai_extract', options: {} }] }],
      home: { greeting: '老板早！今天店里要办什么？', chips: ['记一下补货'] } },
    { id: 'student', name: '学生', icon: '🎒', summary: '课表作业', plugins: ['schedule', 'todo'], flows: [], home: {} },
    { id: 'lonely', name: '只有一个', icon: '1️⃣', summary: '', plugins: ['memo'], flows: [], home: {} },
  ],
  signup: 'open',
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function mockApi(overrides = {}, catalog = CATALOG) {
  const calls = []
  const routes = {
    'GET /api/market/catalog': () => json(catalog),
    'POST /api/market/recommend': () => json({ plugins: ['memo'], flows: [], reason: '先记事。', source: 'model' }),
    'POST /api/market/signup': body => json({ username: 'shop_1', password: 'pw-1', platform: { ...body.platform } }, 201),
    'GET /api/plugins': () => json({ plugins: [], sources: [] }),
    ...overrides,
  }
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase()
    const path = String(url).split('?')[0]
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const handler = routes[`${method} ${path}`]
    return handler ? handler(body) : json({ error: 'not mocked' }, 404)
  }))
  return calls
}
const called = (calls, method, path) => calls.filter(c => c.method === method && c.path === path)
const toolbox = () => screen.getByRole('region', { name: '工具箱' })
/** 目录里当前显示的插件卡（不含精选套装卡） */
const cards = () => within(document.getElementById('jvm-catalog')).queryAllByRole('article').map(a => a.getAttribute('aria-label'))

describe('市场首页：顶栏、搜索与筛选', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    window.history.replaceState({}, '', '/')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('顶栏：游客看到「登录」去 /login；已登录看到「进入我的智能体」去 /app 和头像；检查中都不显示', async () => {
    mockApi()
    const user = userEvent.setup()
    const { unmount } = render(<Market session={false} />)
    await screen.findByRole('article', { name: '查天气' })
    expect(screen.queryByRole('button', { name: /进入我的智能体/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(window.location.pathname).toBe('/login')
    unmount()

    window.history.replaceState({}, '', '/')
    const second = render(<Market session={{ authed: true, username: 'amy', role: 'Member' }} />)
    await screen.findByRole('article', { name: '查天气' })
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(screen.getByRole('button', { name: '账号：amy' })).toHaveTextContent('A')
    await user.click(screen.getByRole('button', { name: /进入我的智能体/ }))
    expect(window.location.pathname).toBe('/app')
    second.unmount()

    render(<Market session={null} />)
    await screen.findByRole('article', { name: '查天气' })
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(screen.queryByRole('button', { name: /进入我的智能体/ })).toBeNull()
  })

  it('头像菜单：点头像展开账号名与菜单，Esc 收起；退出登录后留在市场当游客', async () => {
    const calls = mockApi({ 'POST /api/logout': () => json({ ok: true }) })
    const user = userEvent.setup()
    const onAuthed = vi.fn()
    render(<Market session={{ authed: true, username: 'amy', role: 'Member' }} onAuthed={onAuthed} />)
    await screen.findByRole('article', { name: '查天气' })
    const avatar = screen.getByRole('button', { name: '账号：amy' })
    expect(avatar).toHaveAttribute('aria-expanded', 'false')
    await user.click(avatar)
    const menu = screen.getByRole('menu', { name: '账号菜单' })
    expect(within(menu).getByText('amy')).toBeInTheDocument()
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['进入我的智能体', '我的流程', '退出登录'])
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(avatar)
    await user.click(avatar)
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }))
    await waitFor(() => expect(onAuthed).toHaveBeenCalledWith(false))
    expect(called(calls, 'POST', '/api/logout')).toHaveLength(1)
    expect(window.location.pathname).toBe('/')
  })

  it('管理员入口挪进头像菜单：只有 Owner 有「插件管理」，打开插件管理弹窗；目录里不再有虚线框入口', async () => {
    mockApi()
    const user = userEvent.setup()
    const { unmount } = render(<Market session={{ authed: true, username: 'amy', role: 'Member' }} />)
    await screen.findByRole('article', { name: '查天气' })
    await user.click(screen.getByRole('button', { name: '账号：amy' }))
    expect(screen.queryByRole('menuitem', { name: '插件管理' })).toBeNull()
    unmount()

    render(<Market session={{ authed: true, username: 'boss', role: 'Owner' }} />)
    await screen.findByRole('article', { name: '查天气' })
    expect(screen.queryByRole('button', { name: '导入插件' })).toBeNull()
    expect(screen.queryByRole('button', { name: '管理插件' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '账号：boss' }))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(i => i.textContent))
      .toEqual(['进入我的智能体', '我的流程', '插件管理', '退出登录'])
    await user.click(screen.getByRole('menuitem', { name: '插件管理' }))
    const dialog = await screen.findByRole('dialog', { name: '插件管理' })
    expect(within(dialog).getByRole('tab', { name: '已装' })).toHaveAttribute('aria-selected', 'true')
  })

  it('搜索：「/」与 Ctrl+K 聚焦，即时过滤（名称、示例、类型都能搜），Esc 清空；搜不到时一键让 AI 推荐', async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    await screen.findByRole('article', { name: '查天气' })
    const box = screen.getByRole('searchbox', { name: '搜索插件' })
    await user.keyboard('/')
    expect(box).toHaveFocus()
    await user.type(box, '天气')
    expect(screen.getByRole('heading', { name: /“天气” 的结果/ })).toHaveTextContent('1 个')
    expect(screen.getByRole('article', { name: '查天气' })).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: '日程提醒' })).toBeNull()
    expect(screen.queryByRole('region', { name: '精选套装' })).toBeNull()   // 搜索结果直接替换精选与总览

    await user.clear(box)
    await user.type(box, '开会')   // 只出现在「日程提醒」的示例里
    expect(screen.getByRole('article', { name: '日程提醒' })).toBeInTheDocument()
    await user.clear(box)
    await user.type(box, 'mcp')    // 类型名也能搜
    expect(cards()).toEqual(['DeepWiki', '高德地图'])

    await user.keyboard('{Escape}')
    expect(box).toHaveValue('')
    expect(screen.getByRole('region', { name: '精选套装' })).toBeInTheDocument()
    box.blur()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(box).toHaveFocus()

    await user.type(box, '火星移民')
    expect(screen.getByText('没找到和「火星移民」相关的插件')).toBeInTheDocument()
    expect(screen.queryByRole('option')).toBeNull()   // 四个字不算一句话：不弹「让 AI 推荐」
    await user.click(screen.getByRole('button', { name: /让 AI 按这句推荐/ }))
    await waitFor(() => expect(called(calls, 'POST', '/api/market/recommend')).toHaveLength(1))
    expect(called(calls, 'POST', '/api/market/recommend')[0].body).toEqual({ description: '火星移民' })
    expect(box).toHaveValue('')
    expect(await screen.findByText('先记事。')).toBeInTheDocument()
  })

  it('筛选：分类页签是主导航（不带计数）；来源 / 类型收进「筛选」弹层；组合为空时能一键清除', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    await screen.findByRole('article', { name: '查天气' })
    expect(screen.queryByRole('group', { name: '按类型' })).toBeNull()   // 默认不再摆三排
    const cats = screen.getByRole('group', { name: '按分类看' })
    expect(within(cats).getByRole('button', { name: '效率' })).toHaveTextContent(/^效率$/)
    const filterBtn = () => screen.getByRole('button', { name: /^筛选/ })
    const openFilter = async () => {
      if (!screen.queryByRole('dialog', { name: '筛选' })) await user.click(filterBtn())
      return screen.getByRole('dialog', { name: '筛选' })
    }
    const pick = async (group, name) => {
      const pop = await openFilter()
      await user.click(within(within(pop).getByRole('group', { name: group })).getByRole('button', { name }))
    }

    await pick('按类型', '技能')
    expect(within(screen.getByRole('group', { name: '按类型' })).getByRole('button', { name: '技能' })).toHaveAttribute('aria-pressed', 'true')
    expect(cards()).toEqual(['周报写手', '小红书文案'])
    expect(filterBtn()).toHaveAccessibleName('筛选（已选 1 项）')
    // 没有技能的分类收起
    expect(within(cats).queryByRole('button', { name: '效率' })).toBeNull()
    expect(within(cats).getByRole('button', { name: 'AI 处理' })).toBeInTheDocument()

    await pick('按类型', '工具')
    await user.click(within(cats).getByRole('button', { name: '效率' }))   // 点弹层外面：弹层收起
    expect(screen.queryByRole('dialog', { name: '筛选' })).toBeNull()
    expect(cards()).toEqual(['日程提醒', '待办清单', '随手记', '回声测试'])
    await pick('按来源', '社区')
    expect(cards()).toEqual(['回声测试'])
    await pick('按类型', 'MCP')
    expect(cards()).toHaveLength(0)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '筛选' })).toBeNull()
    expect(filterBtn()).toHaveFocus()

    const empty = screen.getByText('这个组合下还没有插件').closest('.jvm-none')
    await user.click(within(empty).getByRole('button', { name: '清除筛选' }))
    expect(screen.getByRole('article', { name: '查天气' })).toBeInTheDocument()
    const pop = await openFilter()
    expect(within(within(pop).getByRole('group', { name: '按类型' })).getByRole('button', { name: 'MCP' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(within(pop).getByRole('group', { name: '按类型' })).getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('大目录：总览每个分类先露几张，「全部 N 个」切到该分类看全', async () => {
    const many = Array.from({ length: 60 }, (_, i) => P(`p${i}`, `插件${i}`, '🧩', i % 2 ? 'efficiency' : 'life'))
    mockApi({}, { ...CATALOG, plugins: many })
    const user = userEvent.setup()
    render(<Market session={false} />)
    const group = await screen.findByRole('region', { name: /^效率/ })
    expect(within(group).getAllByRole('article')).toHaveLength(GROUP_PREVIEW)
    await user.click(screen.getByRole('button', { name: '查看效率的全部 30 个插件' }))
    expect(cards()).toHaveLength(30)
    expect(screen.getByRole('heading', { name: /效率/, level: 2 })).toHaveTextContent('30 个')
    expect(screen.queryByRole('region', { name: '精选套装' })).toBeNull()   // 切到分类：精选让位
  })
})

describe('插件详情：?plugin=<id>', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    window.history.replaceState({}, '', '/')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('点卡片打开详情（地址带 ?plugin=），能加入工具箱；Esc / 后退关闭，地址复原', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    const card = await screen.findByRole('article', { name: '查天气' })
    const link = within(card).getByRole('link', { name: '查天气' })
    expect(link).toHaveAttribute('href', '/?plugin=weather')
    await user.click(link)
    const dialog = await screen.findByRole('dialog', { name: '插件详情：查天气' })
    expect(window.location.search).toBe('?plugin=weather')
    expect(within(dialog).getByRole('heading', { name: '它能做什么' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('城市天气')            // 工具名换成人话
    expect(within(dialog).getByRole('heading', { name: '试试这样问' })).toBeInTheDocument()
    expect(within(dialog).getByText('开箱即用，不需要额外设置。')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('MIT-0')

    await user.click(within(dialog).getByRole('button', { name: '加入工具箱：查天气' }))
    expect(within(dialog).getByRole('button', { name: '移出工具箱：查天气' })).toHaveAttribute('aria-pressed', 'true')
    expect(toolbox()).toHaveTextContent('已选 1 个')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.location.search).toBe('')
    expect(link).toHaveFocus()   // 焦点还给打开它的卡片

    // 浏览器后退同样关闭
    await user.click(link)
    expect(await screen.findByRole('dialog', { name: '插件详情：查天气' })).toBeInTheDocument()
    window.history.back()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('分享链接直接打开详情；同类推荐里换插件不加深历史；关闭时去掉参数；不存在的插件给出路', async () => {
    mockApi()
    const user = userEvent.setup()
    window.history.replaceState({}, '', '/?plugin=todo')
    const { unmount } = render(<Market session={false} />)
    const dialog = await screen.findByRole('dialog', { name: '插件详情：待办清单' })
    const related = within(dialog).getByRole('region', { name: '同类推荐' })
    await user.click(within(related).getByRole('link', { name: /随手记/ }))
    expect(await screen.findByRole('dialog', { name: '插件详情：随手记' })).toBeInTheDocument()
    expect(window.location.search).toBe('?plugin=memo')
    await user.click(screen.getByRole('button', { name: '关闭详情' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.location.pathname + window.location.search).toBe('/')
    unmount()

    window.history.replaceState({}, '', '/?plugin=gone')
    render(<Market session={false} />)
    const missing = await screen.findByRole('dialog', { name: '插件详情' })
    expect(within(missing).getByText('没找到这个插件')).toBeInTheDocument()
    await user.click(within(missing).getByRole('button', { name: '回到市场' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('需要配置的 MCP 插件：卡片与详情都不能加入，详情写清原因、联网主机和缺的配置', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    const card = await screen.findByRole('article', { name: '高德地图' })
    // 卡片最多一个徽标：需要配置 > 暂不可用 > 专业版 > MCP > 社区
    expect(within(card).getByText('需要配置')).toBeInTheDocument()
    expect(within(card).queryByText('MCP')).toBeNull()
    expect(within(card).getByRole('button', { name: '加入工具箱：高德地图' })).toBeDisabled()
    await user.click(within(card).getByRole('link', { name: '高德地图' }))
    const dialog = await screen.findByRole('dialog', { name: '插件详情：高德地图' })
    expect(within(dialog).getByRole('note')).toHaveTextContent('需要管理员填写高德 Key（缺：AMAP_KEY）')
    expect(dialog).toHaveTextContent('联网：mcp.amap.com')
    expect(dialog).toHaveTextContent('需要配置：高德 Web 服务 Key')
    expect(within(dialog).getByRole('button', { name: '加入工具箱：高德地图' })).toBeDisabled()
  })

  it('试试这样问：点一下复制；「带去推荐」关掉详情直接按这句推荐', async () => {
    const calls = mockApi()
    const user = userEvent.setup()   // userEvent 自带剪贴板替身：在它上面盯 writeText
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    window.history.replaceState({}, '', '/?plugin=schedule')
    render(<Market session={false} />)
    const dialog = await screen.findByRole('dialog', { name: '插件详情：日程提醒' })
    await user.click(within(dialog).getByRole('button', { name: '复制：明天下午三点开会' }))
    expect(writeText).toHaveBeenCalledWith('明天下午三点开会')
    expect(await within(dialog).findByText('已复制')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '带去推荐：这周有什么安排' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(called(calls, 'POST', '/api/market/recommend')).toHaveLength(1))
    expect(called(calls, 'POST', '/api/market/recommend')[0].body).toEqual({ description: '这周有什么安排' })
    expect(await screen.findByRole('region', { name: '为你推荐' })).toHaveTextContent('这周有什么安排')
  })
})

describe('精选套装与工具箱', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    window.history.replaceState({}, '', '/')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('精选套装一键整套加入（跳过需要配置的），顺手记上职业，起名页用这个职业的开场白', async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    const featured = await screen.findByRole('region', { name: '精选套装' })
    expect(within(featured).queryByText('只有一个套装')).toBeNull()   // 少于两个插件的不成套
    await user.click(within(featured).getByRole('button', { name: '整套加入：店主套装（4 个）' }))
    expect(toolbox()).toHaveTextContent('已选 4 个')
    expect(toolbox()).toHaveTextContent('3 工具 · 1 积木')
    expect(screen.getByText('已把「店主套装」的 4 个插件放进工具箱')).toBeInTheDocument()
    expect(within(featured).getByRole('button', { name: '店主套装已全部加入' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '下一步' }))
    expect(await screen.findByText('老板早！今天店里要办什么？')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '名字' }), '小店')
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    await screen.findByText('pw-1')
    expect(called(calls, 'POST', '/api/market/signup')[0].body.platform).toMatchObject({
      profession: 'shop_owner', plugins: ['memo', 'todo', 'weather', 'ai_extract'],
    })
  })

  it('工具箱抽屉：看类型分布、上下排序、移除、两步清空；生成按排好的顺序装', async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    for (const name of ['日程提醒', '周报写手', 'DeepWiki']) {
      await user.click(await screen.findByRole('button', { name: `加入工具箱：${name}` }))
    }
    await user.click(screen.getByRole('button', { name: '工具箱：已选 3 个插件，点开查看' }))
    const sheet = await screen.findByRole('dialog', { name: '我的工具箱' })
    expect(sheet).toHaveTextContent('已选 3 个 · 1 工具 · 1 技能 · 1 MCP')
    const order = () => within(sheet).getAllByRole('listitem').map(li => li.getAttribute('data-id'))
    expect(order()).toEqual(['schedule', 'weekly', 'deepwiki'])
    expect(within(sheet).getByRole('button', { name: '上移 日程提醒' })).toBeDisabled()
    await user.click(within(sheet).getByRole('button', { name: '上移 DeepWiki' }))
    expect(order()).toEqual(['schedule', 'deepwiki', 'weekly'])
    await user.click(within(sheet).getByRole('button', { name: '下移 日程提醒' }))
    expect(order()).toEqual(['deepwiki', 'schedule', 'weekly'])
    await user.click(within(sheet).getByRole('button', { name: '移除 周报写手' }))
    expect(order()).toEqual(['deepwiki', 'schedule'])

    await user.click(within(sheet).getByRole('button', { name: '下一步' }))
    await user.type(await screen.findByRole('textbox', { name: '名字' }), '研究助理')
    await user.click(screen.getByRole('button', { name: '生成我的智能体' }))
    await screen.findByText('pw-1')
    expect(called(calls, 'POST', '/api/market/signup')[0].body.platform.plugins).toEqual(['deepwiki', 'schedule'])
  })

  it('工具箱：全部清空要点两次；空了给「去挑插件」', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    await user.click(await screen.findByRole('button', { name: '加入工具箱：查天气' }))
    await user.click(screen.getByRole('button', { name: '工具箱：已选 1 个插件，点开查看' }))
    const sheet = await screen.findByRole('dialog', { name: '我的工具箱' })
    await user.click(within(sheet).getByRole('button', { name: '全部清空' }))
    expect(toolbox()).toHaveTextContent('已选 1 个')
    await user.click(within(sheet).getByRole('button', { name: '再点一次，全部清空' }))
    expect(within(sheet).getByText('工具箱还是空的')).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: '去挑插件' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(toolbox()).toHaveTextContent('工具箱是空的')
  })
})

describe('目录模型：搜索、筛选、套装、徽标', () => {
  const data = normalizeCatalog(CATALOG)
  it('归一：MCP、需要配置、工具对象、许可证', () => {
    const amap = data.plugins.find(p => p.id === 'amap')
    expect(amap).toMatchObject({ kind: 'mcp', status: 'needs_config', hosts: ['mcp.amap.com'], configMissing: ['AMAP_KEY'], license: 'MIT-0' })
    expect(blockReason(amap)).toBe('需要管理员填写高德 Key')
    expect(data.plugins.find(p => p.id === 'deepwiki').tools).toEqual([{ name: 'ask_question', label: '', description: '就这个仓库提一个问题' }])
    expect(data.plugins.find(p => p.id === 'weather').tools[0]).toEqual({ name: 'weather', label: '', description: '' })
    // MCP 插件带 tool_info（中文 label）时优先用它，详情页不露出 deepwiki__xxx 工具名
    const labeled = normalizeCatalog({ plugins: [{ id: 'dw', mcp: true, tools: ['dw__read_wiki_structure'],
      tool_info: [{ name: 'dw__read_wiki_structure', label: '查看仓库文档目录', description: 'Get a list of topics' }] }] }).plugins[0]
    expect(labeled.tools).toEqual([{ name: 'dw__read_wiki_structure', label: '查看仓库文档目录', description: 'Get a list of topics' }])
    // 老后端：mcp 只出现在 extras 里、没给 config 状态时不算「需要配置」
    const legacy = normalizeCatalog({ plugins: [{ id: 'x', extras: { mcp: [{ name: 'm', url: 'https://mcp.example.com/mcp' }] },
      config: [{ key: 'K', label: 'Key' }] }] }).plugins[0]
    expect(legacy).toMatchObject({ kind: 'mcp', status: 'ok', hosts: ['mcp.example.com'] })
  })

  it('搜索：每个词都要命中，名称命中的排前；filterPlugins 组合；社区筛选含插件源装的', () => {
    expect(searchPlugins(data.plugins, '').length).toBe(data.plugins.length)
    expect(searchPlugins(data.plugins, '周报').map(p => p.id)).toEqual(['weekly'])
    expect(searchPlugins(data.plugins, '文案 爆款').map(p => p.id)).toEqual(['xhs'])
    expect(searchPlugins(data.plugins, 'AI', data.categories).map(p => p.id).slice(0, 1)).toEqual(['ai_extract'])
    expect(filterPlugins(data.plugins, { kind: 'mcp', cat: 'life' }).map(p => p.id)).toEqual(['amap'])
    const fromSource = { ...data.plugins[0], builtin: false, source: { type: 'github', marketplace: 'm1' } }
    expect(sourceOf(fromSource)).toBe('source')
    expect(filterPlugins([fromSource], { source: 'community' })).toHaveLength(1)
    expect(kindCounts(data.plugins.slice(0, 8))).toEqual([
      { id: 'tool', label: '工具', n: 5 }, { id: 'skill', label: '技能', n: 2 }, { id: 'mcp', label: 'MCP', n: 1 }])
  })

  it('套装、徽标与同类推荐', () => {
    const bundles = bundlesFrom(data)
    expect(bundles.map(b => b.title)).toEqual(['店主套装', '学生套装'])
    expect(bundles[0].ids).toEqual(['memo', 'todo', 'weather', 'ai_extract'])
    expect(badgesFor(data.plugins.find(p => p.id === 'amap')).map(b => b.label)).toEqual(['官方', 'MCP', '需要配置'])
    expect(badgesFor(data.plugins.find(p => p.id === 'echo')).map(b => b.label)).toEqual(['社区'])
    expect(badgesFor(data.plugins.find(p => p.id === 'weekly')).map(b => b.label)).toEqual(['官方', '技能'])
    const rel = relatedPlugins(data.plugins, data.plugins.find(p => p.id === 'todo'))
    expect(rel[0].category).toBe('efficiency')
    expect(rel.some(p => p.id === 'todo')).toBe(false)
  })
})
