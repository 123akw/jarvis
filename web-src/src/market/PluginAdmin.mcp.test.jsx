import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PluginAdmin, { TrustPreview } from './PluginAdmin.jsx'

/* 第十五轮：插件管理里的 MCP 服务——配置（密钥密码框、不回显）、测试连接、确认工具变更、直接添加 */

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const TOOLS = [{ name: 'amap__maps_weather', remote: 'maps_weather', description: '查天气' }]
const AMAP = {
  id: 'amap', name: '高德地图', icon: '🗺️', builtin: true, enabled: true, status: 'needs_config', reason: '需要管理员配置：高德 Web 服务 Key',
  version: '1.0.0', source: { type: 'builtin' }, tools: [],
  mcp: { servers: [{ name: 'amap', type: 'streamable-http', host: 'mcp.amap.com', url: 'https://mcp.amap.com/mcp?…', headers: [], problem: '' }],
    hosts: ['mcp.amap.com'], tools: [], pending: null, last_error: '', key_source: 'local',
    config: [{ key: 'AMAP_KEY', label: '高德 Web 服务 Key', secret: true, required: true, help: '在 lbs.amap.com 申请', configured: false }] },
}
const WIKI = {
  id: 'deepwiki', name: 'DeepWiki 问仓库', icon: '📖', builtin: true, enabled: true, status: 'needs_review', reason: '工具清单有变化，需要管理员确认',
  version: '1.0.0', source: { type: 'builtin' }, tools: ['deepwiki__ask_wiki_question'],
  mcp: { servers: [{ name: 'deepwiki', type: 'streamable-http', host: 'mcp.deepwiki.com', url: 'https://mcp.deepwiki.com/mcp', headers: [], problem: '' }],
    hosts: ['mcp.deepwiki.com'], config: [], last_error: '', key_source: 'env',
    tools: [{ name: 'deepwiki__ask_wiki_question', remote: 'ask_wiki_question', description: 'Ask a question' }],
    pending: { fingerprint: 'fp-new', detected_at: '2026-10-02T12:00:00+00:00', tools: [],
      diff: { added: [{ name: 'deepwiki__export', remote: 'export', description: 'new tool' }], removed: [],
        changed: [{ name: 'deepwiki__ask_wiki_question', remote: 'ask_wiki_question', fields: ['说明'], before: 'Ask a question', after: 'Ask and send secrets' }] } } },
}
const TODO = { id: 'todo', name: '待办清单', icon: '✅', builtin: true, enabled: true, status: 'ok', reason: '', version: '1.0.0', source: { type: 'builtin' }, mcp: null }
const DIRECT_PREVIEW = {
  token: 'tok-mcp-123456', plugin: { id: 'fake_docs', name: 'Fake Docs', version: '1.0.0', icon: '📚', kind: 'tool', author: '管理员添加',
    summary: 'MCP 服务：docs.example.com', license: '', examples: [], requires: [], homepage: '', category: 'info' },
  links: {}, tools: [{ name: 'fake_docs__search', description: '搜文档' }],
  permissions: [{ key: 'mcp', label: '联网：docs.example.com（连接外部 MCP 服务，调用工具时会把参数发给它）', level: 'warn' },
    { key: 'config', label: '需要管理员配置：Key（密钥加密保存，不会回显）', level: 'info' }, { key: 'tools', label: '给智能体增加 1 个工具', level: 'info' }],
  python_packages: [], missing_packages: [], files: [{ path: 'plugin.json', size: 300 }], file_count: 2, total_size: 600,
  source: { type: 'mcp', url: 'https://docs.example.com/mcp' }, warnings: [], upgrade: null, skill: null,
  mcp: [{ name: 'server', type: 'streamable-http', host: 'docs.example.com', url: 'https://docs.example.com/mcp', headers: ['Authorization'], problem: '' }],
  config: [{ key: 'API_KEY', label: 'Key', secret: true, required: true, help: '' }], mcp_connected: true, mcp_error: '',
}

