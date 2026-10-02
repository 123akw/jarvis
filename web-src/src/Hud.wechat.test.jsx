import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const THREADS = [
  { id: 'a', title: '深圳天气', updated: '2026-08-14 09:00' },
  { id: 'b', title: '写周报', updated: '2026-08-14 08:00' },
]

vi.mock('./Chat.jsx', () => ({ default: ({ threadId }) => <section aria-label="chat" data-thread={threadId} /> }))
vi.mock('./Panels.jsx', () => ({ default: () => <div aria-label="panels" /> }))
vi.mock('./Threads.jsx', () => ({
  default: function ThreadsMock({ onLoaded }) {
    useEffect(() => { onLoaded?.(THREADS) }, [])
    return <nav aria-label="threads" />
  },
}))

import Hud from './Hud.jsx'

const OWNER = { username: 'owner', role: 'Owner' }

function setWidth(value) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value })
}

async function openAccountMenu(user) {
  await user.click(screen.getByRole('button', { name: '账户与设置' }))
  return screen.getByRole('menu', { name: '账户与设置' })
}

describe('HUD personal WeChat entry', () => {
  beforeEach(() => {
    setWidth(1440)
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ state: 'idle', qr_uri: '', error: '', since: '' }),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setWidth(1024)
  })

  it('opens an accessible personal WeChat dialog from the account menu', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)

    const menu = await openAccountMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: '接入个人微信' }))

    expect(await screen.findByRole('dialog', { name: '接入个人微信' }))
      .toBeInTheDocument()
  })

  it('keeps a long Member account entry available on a narrow screen and hides WeChat', async () => {
    setWidth(390)
    const user = userEvent.setup()
    const longName = 'very-long-member-name-that-must-not-push-controls-away'
    render(<Hud session={{ username: longName, role: 'Member' }} onLogout={() => {}} />)
    expect(screen.getByRole('button', { name: '账户与设置' })).toBeVisible()
    const menu = await openAccountMenu(user)
    expect(within(menu).getByText(longName)).toBeVisible()
    expect(within(menu).getByRole('menuitem', { name: /账户设置/ })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: '接入个人微信' })).toBeNull()
    expect(screen.queryByRole('button', { name: '接入个人微信' })).toBeNull()
  })

  it('returns to login even if logout fails', async () => {
    global.fetch.mockRejectedValueOnce(new Error('offline'))
    const onLogout = vi.fn()
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={onLogout} />)
    const menu = await openAccountMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: '退出登录' }))
    await vi.waitFor(() => expect(onLogout).toHaveBeenCalledOnce())
  })
})

