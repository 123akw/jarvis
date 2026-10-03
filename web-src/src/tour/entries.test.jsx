import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* 第十八轮·新手引导的入口与锚点：市场（游客「怎么用」、头像菜单）、主应用（头像菜单、⌘K 两项、自动开始）、
 * 账户设置「重置所有新手引导」；市场与主应用的 data-tour 锚点都在。 */

// 主应用：对话区换成只带输入框锚点的桩；今日板的桩把仪表盘数据交出去（app 引导的 ready）
vi.mock('../Chat.jsx', () => ({ default: () => <section aria-label="chat"><div data-tour="app-input">输入框</div></section> }))
let panelData = null
vi.mock('../Panels.jsx', () => ({
  default: function PanelsMock({ onData }) {
    useEffect(() => { if (panelData) onData?.(panelData) }, [onData])
    return <div aria-label="panels" />
  },
}))
vi.mock('../Threads.jsx', () => ({
  default: function ThreadsMock({ onLoaded }) {
    useEffect(() => { onLoaded?.([]) }, [])
    return <nav aria-label="threads" />
  },
}))

import { setCurrentAccount } from '../accountStorage.js'
import AccountSettings from '../AccountSettings.jsx'
import Hud from '../Hud.jsx'
import Market from '../market/Market.jsx'
import { _resetController } from './controller.js'
import { TourLayer } from './index.jsx'
import { _resetStoreCache, LOCAL_KEY } from './store.js'

function memoryStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: k => { m.delete(k) }, clear: () => m.clear() }
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

const P = (id, name, icon, category) => ({
  id, name, icon, category, summary: `${name}的一句话`, kind: 'tool', tools: [], step: null, requires: [], tier: 'free', price: 0,
  professions: [], examples: [], available: true, builtin: true, status: 'ok', reason: '', version: '1.0.0', author: 'JWS-Agent',
  homepage: '', source: { type: 'builtin' }, license: 'MIT-0',
})
const CATALOG = {
  categories: [{ id: 'efficiency', name: '效率' }, { id: 'life', name: '生活' }],
  plugins: [P('todo', '待办清单', '✅', 'efficiency'), P('memo', '随手记', '📝', 'efficiency'), P('weather', '查天气', '🌤️', 'life')],
  professions: [{ id: 'student', name: '学生', icon: '🎒', summary: '', plugins: ['todo'], flows: [], home: {} }],
  signup: 'open',
}

let calls
let seen
function mockApi(overrides = {}) {
  calls = []
  seen = {}
  const routes = {
    'GET /api/market/catalog': () => json(CATALOG),
    'GET /api/plugins': () => json({ plugins: [], sources: [] }),
    'GET /api/onboarding': () => json({ seen }),
    'PUT /api/onboarding': body => {
      if (body.reset) seen = {}
      else seen = { ...seen, [body.tour]: { status: body.status, at: 'now' } }
      return json({ ok: true, seen })
    },
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
}
const onboardingCalls = method => calls.filter(c => c.path === '/api/onboarding' && c.method === method)
const tourTitle = () => screen.queryByRole('dialog', { name: /./ })?.querySelector('.jv-tour-title')?.textContent
const tourDialog = () => document.querySelector('.jv-tour [role="dialog"]')

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  window.history.replaceState({}, '', '/')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  panelData = null
  setCurrentAccount('')
  _resetController()
  _resetStoreCache()
})
afterEach(() => {
  cleanup()
  _resetController()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
})

describe('市场', () => {
  it('四个锚点都在（第一张卡只有一张带锚点）；游客第一次来自动开始，只用本机记录', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<><Market session={false} /><TourLayer /></>)
    await screen.findByRole('article', { name: '待办清单' })
    expect(document.querySelector('[data-tour="market-search"]')).toContainElement(screen.getByRole('searchbox', { name: '搜索插件' }))
    const cards = document.querySelectorAll('[data-tour="market-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toHaveAttribute('aria-label', '待办清单')       // 目录里的第一张
    expect(document.querySelector('[data-tour="market-dock"]')).toHaveClass('jvm-tray')
    expect(document.querySelector('[data-tour="market-next"]')).toHaveTextContent('下一步')
    await waitFor(() => expect(tourTitle()).toBe('先搜一搜'))
    await user.click(within(tourDialog()).getByRole('button', { name: '跳过' }))
    expect(JSON.parse(localStorage.getItem(LOCAL_KEY)).market.status).toBe('skipped')
    expect(onboardingCalls('GET')).toHaveLength(0)
    expect(onboardingCalls('PUT')).toHaveLength(0)
  })

  it('首屏「怎么用」随时重看（游客也能点）', async () => {
    mockApi()
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ market: { status: 'done', at: 'x' } }))
    const user = userEvent.setup()
    render(<><Market session={false} /><TourLayer /></>)
    await screen.findByRole('article', { name: '待办清单' })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(tourDialog()).toBeNull()                                    // 看过了：不自动出现
    await user.click(screen.getByRole('button', { name: '怎么用' }))
    await waitFor(() => expect(tourTitle()).toBe('先搜一搜'))
  })

  it('已登录：头像菜单「新手引导」重看；看过没走接口', async () => {
    mockApi()
    setCurrentAccount('amy')
    const user = userEvent.setup()
    render(<><Market session={{ authed: true, username: 'amy', role: 'Member' }} /><TourLayer /></>)
    await screen.findByRole('article', { name: '待办清单' })
    await waitFor(() => expect(tourTitle()).toBe('先搜一搜'))
    expect(onboardingCalls('GET')).toHaveLength(1)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(onboardingCalls('PUT')[0]?.body).toEqual({ tour: 'market', status: 'skipped' }))
    await user.click(screen.getByRole('button', { name: '账号：amy' }))
    await user.click(screen.getByRole('menuitem', { name: '新手引导' }))
    await waitFor(() => expect(tourTitle()).toBe('先搜一搜'))
  })

  it('详情打开时不自动开始', async () => {
    mockApi()
    window.history.replaceState({}, '', '/?plugin=todo')
    render(<><Market session={false} /><TourLayer /></>)
    await screen.findByRole('dialog', { name: /待办清单/ })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(tourDialog()).toBeNull()
  })
})

