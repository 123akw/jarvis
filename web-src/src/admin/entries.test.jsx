import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* 管理后台入口：主应用头像菜单与 ⌘K、市场头像菜单，都只有 Owner 看得到；有未读告警时带上提示 / 小红点 */

vi.mock('../Chat.jsx', () => ({ default: () => <section aria-label="chat" /> }))
vi.mock('../Panels.jsx', () => ({ default: () => <div aria-label="panels" /> }))
vi.mock('../Threads.jsx', () => ({ default: () => <nav aria-label="threads" /> }))

import Hud from '../Hud.jsx'
import { AccountArea } from '../market/TopBar.jsx'

const OWNER = { username: 'owner', role: 'Owner' }
const MEMBER = { username: 'amy', role: 'Member' }

let calls
function stubFetch(unread) {
  calls = []
  global.fetch = vi.fn(async url => {
    calls.push(String(url))
    if (String(url).startsWith('/api/admin/alerts')) {
      return unread === null
        ? { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
        : { ok: true, status: 200, json: async () => ({ alerts: [], unread }) }
    }
    return { ok: false, status: 503, json: async () => ({ error: '离线' }) }
  })
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  window.history.replaceState({}, '', '/app')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
})

async function openMenu(user) {
  await user.click(screen.getByRole('button', { name: '账户与设置' }))
  return screen.getByRole('menu', { name: '账户与设置' })
}

describe('主应用入口', () => {
  it('Owner：头像菜单有「管理后台」，带未读告警数；点了去 /admin', async () => {
    stubFetch(3)
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    await waitFor(() => expect(calls).toContain('/api/admin/alerts?limit=1'))
    const menu = await openMenu(user)
    const item = await within(menu).findByRole('menuitem', { name: /管理后台.*3 条未读告警/ })
    await user.click(item)
    expect(window.location.pathname).toBe('/admin')
  })

  it('Owner：⌘K 里也能搜到；告警接口不可用时入口照常、没有未读提示', async () => {
    stubFetch(null)
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const box = screen.getByRole('dialog', { name: '命令面板' })
    await user.type(within(box).getByRole('combobox'), '配额')
    const option = within(box).getByRole('option', { name: /管理后台/ })
    expect(option).toHaveTextContent('用量 · 配额 · 告警')
    await user.click(option)
    expect(window.location.pathname).toBe('/admin')
  })

  it('普通账号：菜单与 ⌘K 都没有「管理后台」，也不去取告警', async () => {
    stubFetch(5)
    const user = userEvent.setup()
    render(<Hud session={MEMBER} onLogout={() => {}} />)
    const menu = await openMenu(user)
    expect(within(menu).queryByRole('menuitem', { name: /管理后台/ })).toBeNull()
    await user.keyboard('{Escape}')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const box = screen.getByRole('dialog', { name: '命令面板' })
    await user.type(within(box).getByRole('combobox'), '管理后台')
    expect(within(box).queryByRole('option', { name: /^管理后台/ })).toBeNull()
    expect(calls.some(u => u.startsWith('/api/admin/alerts'))).toBe(false)
  })
})

describe('市场入口', () => {
  const area = me => <AccountArea me={me} checking={false} onEnter={() => {}} onFlows={() => {}} onAdmin={() => {}} onLogout={() => {}} />

  it('Owner：头像菜单有「管理后台」，有未读告警时带小红点；点了去 /admin', async () => {
    stubFetch(2)
    window.history.replaceState({}, '', '/')
    const user = userEvent.setup()
    render(area({ username: 'boss', role: 'Owner' }))
    await waitFor(() => expect(calls).toContain('/api/admin/alerts?limit=1'))
    await user.click(screen.getByRole('button', { name: '账号：boss' }))
    const item = await screen.findByRole('menuitem', { name: '管理后台（2 条未读告警）' })
    expect(within(item).getByTitle('2 条未读告警')).toBeInTheDocument()
    await user.click(item)
    expect(window.location.pathname).toBe('/admin')
  })

  it('Owner 没有未读：只有「管理后台」四个字', async () => {
    stubFetch(0)
    const user = userEvent.setup()
    render(area({ username: 'boss', role: 'Owner' }))
    await user.click(screen.getByRole('button', { name: '账号：boss' }))
    expect(screen.getByRole('menuitem', { name: '管理后台' })).toHaveTextContent(/^管理后台$/)
  })

  it('普通账号：没有「管理后台」', async () => {
    stubFetch(2)
    const user = userEvent.setup()
    render(area({ username: 'amy', role: 'Member' }))
    await user.click(screen.getByRole('button', { name: '账号：amy' }))
    expect(screen.queryByRole('menuitem', { name: /管理后台/ })).toBeNull()
    expect(calls.some(u => u.startsWith('/api/admin/alerts'))).toBe(false)
  })
})