describe('HUD 布局：顶栏减负后入口仍全部可达', () => {
  beforeEach(() => {
    setWidth(1440)
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
    // 后端不可用：各面板走自己的错误分支，只验证布局与入口
    global.fetch = vi.fn().mockResolvedValue({ status: 503, ok: false, json: async () => ({ error: '离线' }) })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setWidth(1024)
  })

  it('头像菜单收纳账户、记忆、设置、微信、悬浮窗、主题与退出', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    const menu = await openAccountMenu(user)
    const names = within(menu).getAllByRole('menuitem').map(el => el.textContent)
    for (const label of ['账户设置', '记忆与人设', '设置中心', '接入个人微信', '桌面悬浮窗', '切换到亮色', '退出登录']) {
      expect(names.some(n => n.includes(label))).toBe(true)
    }
    await user.click(within(menu).getByRole('menuitem', { name: /记忆与人设/ }))
    expect(await screen.findByRole('dialog', { name: '记忆与人设' })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()   // 选完自动收起菜单
  })

  it('头像菜单的设置中心与账户设置都以统一模态打开，Esc 关闭', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    await user.click(within(await openAccountMenu(user)).getByRole('menuitem', { name: /账户设置/ }))
    expect(screen.getByRole('dialog', { name: '账户设置' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '账户设置' })).toBeNull()
    await user.click(within(await openAccountMenu(user)).getByRole('menuitem', { name: /设置中心/ }))
    expect(screen.getByRole('dialog', { name: '设置中心' })).toBeInTheDocument()
  })

  it('会话栏可折叠，桌面端记住偏好', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    const sidebar = document.getElementById('jv-sidebar')
    const collapse = screen.getByRole('button', { name: '收起会话栏' })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    expect(sidebar).toHaveClass('open')
    await user.click(collapse)
    expect(sidebar).not.toHaveClass('open')
    expect(sidebar).toHaveAttribute('inert')
    expect(localStorage.setItem).toHaveBeenCalledWith('jws_sidebar', '0')
    await user.click(screen.getByRole('button', { name: '展开会话栏' }))
    expect(sidebar).toHaveClass('open')
    expect(localStorage.setItem).toHaveBeenCalledWith('jws_sidebar', '1')
  })

  it('手机宽度下会话栏默认收起为抽屉，点遮罩关闭', async () => {
    setWidth(390)
    const user = userEvent.setup()
    const { container } = render(<Hud session={OWNER} onLogout={() => {}} />)
    const sidebar = document.getElementById('jv-sidebar')
    expect(container.querySelector('.hud')).toHaveClass('mode-narrow')
    expect(sidebar).not.toHaveClass('open')
    await user.click(screen.getByRole('button', { name: '展开会话栏' }))
    expect(sidebar).toHaveClass('open')
    await user.click(container.querySelector('.drawer-backdrop'))
    expect(sidebar).not.toHaveClass('open')
    expect(localStorage.setItem).not.toHaveBeenCalledWith('jws_sidebar', expect.anything())  // 抽屉开合不写偏好
  })

  it('今日板：常规宽度默认收起，按钮开合；超宽屏默认常驻', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    const today = screen.getByRole('button', { name: '今日' })
    expect(today).toHaveAttribute('aria-expanded', 'false')
    await user.click(today)
    expect(today).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('jv-today')).toHaveClass('open')
    await user.click(screen.getByRole('button', { name: '收起今日' }))
    expect(today).toHaveAttribute('aria-expanded', 'false')
    cleanup()

    setWidth(1920)
    render(<Hud session={OWNER} onLogout={() => {}} />)
    expect(screen.getByRole('button', { name: '今日' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('⌘K 打开命令面板，输入过滤后回车执行', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const palette = screen.getByRole('dialog', { name: '命令面板' })
    const input = within(palette).getByRole('combobox', { name: '搜索命令' })
    expect(input).toHaveFocus()
    await user.type(input, '微信')
    const options = within(palette).getAllByRole('option')
    expect(options[0]).toHaveTextContent('接入个人微信')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull()
    expect(await screen.findByRole('dialog', { name: '接入个人微信' })).toBeInTheDocument()
  })

  it('命令面板可按标题跳转会话，顶栏标题随之更新；Esc 关闭', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    await user.click(screen.getByRole('button', { name: '命令面板' }))
    await user.type(screen.getByRole('combobox', { name: '搜索命令' }), '周报')
    await user.click(screen.getByRole('option', { name: /写周报/ }))
    expect(screen.getByLabelText('chat')).toHaveAttribute('data-thread', 'b')
    expect(document.querySelector('.tb-title')).toHaveTextContent('写周报')
    expect(localStorage.setItem).toHaveBeenCalledWith('jws_thread', 'b')

    await user.click(screen.getByRole('button', { name: '命令面板' }))
    await user.keyboard('{ArrowDown}{Escape}')
    expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull()
  })

  it('Member 的命令面板里没有微信入口，但新对话等操作都在', async () => {
    const user = userEvent.setup()
    render(<Hud session={{ username: 'm', role: 'Member' }} onLogout={() => {}} />)
    await user.click(screen.getByRole('button', { name: '命令面板' }))
    const labels = screen.getAllByRole('option').map(el => el.textContent)
    expect(labels.some(t => t.includes('接入个人微信'))).toBe(false)
    for (const label of ['新对话', '收起会话栏', '打开今日', '记忆与人设', '设置中心', '桌面悬浮窗', '退出登录']) {
      expect(labels.some(t => t.includes(label))).toBe(true)
    }
  })
})
