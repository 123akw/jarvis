import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getSession: vi.fn(), login: vi.fn(), logout: vi.fn(async () => {}) }))
// 主界面替身：显示当前账号和它「上次打开的会话」（真实的按账号存储），以及登出
vi.mock('./Hud.jsx', async () => {
  const { readAccount, ACCOUNT_KEYS } = await import('./accountStorage.js')
  return {
    default: ({ session, onLogout }) => (
      <div>
        <span data-testid="hud">{session.username}·{readAccount(ACCOUNT_KEYS.thread, session.username) || 'web'}</span>
        <button type="button" onClick={() => onLogout()}>登出</button>
      </div>
    ),
  }
})

import { getSession, login } from './api.js'
import { accountKey, currentAccount } from './accountStorage.js'
import App from './App.jsx'
import { receiptsOn, setReceipts } from './memoryPrefs.js'

function memoryStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: k => { m.delete(k) },
    clear: () => m.clear(),
    keys: () => [...m.keys()],
  }
}

const ADMIN = { authed: true, username: 'admin', role: 'Owner', csrf_token: 'c1' }
const NEWBIE = { authed: true, username: 'jvnew01', role: 'Member', csrf_token: 'c2' }

function openAt(path) {
  window.history.replaceState({}, '', path)
}

describe('扫码带来的 ?u= 与当前登录账号不一致', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('sessionStorage', memoryStorage())
    getSession.mockReset()
    login.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    openAt('/')
  })

  it('不直接进主界面：显示登录页、预填新账号、说明当前登录的是谁', async () => {
    openAt('/login?u=jvnew01')
    getSession.mockResolvedValue(ADMIN)
    render(<App />)
    expect(await screen.findByText('这台设备当前登录的是「admin」，要切换到「jvnew01」请输入口令')).toBeInTheDocument()
    expect(screen.getByLabelText('用户名')).toHaveValue('jvnew01')
    expect(screen.queryByTestId('hud')).toBeNull()
    expect(screen.getByRole('button', { name: '继续使用 admin' })).toBeInTheDocument()
  })

  it('旧二维码 /?u= 落到 /login?u=，同样先确认换号', async () => {
    openAt('/?u=jvnew01')
    getSession.mockResolvedValue(ADMIN)
    render(<App />)
    expect(window.location.pathname + window.location.search).toBe('/login?u=jvnew01')
    expect(await screen.findByText('这台设备当前登录的是「admin」，要切换到「jvnew01」请输入口令')).toBeInTheDocument()
  })

  it('「继续使用 admin」去掉 ?u= 进主界面', async () => {
    openAt('/login?u=jvnew01')
    getSession.mockResolvedValue(ADMIN)
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: '继续使用 admin' }))
    expect(screen.getByTestId('hud')).toHaveTextContent('admin')
    expect(window.location.pathname + window.location.search).toBe('/app')
  })

  it('新账号登录成功即替换会话：进的是新账号、看不到上个账号的会话', async () => {
    openAt('/login?u=jvnew01')
    localStorage.setItem('jws_thread', 't-admin1')      // 上一版不分账号的旧键：admin 写的
    getSession.mockResolvedValue(ADMIN)
    login.mockResolvedValue(NEWBIE)
    const user = userEvent.setup()
    render(<App />)
    await user.type(await screen.findByLabelText('口令'), 'Pass-word-123')
    await user.click(screen.getByRole('button', { name: /接入系统/ }))
    expect(login).toHaveBeenCalledWith('jvnew01', 'Pass-word-123')
    await waitFor(() => expect(screen.getByTestId('hud')).toHaveTextContent('jvnew01·web'), { timeout: 3000 })
    expect(window.location.pathname + window.location.search).toBe('/app')
    // 旧键迁到了 admin 名下，新账号没有继承
    expect(localStorage.getItem('jws_thread')).toBeNull()
    expect(localStorage.getItem('jws_thread:admin')).toBe('t-admin1')
    expect(currentAccount()).toBe('jvnew01')
  })

  it('?u= 就是当前账号（不分大小写）：直接进，并清掉 ?u=', async () => {
    openAt('/login?u=Admin')
    getSession.mockResolvedValue(ADMIN)
    render(<App />)
    expect(await screen.findByTestId('hud')).toHaveTextContent('admin')
    expect(screen.queryByText(/这台设备当前登录的是/)).toBeNull()
    expect(window.location.pathname + window.location.search).toBe('/app')
  })

  it('没登录时 ?u= 照旧只预填；旧版不分账号的本地数据无从判断归属，直接丢掉', async () => {
    openAt('/login?u=jvnew01')
    localStorage.setItem('jws_thread', 't-someone')
    localStorage.setItem('jws_brief_hide', '2026-10-01')
    localStorage.setItem('jws_theme', 'light')            // 界面偏好共用，不动
    getSession.mockResolvedValue({ authed: false })
    render(<App />)
    expect(await screen.findByLabelText('用户名')).toHaveValue('jvnew01')
    expect(screen.queryByText(/这台设备当前登录的是/)).toBeNull()
    expect(localStorage.getItem('jws_thread')).toBeNull()
    expect(localStorage.getItem('jws_brief_hide')).toBeNull()
    expect(localStorage.getItem('jws_theme')).toBe('light')
  })

  it('登出再换号登录：上个账号的会话、记忆回执开关都不残留', async () => {
    openAt('/app')
    localStorage.setItem(accountKey('jws_thread', 'admin'), 't-admin1')
    getSession.mockResolvedValue(ADMIN)
    login.mockResolvedValue(NEWBIE)
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByTestId('hud')).toHaveTextContent('admin·t-admin1')
    setReceipts(false)                                     // admin 关掉了记忆回执
    await user.click(screen.getByRole('button', { name: '登出' }))
    expect(window.location.pathname + window.location.search).toBe('/login')
    await user.type(await screen.findByLabelText('用户名'), 'jvnew01')
    await user.type(screen.getByLabelText('口令'), 'Pass-word-123')
    await user.click(screen.getByRole('button', { name: /接入系统/ }))
    await waitFor(() => expect(screen.getByTestId('hud')).toHaveTextContent('jvnew01·web'), { timeout: 3000 })
    await waitFor(() => expect(receiptsOn()).toBe(true))  // 回到缺省，等本账号从服务端同步
    expect(localStorage.getItem(accountKey('jws_thread', 'admin'))).toBe('t-admin1')   // admin 下次回来还在
  })
})
