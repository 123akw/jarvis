import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../Chat.jsx', () => ({
  default: ({ home }) => (
    <section aria-label="chat" data-platform={home?.platform?.name || ''}
      data-flows={Array.isArray(home?.flows) ? String(home.flows.length) : 'none'}
      data-plugins={home?.plugins ? Object.keys(home.plugins).join(',') : ''} />
  ),
}))
vi.mock('../Panels.jsx', () => ({ default: () => <div aria-label="panels" /> }))
vi.mock('../Threads.jsx', () => ({ default: () => <nav aria-label="threads" /> }))

import Hud from '../Hud.jsx'
import PlatformEntry from './PlatformEntry.jsx'
import PlatformHome from './PlatformHome.jsx'
import PlatformSettings from './PlatformSettings.jsx'
import ShareSheet from './ShareSheet.jsx'
import {
  accentTokens, contrast, homeChips, homeGreeting, PLATFORM_ACCENTS, platformLink,
} from './platform.js'

const PLATFORM = {
  id: 'pf1', slug: 'xw-pm', name: '小王的项目台', tagline: '项目资料、待办、飞书汇总', icon: '📋', accent: '#30B0C7',
  profession: 'project_manager', plugins: ['schedule', 'todo', 'feishu', 'split_file'],
  url: 'https://jarvis.example.cn/p/xw-pm', home: { greeting: '今天项目推进到哪了？', chips: ['本周进度怎么样？'] },
}
const PLUGINS = [
  { id: 'schedule', name: '日程助手', icon: '📅', kind: 'tool', summary: '到点提醒你', examples: ['明天下午3点和客户开会'] },
  { id: 'todo', name: '待办清单', icon: '✅', kind: 'tool', summary: '', examples: ['加个待办：周五交周报'] },
  { id: 'feishu', name: '飞书', icon: '🪶', kind: 'channel', summary: '', examples: [] },
  { id: 'split_file', name: '文件拆分', icon: '✂️', kind: 'step', summary: '', examples: [] },
]
const FLOWS = [{ id: 'f1', name: '项目资料归档', steps: [{ id: 's1', plugin: 'input_file' }, { id: 's2', plugin: 'split_file' }] }]
const byId = Object.fromEntries(PLUGINS.map(p => [p.id, p]))

/** 按「方法 路径」路由的 fetch 假实现；值是 [status, body] 或 (init) => [status, body] */
function routeFetch(table) {
  global.fetch = vi.fn(async (url, init = {}) => {
    const key = `${(init.method || 'GET').toUpperCase()} ${String(url).split('?')[0]}`
    const hit = table[key]
    const [status, body] = hit ? (typeof hit === 'function' ? hit(init) : hit) : [404, { error: '没有这个接口' }]
    return { ok: status < 400, status, json: async () => body }
  })
  return global.fetch
}

function setWidth(value) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value })
}

const headHref = rel => document.head.querySelector(`link[rel="${rel}"]`)?.getAttribute('href')
const headMeta = name => document.head.querySelector(`meta[name="${name}"]`)?.getAttribute('content')

beforeEach(() => {
  setWidth(1440)
  const store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(k => (store.has(k) ? store.get(k) : null)),
    setItem: vi.fn((k, v) => store.set(k, String(v))),
    removeItem: vi.fn(k => store.delete(k)),
  })
  window.history.replaceState({}, '', '/')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setWidth(1024)
  window.history.replaceState({}, '', '/')
})

