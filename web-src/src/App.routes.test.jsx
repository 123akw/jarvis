import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getSession: vi.fn(), login: vi.fn(), logout: vi.fn(async () => {}) }))
// 各页面替身：只显示自己是谁、拿到的会话，以及会触发跳转的按钮
vi.mock('./Hud.jsx', () => ({
  default: ({ session, onLogout }) => (
    <div>
      <span data-testid="page">app·{session.username}</span>
      <button type="button" onClick={() => onLogout()}>登出</button>
      <button type="button" onClick={() => onLogout('expired')}>401</button>
    </div>
  ),
}))
vi.mock('./market/Market.jsx', () => ({
  default: ({ session }) => <span data-testid="page">market·{session === null ? 'checking' : session ? session.username : 'guest'}</span>,
}))
vi.mock('./flows/Flows.jsx', () => ({
  default: ({ session, onExpired }) => (
    <div>
      <span data-testid="page">flows·{session.username}</span>
      <button type="button" onClick={onExpired}>会话过期</button>
    </div>
  ),
}))

import { getSession, login } from './api.js'
import App from './App.jsx'

const ADMIN = { authed: true, username: 'admin', role: 'Owner', csrf_token: 'c1' }
const where = () => window.location.pathname + window.location.search
const openAt = path => window.history.replaceState({}, '', path)
const page = async () => (await screen.findByTestId('page')).textContent

async function signIn(user, name = 'admin') {
  await user.type(await screen.findByLabelText('用户名'), name)
  await user.type(screen.getByLabelText('口令'), 'Pass-word-123')
  await user.click(screen.getByRole('button', { name: /接入系统/ }))
}

describe('第十五轮路由：/ 市场、/login 登录、/app 主应用', () => {
  beforeEach(() => {
    getSession.mockReset()
    login.mockReset()
  })
  afterEach(() => {
    cleanup()
    openAt('/')
  })

  it('/ 是市场：没登录也能看，已登录也照样是市场', async () => {
    openAt('/')
    getSession.mockResolvedValue({ authed: false })
    render(<App />)
    await waitFor(async () => expect(await page()).toBe('market·guest'))
    expect(document.title).toBe('贾维斯 · 智能体市场')
    cleanup()
    getSession.mockResolvedValue(ADMIN)
    render(<App />)
    await waitFor(async () => expect(await page()).toBe('market·admin'))
    expect(where()).toBe('/')
  })

  it('/market 旧链接原地换成 /（查询参数保留）', async () => {
    openAt('/market?tab=official')
    getSession.mockResolvedValue({ authed: false })
    render(<App />)
    expect(await page()).toMatch(/^market/)
    expect(where()).toBe('/?tab=official')
  })

  it('没登录访问 /app、/flows：去 /login 并带上 next', async () => {
    getSession.mockResolvedValue({ authed: false })
    for (const path of ['/app', '/flows']) {
      openAt(path)
      render(<App />)
      expect(await screen.findByLabelText('用户名')).toBeInTheDocument()
      expect(window.location.pathname).toBe('/login')
      expect(new URLSearchParams(window.location.search).get('next')).toBe(path)
      expect(document.title).toBe('登录 · 贾维斯')
      cleanup()
    }
  })

  it('登录成功按 next 回到原来要去的页面', async () => {
    openAt('/flows')
    getSession.mockResolvedValue({ authed: false })
    login.mockResolvedValue(ADMIN)
    const user = userEvent.setup()
    render(<App />)
    await signIn(user)
    await waitFor(async () => expect(await page()).toBe('flows·admin'), { timeout: 3000 })
    expect(where()).toBe('/flows')
  })

  it('没有 next 时登录成功进 /app', async () => {
    openAt('/login')
    getSession.mockResolvedValue({ authed: false })
    login.mockResolvedValue(ADMIN)
    const user = userEvent.setup()
    render(<App />)
    await signIn(user)
    await waitFor(async () => expect(await page()).toBe('app·admin'), { timeout: 3000 })
    expect(where()).toBe('/app')
    expect(document.title).toBe('J.A.R.V.I.S. · 私人管家')
  })

  it('站外 next 一律不认，登录后进 /app', async () => {
    for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/login']) {
      openAt(`/login?next=${encodeURIComponent(next)}`)
      getSession.mockResolvedValue({ authed: false })
      login.mockResolvedValue(ADMIN)
      const user = userEvent.setup()
      render(<App />)
      await signIn(user)
      await waitFor(async () => expect(await page()).toBe('app·admin'), { timeout: 3000 })
      expect(where()).toBe('/app')
      cleanup()
    }
  })

  it('已登录打开 /login（没有 ?u= 冲突）：直接去 next 或 /app', async () => {
    getSession.mockResolvedValue(ADMIN)
    openAt('/login')
    render(<App />)
    expect(await page()).toBe('app·admin')
    expect(where()).toBe('/app')
    cleanup()
    openAt('/login?next=%2Fflows')
    render(<App />)
    expect(await page()).toBe('flows·admin')
    expect(where()).toBe('/flows')
    cleanup()
    openAt('/login?next=%2F')
    render(<App />)
    await waitFor(async () => expect(await page()).toBe('market·admin'))
    expect(where()).toBe('/')
  })

  it('登出、401、流程页会话过期：都回 /login（不带 next）', async () => {
    getSession.mockResolvedValue(ADMIN)
    const user = userEvent.setup()
    for (const [path, button] of [['/app', '登出'], ['/app', '401'], ['/flows', '会话过期']]) {
      openAt(path)
      render(<App />)
      await user.click(await screen.findByRole('button', { name: button }))
      expect(await screen.findByLabelText('用户名')).toBeInTheDocument()
      expect(where()).toBe('/login')
      cleanup()
    }
  })

  it('未知路径回首页', async () => {
    openAt('/nope/really')
    getSession.mockResolvedValue({ authed: false })
    render(<App />)
    expect(await page()).toMatch(/^market/)
    expect(where()).toBe('/')
  })
})
