import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Market from './Market.jsx'
import { normalizeCatalog, shortRef, sourceLink } from './model.js'

function memoryStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: k => { m.delete(k) }, clear: () => m.clear() }
}

const SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const P = (id, name, extra = {}) => ({
  id, name, icon: '🧩', category: 'efficiency', summary: `${name}的一句话`, kind: 'tool', tools: [], step: null, requires: [],
  tier: 'free', price: 0, professions: [], examples: [], available: true, builtin: true, status: 'ok', reason: '',
  version: '1.0.0', author: 'JWS-Agent', homepage: '', source: { type: 'builtin' }, ...extra,
})
const CATALOG = {
  categories: [{ id: 'efficiency', name: '效率' }, { id: 'documents', name: '资料' }],
  plugins: [
    P('todo', '待办清单'),
    P('excel', 'Excel 工具箱', { category: 'documents', status: 'unavailable', available: false, reason: '缺少 Python 包：openpyxl' }),
    P('echo_tool', '回声测试', { builtin: false, version: '0.1.0', author: '社区作者',
      source: { type: 'github', repo: 'acme/echo', ref: SHA, path: 'plugins/echo' } }),
  ],
  professions: [], accents: [], signup: 'open',
}
const PREVIEW = {
  token: 'tok-123456789', plugin: { id: 'polite_reply', name: '礼貌回复', version: '1.2.0', icon: '📘', kind: 'skill', author: '某作者',
    summary: '回复客户先致谢', license: 'MIT', examples: [], requires: [], homepage: 'https://example.com', category: 'ai' },
  links: { homepage: 'https://example.com', privacy: 'https://example.com/privacy', terms: '', repository: '' },
  tools: [], permissions: [{ key: 'prompt', label: '往对话的系统提示词里加一段做事方法', level: 'info' },
    { key: 'subprocess', label: '在独立子进程里运行插件自带的 Python 代码', level: 'warn' }],
  python_packages: [{ name: 'pypdf', installed: true }, { name: 'openpyxl', installed: false }], missing_packages: ['openpyxl'],
  files: [{ path: 'SKILL.md', size: 300 }], file_count: 1, total_size: 300,
  source: { type: 'github', repo: 'acme/skills', ref: SHA, path: 'polite' }, warnings: ['第三方代码将在服务器上运行'],
  upgrade: null, skill: { title: '礼貌回复', chars: 100 },
}
const SOURCES = [{ id: 'jarvis_examples', name: 'jarvis-examples', display_name: '示例插件源',
  origin: { type: 'github', repo: 'acme/market', ref: SHA }, plugins: [
    { name: 'festival-greetings', id: 'festival_greetings', display_name: '节日祝福语', description: '写祝福', installed: false, id_taken: false },
  ], skipped: [{ name: 'node-thing', reason: 'npm 包需要 Node 环境' }] }]

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function mockApi(role = 'Owner', overrides = {}) {
  const calls = []
  const routes = {
    'GET /api/market/catalog': () => json(CATALOG),
    'GET /api/plugins': () => json({ plugins: [
      { id: 'echo_tool', name: '回声测试', icon: '🔊', builtin: false, enabled: true, status: 'ok', reason: '', version: '0.1.0',
        source: { type: 'github', repo: 'acme/echo', ref: SHA } },
      { id: 'todo', name: '待办清单', icon: '✅', builtin: true, enabled: false, status: 'disabled', reason: '已停用', version: '1.0.0', source: { type: 'builtin' } },
    ], sources: SOURCES }),
    'POST /api/plugins/import/preview': () => json(PREVIEW),
    'POST /api/plugins/import/confirm': () => json({ id: 'polite_reply', name: '礼貌回复', version: '1.2.0', status: 'ok', reason: '', upgraded: false }, 201),
    'POST /api/plugins/sources/jarvis_examples/preview': () => json({ ...PREVIEW, plugin: { ...PREVIEW.plugin, name: '节日祝福语' } }),
    'POST /api/plugins/echo_tool/disable': () => json({ id: 'echo_tool', enabled: false, status: 'disabled' }),
    'DELETE /api/plugins/echo_tool': () => json({ id: 'echo_tool', removed: ['echo_tool'] }),
    ...overrides,
  }
  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase()
    const path = String(url).split('?')[0]
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const handler = routes[`${method} ${path}`]
    return handler ? handler(body) : json({ error: 'not mocked' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, session: { authed: true, username: role === 'Owner' ? 'admin' : 'member', role, csrf_token: 't' } }
}

describe('插件市场：来源、不可用与插件管理', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    window.history.replaceState({}, '', '/')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('目录归一：老后端没有来源字段时按内置、可用处理；来源链接指到固定 commit', () => {
    const data = normalizeCatalog({ plugins: [{ id: 'x', name: 'X', category: 'efficiency' }, CATALOG.plugins[2]] })
    expect(data.plugins[0]).toMatchObject({ builtin: true, status: 'ok' })
    expect(sourceLink(data.plugins[1])).toBe(`https://github.com/acme/echo/tree/${SHA}/plugins/echo`)
    expect(sourceLink({ source: { type: 'zip' }, homepage: 'javascript:alert(1)' })).toBe('')
    expect(shortRef(SHA)).toBe('abcdef1')
  })

  it('游客与 Member 看不到管理入口；社区插件带徽标与来源链接；不可用的灰显写原因', async () => {
    const { session } = mockApi('Member')
    const user = userEvent.setup()
    render(<Market session={session} />)
    const broken = await screen.findByRole('article', { name: 'Excel 工具箱' })
    expect(broken).toHaveClass('is-off')
    expect(within(broken).getByText(/暂不可用：缺少 Python 包：openpyxl/)).toBeInTheDocument()
    expect(within(broken).getByRole('button', { name: '加入工具箱：Excel 工具箱' })).toBeDisabled()
    // 第十五轮：社区插件与官方插件同列，靠徽标和「来源」筛选区分；来源链接在详情里
    const community = screen.getByRole('article', { name: '回声测试' })
    expect(within(community).getByText('社区')).toBeInTheDocument()
    await user.click(within(screen.getByRole('group', { name: '按来源' })).getByRole('button', { name: '社区' }))
    expect(screen.queryByRole('article', { name: '待办清单' })).toBeNull()
    await user.click(within(screen.getByRole('article', { name: '回声测试' })).getByRole('link', { name: '回声测试' }))
    const detail = await screen.findByRole('dialog', { name: '插件详情：回声测试' })
    expect(within(detail).getByRole('link', { name: /源代码 @abcdef1/ })).toHaveAttribute('href', expect.stringContaining('github.com/acme/echo'))
    expect(screen.queryByRole('button', { name: '导入插件' })).toBeNull()
    expect(screen.queryByRole('button', { name: '管理插件' })).toBeNull()
    expect(screen.queryByRole('button', { name: /示例插件源/ })).toBeNull()
  })

  it('Owner：导入插件 → 信任预览（权限、依赖、来源 commit、隐私政策）→ 确认安装', async () => {
    const { calls, session } = mockApi('Owner')
    const user = userEvent.setup()
    render(<Market session={session} />)
    await user.click(await screen.findByRole('button', { name: '导入插件' }))
    const dialog = await screen.findByRole('dialog', { name: '插件管理' })
    await user.type(within(dialog).getByRole('textbox'), 'https://github.com/acme/skills/tree/main/polite')
    await user.click(within(dialog).getByRole('button', { name: '预览' }))
    const card = await within(dialog).findByRole('region', { name: '安装预览：礼貌回复' })
    expect(card).toHaveTextContent('v1.2.0')
    expect(card).toHaveTextContent('作者 某作者')
    expect(card).toHaveTextContent('MIT')
    expect(card).toHaveTextContent('@abcdef1')
    expect(card).toHaveTextContent('在独立子进程里运行插件自带的 Python 代码')
    expect(card).toHaveTextContent('openpyxl（缺失）')
    expect(within(card).getByRole('link', { name: '隐私政策' })).toHaveAttribute('href', 'https://example.com/privacy')
    expect(card).toHaveTextContent('第三方代码将在服务器上运行')
    expect(calls.find(c => c.path === '/api/plugins/import/preview').body).toEqual({ url: 'https://github.com/acme/skills/tree/main/polite' })
    await user.click(within(card).getByRole('button', { name: '确认安装' }))
    expect(await within(dialog).findByText(/「礼貌回复」装好了/)).toBeInTheDocument()
    expect(calls.find(c => c.path === '/api/plugins/import/confirm').body).toEqual({ token: 'tok-123456789' })
    await waitFor(() => expect(calls.filter(c => c.path === '/api/market/catalog').length).toBeGreaterThan(1))
  })

  it('Owner：下载失败时提示「下载 zip 后上传」的退路', async () => {
    const { session } = mockApi('Owner', {
      'POST /api/plugins/import/preview': () => json({ error: '连不上仓库网站', code: 'DOWNLOAD_FAILED',
        hint: '可以在自己电脑上打开仓库页面 → Code → Download ZIP，再点「上传 zip」导入。' }, 502),
    })
    const user = userEvent.setup()
    render(<Market session={session} />)
    await user.click(await screen.findByRole('button', { name: '导入插件' }))
    const dialog = await screen.findByRole('dialog', { name: '插件管理' })
    await user.type(within(dialog).getByRole('textbox'), 'https://github.com/acme/x')
    await user.click(within(dialog).getByRole('button', { name: '预览' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('连不上仓库网站')
    expect(alert).toHaveTextContent('Download ZIP')
  })

  it('Owner：已装插件可停用、卸载；插件源成为市场页签，逐个预览安装', async () => {
    const { calls, session } = mockApi('Owner')
    const user = userEvent.setup()
    vi.stubGlobal('confirm', () => true)
    render(<Market session={session} />)
    // 插件源成为「来源」筛选里的一项（与官方 / 社区并列）
    const tab = await screen.findByRole('button', { name: '示例插件源' })
    const sourceGroup = screen.getByRole('group', { name: '按来源' })
    expect(within(sourceGroup).getByRole('button', { name: '官方' })).toBeInTheDocument()
    expect(within(sourceGroup).getByRole('button', { name: '社区' })).toBeInTheDocument()
    await user.click(tab)
    await user.click(await screen.findByRole('button', { name: '预览安装：节日祝福语' }))
    expect(await screen.findByRole('region', { name: '安装预览：节日祝福语' })).toBeInTheDocument()
    expect(calls.some(c => c.path === '/api/plugins/sources/jarvis_examples/preview' && c.body.name === 'festival-greetings')).toBe(true)
    await user.click(screen.getByRole('button', { name: '取消' }))
    const dialog = screen.getByRole('dialog', { name: '插件管理' })
    await user.click(within(dialog).getByRole('tab', { name: '已装' }))
    const row = (await within(dialog).findByText(/回声测试/)).closest('li')
    await user.click(within(row).getByRole('button', { name: '停用' }))
    expect(await within(dialog).findByText('已停用「回声测试」')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: '卸载' }))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/api/plugins/echo_tool')).toBe(true))
    await user.click(within(dialog).getByRole('tab', { name: '插件源' }))
    expect(within(dialog).getByText('npm 包需要 Node 环境')).toBeInTheDocument()
  })
})