describe('平台工具函数', () => {
  it('主题色派生：亮色主题下压暗到浅底上 ≥3:1；按钮字色随底色选黑白', () => {
    for (const { hex } of PLATFORM_ACCENTS) {
      const t = accentTokens(hex)
      expect(t.dark).toBe(hex)
      expect(contrast(t.light, '#F5F5F7')).toBeGreaterThanOrEqual(3)
      expect(t.orb).toHaveLength(4)
    }
    expect(accentTokens('#0A84FF').darkOn).toBe('#FFFFFF')
    expect(accentTokens('#FF9F0A').darkOn).not.toBe('#FFFFFF')   // 橙底白字看不清，换深色字
    expect(accentTokens('坏值').dark).toBe('#0A84FF')            // 非法色值回落默认蓝
  })

  it('快捷问题：优先用服务端按智能体生成的 home.chips（按 chip_plugins 配图标），不足再用插件示例补，流程积木不出题', () => {
    const chips = homeChips(PLATFORM, byId)
    expect(chips.map(c => c.text)).toEqual(['本周进度怎么样？', '明天下午3点和客户开会', '加个待办：周五交周报'])
    expect(chips[0]).toMatchObject({ hint: '', icon: '' })                // 旧接口的纯文字 chips：用智能体图标
    expect(chips[1]).toMatchObject({ icon: '📅', hint: '日程助手' })
    expect(homeChips({ plugins: ['weather'] }, null)[0].text).toBe('今天天气怎么样？')   // 目录拿不到用兜底表
    const study = {
      plugins: ['todo', 'schedule', 'search', 'recall'],
      home: {
        greeting: '今天想先搞定哪门课？', source: 'model',
        chips: ['帮我查下这道题的解题思路', '记一下，晚上要写完作业', '提醒我明天早上背单词', '上次聊的复习方法再说一遍'],
        chip_plugins: ['search', 'todo', 'schedule', 'recall'],
      },
    }
    const got = homeChips(study, byId)
    expect(got.map(c => c.text)).toEqual(study.home.chips)               // 4 条都用生成的，插件示例一条不混进来
    expect(got[2]).toMatchObject({ icon: '📅', hint: '日程助手' })
    expect(got[0]).toMatchObject({ icon: '🔎' })                          // 目录里没有的用兜底表的图标
    const short = homeChips({ ...study, home: { ...study.home, chips: study.home.chips.slice(0, 2) } }, byId)
    expect(short.map(c => c.text)).toEqual([...study.home.chips.slice(0, 2), '加个待办：周五交周报', '明天下午3点和客户开会'])
  })

  it('问候与链接：职业 greeting 优先，否则按平台名生成；链接优先用接口给的绝对地址', () => {
    expect(homeGreeting(PLATFORM)).toBe('今天项目推进到哪了？')
    expect(homeGreeting({ name: '奶茶小铺' }, new Date(2026, 9, 2, 9))).toBe('早上好，欢迎回到奶茶小铺')
    expect(platformLink(PLATFORM)).toBe('https://jarvis.example.cn/p/xw-pm')
    expect(platformLink({ slug: 'abc' })).toBe(`${window.location.origin}/p/abc`)
  })
})

describe('平台主页（新对话空态）', () => {
  it('平台问候、插件快捷问题、工具箱（不含积木）与我的流程；点击跳市场 / 流程', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<PlatformHome platform={PLATFORM} plugins={byId} flows={FLOWS} onPick={onPick} />)
    expect(screen.getByRole('heading', { name: '今天项目推进到哪了？' })).toBeInTheDocument()
    expect(screen.getByText('项目资料、待办、飞书汇总')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /明天下午3点和客户开会/ }))
    expect(onPick).toHaveBeenCalledWith('明天下午3点和客户开会')

    const box = screen.getByRole('region', { name: '我的工具箱' })
    expect(within(box).getByRole('img', { name: '日程助手' })).toBeInTheDocument()
    expect(within(box).getByRole('img', { name: '飞书' })).toBeInTheDocument()
    expect(within(box).queryByRole('img', { name: '文件拆分' })).toBeNull()
    await user.click(within(box).getByRole('button', { name: '添加插件' }))
    expect(window.location.pathname).toBe('/')

    const flows = screen.getByRole('region', { name: '我的流程' })
    await user.click(within(flows).getByRole('button', { name: /项目资料归档/ }))
    expect(window.location.pathname).toBe('/flows')
  })

  it('按智能体生成的问候与快捷问题优先：学习助手不出现别的职业的示例', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const study = {
      ...PLATFORM, name: '学习助手', tagline: '搜索学习资料', profession: 'student', plugins: ['todo', 'schedule', 'search', 'recall'],
      home: {
        greeting: '今天要查什么资料，还是要安排复习？', source: 'model',
        chips: ['帮我查下这道题的解题思路', '记一下，晚上要写完作业', '提醒我明天早上背单词', '上次聊的复习方法再说一遍'],
        chip_plugins: ['search', 'todo', 'schedule', 'recall'],
      },
    }
    const { container } = render(<PlatformHome platform={study} plugins={byId} flows={[]} onPick={onPick} />)
    expect(screen.getByRole('heading', { name: '今天要查什么资料，还是要安排复习？' })).toBeInTheDocument()
    expect([...container.querySelectorAll('.ce-q')].map(n => n.textContent)).toEqual(study.home.chips)
    expect(container.textContent).not.toMatch(/火锅|奶茶|王姐|客户开会/)
    await user.click(screen.getByRole('button', { name: /提醒我明天早上背单词/ }))
    expect(onPick).toHaveBeenCalledWith('提醒我明天早上背单词')
  })

  it('流程接口失败（flows=null）时不显示「我的流程」；没有流程时给「拼一个流程」', () => {
    const { rerender } = render(<PlatformHome platform={PLATFORM} flows={null} onPick={() => {}} />)
    expect(screen.queryByRole('region', { name: '我的流程' })).toBeNull()
    rerender(<PlatformHome platform={PLATFORM} flows={[]} onPick={() => {}} />)
    expect(screen.getByRole('button', { name: /拼一个流程/ })).toBeInTheDocument()
  })
})