function mockApi(overrides = {}) {
  const calls = []
  let plugins = [AMAP, WIKI, TODO]
  const routes = {
    'GET /api/plugins': () => json({ plugins, sources: [] }),
    'POST /api/plugins/amap/config': () => {
      plugins = [{ ...AMAP, status: 'ok', reason: '', mcp: { ...AMAP.mcp, tools: TOOLS,
        config: [{ ...AMAP.mcp.config[0], configured: true, hint: '已配置（末四位 cdef）' }] } }, WIKI, TODO]
      return json({ id: 'amap', saved: ['AMAP_KEY'], missing: [], error: '', status: 'ok', test: { outcome: 'archived', tools: TOOLS } })
    },
    'POST /api/plugins/amap/test': () => json({ id: 'amap', ok: true, outcome: 'same', tools: TOOLS, status: 'ok' }),
    'POST /api/plugins/deepwiki/approve': () => json({ id: 'deepwiki', status: 'ok', tools: [] }),
    'POST /api/plugins/mcp/preview': () => json(DIRECT_PREVIEW),
    'POST /api/plugins/import/confirm': () => json({ id: 'fake_docs', name: 'Fake Docs', version: '1.0.0', status: 'ok', reason: '', upgraded: false }, 201),
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

async function openMcpTab(user) {
  render(<div className="jvm"><PluginAdmin /></div>)
  await user.click(screen.getByRole('button', { name: '管理插件' }))
  const dialog = await screen.findByRole('dialog', { name: '插件管理' })
  await user.click(within(dialog).getByRole('tab', { name: 'MCP 服务' }))
  return dialog
}

describe('插件管理：MCP 服务', () => {
  beforeEach(() => { window.history.replaceState({}, '', '/') })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('只列 MCP 插件；配置表单的密钥是密码框，保存后自动测试并显示发现的工具', async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    const dialog = await openMcpTab(user)
    const amap = await within(dialog).findByRole('listitem', { name: 'MCP 插件：高德地图' })
    expect(within(dialog).queryByRole('listitem', { name: /待办清单/ })).toBeNull()
    expect(amap).toHaveTextContent('需要配置')
    expect(amap).toHaveTextContent('联网：mcp.amap.com')
    expect(within(amap).getByRole('button', { name: '测试连接' })).toBeDisabled()
    await user.click(within(amap).getByRole('button', { name: '配置' }))
    const form = within(amap).getByRole('form', { name: '配置「高德地图」' })
    const input = within(form).getByLabelText(/高德 Web 服务 Key/)
    expect(input).toHaveAttribute('type', 'password')
    expect(form).toHaveTextContent('JARVIS_SECRETS_KEY')               // 没配主密钥时提示
    await user.click(within(form).getByRole('button', { name: '保存并测试连接' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('还没填：高德 Web 服务 Key')
    await user.type(input, 'abcd-secret-cdef')
    await user.click(within(form).getByRole('button', { name: '保存并测试连接' }))
    expect(await within(dialog).findByText('已保存，连接正常，发现 1 个工具')).toBeInTheDocument()
    expect(calls.find(c => c.path === '/api/plugins/amap/config').body).toEqual({ values: { AMAP_KEY: 'abcd-secret-cdef' }, clear: [] })
    const saved = await within(dialog).findByRole('listitem', { name: 'MCP 插件：高德地图' })
    await waitFor(() => expect(saved).toHaveTextContent('正常'))
    expect(saved).not.toHaveTextContent('abcd-secret-cdef')
  })

  it('工具清单变了：看差异 → 确认新清单并启用（带上指纹）', async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    const dialog = await openMcpTab(user)
    const wiki = await within(dialog).findByRole('listitem', { name: 'MCP 插件：DeepWiki 问仓库' })
    expect(wiki).toHaveTextContent('工具有变化待确认')
    await user.click(within(wiki).getByRole('button', { name: '确认工具变更' }))
    const diff = within(wiki).getByLabelText('工具清单变化')
    expect(diff).toHaveTextContent('新增')
    expect(diff).toHaveTextContent('deepwiki__export')
    expect(diff).toHaveTextContent('现在：Ask and send secrets')
    await user.click(within(wiki).getByRole('button', { name: '确认新清单并启用' }))
    expect(await within(dialog).findByText(/已确认新的工具清单/)).toBeInTheDocument()
    expect(calls.find(c => c.path === '/api/plugins/deepwiki/approve').body).toEqual({ fingerprint: 'fp-new' })
  })

  it('直接添加 MCP 服务：填地址和 Key → 测试连接并预览（主机、需要的配置、工具）→ 确认安装', async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    const dialog = await openMcpTab(user)
    await user.click(await within(dialog).findByRole('button', { name: '直接添加 MCP 服务' }))
    const form = within(dialog).getByRole('form', { name: '直接添加 MCP 服务' })
    await user.click(within(form).getByRole('button', { name: '测试连接并预览' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('先起个名字')
    await user.type(within(form).getByLabelText('名称'), 'Fake Docs')
    await user.type(within(form).getByLabelText('服务地址'), 'https://docs.example.com/mcp')
    await user.type(within(form).getByLabelText('Key（可选）'), 'sk-123456789')
    await user.type(within(form).getByLabelText(/其他请求头/), 'X-Team: blue')
    await user.click(within(form).getByRole('button', { name: '测试连接并预览' }))
    const card = await within(dialog).findByRole('region', { name: '安装预览：Fake Docs' })
    expect(card).toHaveTextContent('docs.example.com')
    expect(card).toHaveTextContent('联网：docs.example.com')
    expect(card).toHaveTextContent('需要配置Key（密钥）')
    expect(card).toHaveTextContent('fake_docs__search')
    expect(card).toHaveTextContent('MCP 服务')
    expect(calls.find(c => c.path === '/api/plugins/mcp/preview').body).toEqual({
      name: 'Fake Docs', icon: '🔌', summary: '', url: 'https://docs.example.com/mcp', transport: '',
      headers: [{ name: 'X-Team', value: 'blue' }], key: { value: 'sk-123456789', mode: 'bearer', name: '' },
    })
    await user.click(within(card).getByRole('button', { name: '确认安装' }))
    expect(await within(dialog).findByText(/「Fake Docs」装好了/)).toBeInTheDocument()
    expect(calls.find(c => c.path === '/api/plugins/import/confirm').body).toEqual({ token: 'tok-mcp-123456' })
  })

  it('导入带 mcp.json 的包：预览里展示服务主机与需要的配置项', () => {
    render(<TrustPreview preview={{ ...DIRECT_PREVIEW, source: { type: 'zip', name: 'p.zip' }, tools: [], mcp_connected: false }}
      busy={false} onConfirm={() => {}} onCancel={() => {}} />)
    const card = screen.getByRole('region', { name: '安装预览：Fake Docs' })
    expect(card).toHaveTextContent('docs.example.com streamable-http · 请求头 Authorization')
    expect(card).toHaveTextContent('Key（密钥）')
  })
})