describe('主应用', () => {
  const OWNER = { username: 'owner', role: 'Owner' }

  it('锚点：输入框、⌘K、今日、头像菜单都在', () => {
    mockApi()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    expect(document.querySelector('[data-tour="app-input"]')).not.toBeNull()
    expect(document.querySelector('[data-tour="app-cmdk"]')).toBe(screen.getByRole('button', { name: '命令面板' }))
    expect(document.querySelector('[data-tour="app-today"]')).toBe(screen.getByRole('button', { name: '今日' }))
    expect(document.querySelector('[data-tour="app-menu"]')).toBe(screen.getByRole('button', { name: '账户与设置' }))
  })

  it('仪表盘就绪后第一次自动开始，看完记 done', async () => {
    mockApi()
    setCurrentAccount('owner')
    panelData = { todos: [], memos: [], schedule: [], place: '', model: '' }
    const user = userEvent.setup()
    render(<><Hud session={OWNER} onLogout={() => {}} /><TourLayer /></>)
    await waitFor(() => expect(tourTitle()).toBe('有事直接说'))
    for (let i = 0; i < 3; i++) await user.click(within(tourDialog()).getByRole('button', { name: '下一步' }))
    expect(tourTitle()).toBe('右上角菜单')
    await user.click(within(tourDialog()).getByRole('button', { name: '完成' }))
    await waitFor(() => expect(onboardingCalls('PUT')[0]?.body).toEqual({ tour: 'app', status: 'done' }))
  })

  it('仪表盘没就绪时不自动开始；头像菜单「新手引导」重看本页', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<><Hud session={OWNER} onLogout={() => {}} /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(tourDialog()).toBeNull()
    await user.click(screen.getByRole('button', { name: '账户与设置' }))
    const item = screen.getByRole('menuitem', { name: /新手引导/ })
    expect(item).toHaveTextContent('重看本页')
    await user.click(item)
    await waitFor(() => expect(tourTitle()).toBe('有事直接说'))
  })

  it('⌘K：「新手引导：重看本页」开始引导；「重置所有新手引导」清记录并提示', async () => {
    mockApi()
    setCurrentAccount('owner')
    const user = userEvent.setup()
    render(<><Hud session={OWNER} onLogout={() => {}} /><TourLayer /></>)
    await user.click(screen.getByRole('button', { name: '命令面板' }))
    await user.click(screen.getByRole('option', { name: /新手引导：重看本页/ }))
    await waitFor(() => expect(tourTitle()).toBe('有事直接说'))
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '命令面板' }))
    await user.click(screen.getByRole('option', { name: /重置所有新手引导/ }))
    await waitFor(() => expect(onboardingCalls('PUT').at(-1)?.body).toEqual({ reset: true }))
    expect(await screen.findByText('已重置，各页面的新手引导会重新出现一次')).toBeInTheDocument()
  })
})

describe('账户设置', () => {
  it('「重置所有新手引导」调接口并说明结果；接口失败也说清楚', async () => {
    mockApi()
    setCurrentAccount('owner')
    localStorage.setItem(`${LOCAL_KEY}:owner`, JSON.stringify({ app: { status: 'done', at: 'x' } }))
    const user = userEvent.setup()
    const { unmount } = render(<AccountSettings session={{ username: 'owner', role: 'Member' }} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: '重置所有新手引导' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已重置')
    expect(onboardingCalls('PUT')[0].body).toEqual({ reset: true })
    expect(localStorage.getItem(`${LOCAL_KEY}:owner`)).toBeNull()
    unmount()

    mockApi({ 'PUT /api/onboarding': () => json({ error: '离线' }, 503) })
    render(<AccountSettings session={{ username: 'owner', role: 'Member' }} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: '重置所有新手引导' }))
    expect(await screen.findByRole('status')).toHaveTextContent('同步到账号没成功')
  })
})