describe('主应用按平台定制', () => {
  afterEach(() => { document.body.className = ''; document.body.removeAttribute('style') })

  it('有平台：顶栏换平台名、主题色生效、注入 manifest；菜单有分享 / 平台设置与「由贾维斯驱动」', async () => {
    routeFetch({
      'GET /api/platform': [200, { platform: PLATFORM }],
      'GET /api/market/catalog': [200, { plugins: PLUGINS }],
      'GET /api/flows': [200, { flows: FLOWS }],
    })
    const user = userEvent.setup()
    render(<Hud session={{ username: 'xiaowang', role: 'Member' }} onLogout={() => {}} />)
    expect(await screen.findByTitle('小王的项目台')).toBeInTheDocument()
    expect(document.querySelector('.jv-topbar .wordmark')).toBeNull()
    await waitFor(() => expect(screen.getByLabelText('chat')).toHaveAttribute('data-flows', '1'))
    expect(screen.getByLabelText('chat')).toHaveAttribute('data-platform', '小王的项目台')
    expect(screen.getByLabelText('chat').getAttribute('data-plugins')).toContain('schedule')

    expect(document.body).toHaveClass('jv-pf')
    expect(document.body.style.getPropertyValue('--pf-accent-d')).toBe('#30B0C7')
    expect(contrast(document.body.style.getPropertyValue('--pf-accent-l'), '#F5F5F7')).toBeGreaterThanOrEqual(3)
    expect(headHref('manifest')).toBe('/p/xw-pm/manifest.webmanifest')
    expect(headHref('apple-touch-icon')).toBe('/p/xw-pm/icon-192.png')
    expect(headMeta('apple-mobile-web-app-title')).toBe('小王的项目台')
    expect(headMeta('theme-color')).toMatch(/^#[0-9A-F]{6}$/)
    expect(document.title).toBe('小王的项目台')

    await user.click(screen.getByRole('button', { name: '账户与设置' }))
    const menu = screen.getByRole('menu')
    const names = within(menu).getAllByRole('menuitem').map(el => el.textContent)
    for (const label of ['智能体市场', '我的流程', '分享我的智能体', '智能体设置']) {
      expect(names.some(n => n.includes(label))).toBe(true)
    }
    expect(within(menu).getByText('由贾维斯驱动')).toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: /分享我的智能体/ }))
    expect(await screen.findByRole('dialog', { name: '分享我的智能体' })).toBeInTheDocument()
  })

  it('⌘K「智能体设置」：换色实时预览，保存后顶栏跟着变；取消则撤销预览', async () => {
    routeFetch({
      'GET /api/platform': [200, { platform: PLATFORM }],
      'PUT /api/platform': init => [200, { platform: { ...PLATFORM, ...JSON.parse(init.body) } }],
    })
    const user = userEvent.setup()
    render(<Hud session={{ username: 'xiaowang', role: 'Member' }} onLogout={() => {}} />)
    await screen.findByTitle('小王的项目台')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await user.type(screen.getByRole('combobox', { name: '搜索命令' }), '智能体设置')
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: '智能体设置' })
    await user.click(within(dialog).getByRole('radio', { name: '玫红' }))
    expect(document.body.style.getPropertyValue('--pf-accent-d')).toBe('#FF375F')   // 预览
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(document.body.style.getPropertyValue('--pf-accent-d')).toBe('#30B0C7')   // 撤销预览

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await user.type(screen.getByRole('combobox', { name: '搜索命令' }), '智能体设置')
    await user.keyboard('{Enter}')
    const again = await screen.findByRole('dialog', { name: '智能体设置' })
    const name = within(again).getByRole('textbox', { name: /名称/ })
    await user.clear(name)
    await user.type(name, '项目指挥部')
    await user.click(within(again).getByRole('radio', { name: '薄荷绿' }))
    await user.click(within(again).getByRole('button', { name: '保存' }))
    expect(await screen.findByTitle('项目指挥部')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '智能体设置' })).toBeNull()
    expect(document.body.style.getPropertyValue('--pf-accent-d')).toBe('#34C759')
  })

  it('卸载后还原：主题色、manifest、标题都撤掉', async () => {
    routeFetch({ 'GET /api/platform': [200, { platform: PLATFORM }] })
    document.title = '贾维斯'
    const { unmount } = render(<Hud session={{ username: 'xiaowang', role: 'Member' }} onLogout={() => {}} />)
    await screen.findByTitle('小王的项目台')
    unmount()
    expect(document.body).not.toHaveClass('jv-pf')
    expect(document.body.style.getPropertyValue('--pf-accent-d')).toBe('')
    expect(headHref('manifest')).toBeUndefined()
    expect(document.title).toBe('贾维斯')
  })

  it('没有平台（接口 404 也算）：保持贾维斯原样，只多市场 / 流程入口；⌘K 回车跳转', async () => {
    routeFetch({})
    const user = userEvent.setup()
    render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={() => {}} />)
    await act(async () => {})
    expect(document.querySelector('.jv-topbar .wordmark')).toHaveTextContent('J.A.R.V.I.S.')
    expect(document.body).not.toHaveClass('jv-pf')
    expect(headHref('manifest')).toBeUndefined()
    expect(screen.getByLabelText('chat')).toHaveAttribute('data-platform', '')

    await user.click(screen.getByRole('button', { name: '账户与设置' }))
    const names = within(screen.getByRole('menu')).getAllByRole('menuitem').map(el => el.textContent)
    expect(names.some(n => n.includes('智能体市场'))).toBe(true)
    expect(names.some(n => n.includes('我的流程'))).toBe(true)
    expect(names.some(n => n.includes('分享我的智能体') || n.includes('智能体设置'))).toBe(false)
    expect(screen.queryByText('由贾维斯驱动')).toBeNull()
    await user.click(screen.getByRole('menuitem', { name: /我的流程/ }))
    expect(window.location.pathname).toBe('/flows')

    window.history.replaceState({}, '', '/')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await user.type(screen.getByRole('combobox', { name: '搜索命令' }), '市场')
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('智能体市场')
    await user.keyboard('{Enter}')
    expect(window.location.pathname).toBe('/')
  })
})

describe('分享我的智能体', () => {
  it('二维码编码平台链接，一键复制，有系统分享时可调起', async () => {
    const writeText = vi.fn(async () => {})
    const share = vi.fn(async () => {})
    const user = userEvent.setup()   // 先 setup：user-event 会换掉 navigator.clipboard，这里再盖回自己的
    vi.stubGlobal('navigator', { ...window.navigator, userAgent: 'iPhone', clipboard: { writeText }, share })
    render(<ShareSheet platform={PLATFORM} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: '分享我的智能体' })
    expect(within(dialog).getByRole('img', { name: '「小王的项目台」的二维码' }).querySelector('path')).toBeTruthy()
    expect(within(dialog).getByText('https://jarvis.example.cn/p/xw-pm')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /复制链接/ }))
    expect(writeText).toHaveBeenCalledWith('https://jarvis.example.cn/p/xw-pm')
    expect(await within(dialog).findByRole('button', { name: /已复制/ })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /发给朋友/ }))
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://jarvis.example.cn/p/xw-pm', title: '小王的项目台' }))
    // 装到主屏指引：iPhone 默认，可切安卓
    expect(within(dialog).getByText('添加到主屏幕', { exact: false })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('tab', { name: '安卓' }))
    expect(within(dialog).getByText('安装应用')).toBeInTheDocument()
  })

  it('没有 navigator.share 时不显示系统分享按钮', () => {
    vi.stubGlobal('navigator', { ...window.navigator, share: undefined })
    render(<ShareSheet platform={PLATFORM} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: /发给朋友/ })).toBeNull()
  })
})

describe('智能体设置', () => {
  it('改名、换图标与主题色（实时预览）、移除插件后 PUT /api/platform', async () => {
    let sent = null
    const fetchMock = routeFetch({
      'PUT /api/platform': init => { sent = JSON.parse(init.body); return [200, { platform: { ...PLATFORM, ...sent } }] },
    })
    const onSaved = vi.fn()
    const onPreview = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<PlatformSettings platform={PLATFORM} plugins={byId} onSaved={onSaved} onPreview={onPreview} onClose={onClose} />)
    const name = screen.getByRole('textbox', { name: /名称/ })
    await user.clear(name)
    await user.type(name, '项目指挥部')
    await user.click(screen.getByRole('radio', { name: '图标 🎯' }))
    await user.click(screen.getByRole('radio', { name: '琥珀橙' }))
    expect(onPreview).toHaveBeenLastCalledWith({ name: '项目指挥部', icon: '🎯', accent: '#FF9F0A' })
    await user.click(screen.getByRole('button', { name: '移除 飞书' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls.find(([u, i]) => u === '/api/platform' && i?.method === 'PUT')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(sent).toEqual({
      name: '项目指挥部', tagline: '项目资料、待办、飞书汇总', icon: '🎯', accent: '#FF9F0A',
      plugins: ['schedule', 'todo', 'split_file'],
    })
    expect(onSaved.mock.calls[0][0]).toMatchObject({ name: '项目指挥部', accent: '#FF9F0A' })
    expect(onClose).toHaveBeenCalled()
  })

  it('名称为空不提交；接口报错就地提示', async () => {
    routeFetch({ 'PUT /api/platform': [422, { error: '主题色只能从预设里选' }] })
    const user = userEvent.setup()
    render(<PlatformSettings platform={PLATFORM} onClose={() => {}} />)
    await user.clear(screen.getByRole('textbox', { name: /名称/ }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('alert')).toHaveTextContent('给智能体起个名字吧')
    expect(global.fetch).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox', { name: /名称/ }), '新名字')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('主题色只能从预设里选')
  })

  it('「添加更多」去市场', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<PlatformSettings platform={PLATFORM} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: /添加更多/ }))
    expect(onClose).toHaveBeenCalled()
    expect(window.location.pathname).toBe('/')
  })
})

describe('/p/<slug> 平台入口', () => {
  const BRAND = { slug: 'xw-pm', name: '小王的项目台', tagline: '项目资料、待办、飞书汇总', icon: '📋', accent: '#30B0C7' }
  afterEach(() => { document.body.className = ''; document.body.removeAttribute('style') })

  it('品牌化登录页：平台名 / 介绍 / 主题色，?u= 预填用户名，并声明成可装到主屏的 App', async () => {
    window.history.replaceState({}, '', '/p/xw-pm?u=xiaowang')
    routeFetch({ 'GET /api/p/xw-pm': [200, BRAND] })
    render(<PlatformEntry slug="xw-pm" session={false} onAuthed={() => {}} />)
    expect(await screen.findByText('小王的项目台')).toBeInTheDocument()
    expect(screen.getByText('项目资料、待办、飞书汇总')).toBeInTheDocument()
    expect(screen.getByText('由贾维斯驱动')).toBeInTheDocument()
    expect(screen.getByText('身份验证')).toBeInTheDocument()
    expect(screen.getByLabelText('用户名')).toHaveValue('xiaowang')
    expect(screen.getByLabelText('口令')).toHaveFocus()
    expect(screen.queryByText(/MOSS/)).toBeNull()
    expect(document.body).toHaveClass('jv-pf')
    expect(headHref('manifest')).toBe('/p/xw-pm/manifest.webmanifest')
    expect(headHref('apple-touch-icon')).toBe('/p/xw-pm/icon-192.png')
    expect(headMeta('apple-mobile-web-app-capable')).toBe('yes')
    expect(headMeta('apple-mobile-web-app-title')).toBe('小王的项目台')
    expect(headMeta('theme-color')).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('登录成功：onAuthed 拿到会话并回到主应用；失败就地提示', async () => {
    window.history.replaceState({}, '', '/p/xw-pm')
    let ok = false
    routeFetch({
      'GET /api/p/xw-pm': [200, BRAND],
      'POST /api/login': () => (ok ? [200, { ok: true }] : [401, {}]),
      'GET /api/session': [200, { authed: true, username: 'xiaowang', role: 'Member', csrf_token: 't' }],
    })
    const onAuthed = vi.fn()
    const user = userEvent.setup()
    render(<PlatformEntry slug="xw-pm" session={false} onAuthed={onAuthed} />)
    await user.type(await screen.findByLabelText('用户名'), 'xiaowang')
    await user.type(screen.getByLabelText('口令'), 'wrong')
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('用户名或口令不对，再试一次')).toBeInTheDocument()
    expect(onAuthed).not.toHaveBeenCalled()

    ok = true
    await user.type(screen.getByLabelText('口令'), 'right-pass')
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(onAuthed).toHaveBeenCalledWith(expect.objectContaining({ username: 'xiaowang' })))
    expect(window.location.pathname).toBe('/app')
  })

  it('已登录：直接「进入我的平台」', async () => {
    window.history.replaceState({}, '', '/p/xw-pm')
    routeFetch({ 'GET /api/p/xw-pm': [200, BRAND] })
    const user = userEvent.setup()
    render(<PlatformEntry slug="xw-pm" session={{ username: 'xiaowang' }} onAuthed={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '进入我的智能体' }))
    expect(window.location.pathname).toBe('/app')
  })

  it('?u= 与已登录账号不一致：给登录卡并说明当前登录的是谁，可「继续使用」当前账号', async () => {
    window.history.replaceState({}, '', '/p/xw-pm?u=xiaowang')
    routeFetch({ 'GET /api/p/xw-pm': [200, BRAND] })
    const user = userEvent.setup()
    render(<PlatformEntry slug="xw-pm" session={{ username: 'admin' }} onAuthed={() => {}} />)
    expect(await screen.findByText('这台设备当前登录的是「admin」，要切换到「xiaowang」请输入口令')).toBeInTheDocument()
    expect(screen.getByLabelText('用户名')).toHaveValue('xiaowang')
    expect(screen.queryByRole('button', { name: '进入我的智能体' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '继续使用 admin' }))
    expect(screen.getByRole('button', { name: '进入我的智能体' })).toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('平台不存在：友好的 404，可去市场；不注入 manifest', async () => {
    routeFetch({})
    const user = userEvent.setup()
    render(<PlatformEntry slug="nobody" session={false} onAuthed={() => {}} />)
    expect(await screen.findByRole('heading', { name: '没有找到这个智能体' })).toBeInTheDocument()
    expect(headHref('manifest')).toBeUndefined()
    expect(screen.queryByLabelText('口令')).toBeNull()
    await user.click(screen.getByRole('button', { name: '去智能体市场' }))
    expect(window.location.pathname).toBe('/')
    await user.click(screen.getByRole('button', { name: '进入我的智能体' }))
    expect(window.location.pathname).toBe('/app')
  })

  it('网络出错：可重试，也可回首页（市场）', async () => {
    window.history.replaceState({}, '', '/p/xw-pm')
    routeFetch({ 'GET /api/p/xw-pm': [500, {}] })
    const user = userEvent.setup()
    render(<PlatformEntry slug="xw-pm" session={false} onAuthed={() => {}} />)
    expect(await screen.findByRole('heading', { name: '暂时打不开' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '回到首页' }))
    expect(window.location.pathname).toBe('/')
  })

  it('底部「装到手机主屏」打开图文指引', async () => {
    routeFetch({ 'GET /api/p/xw-pm': [200, BRAND] })
    const user = userEvent.setup()
    render(<PlatformEntry slug="xw-pm" session={false} onAuthed={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /装到手机主屏/ }))
    const dialog = screen.getByRole('dialog', { name: '装到手机主屏' })
    expect(within(dialog).getByRole('tab', { name: 'iPhone' })).toBeInTheDocument()
  })
})
