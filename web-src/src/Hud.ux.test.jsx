import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const THREADS = [
  { id: 'a', title: '深圳天气', updated: '2026-08-14 09:00' },
  { id: 'b', title: '写周报', updated: '2026-08-14 08:00' },
]

vi.mock('./Chat.jsx', () => ({
  default: ({ threadId, fresh }) => <section aria-label="chat" data-thread={threadId} data-fresh={String(Boolean(fresh))} />,
}))
vi.mock('./Panels.jsx', () => ({ default: () => <div aria-label="panels"><button type="button">面板里的按钮</button></div> }))
vi.mock('./Threads.jsx', () => ({
  default: function ThreadsMock({ onLoaded, onNew }) {
    useEffect(() => { onLoaded?.(THREADS) }, [])
    return <nav aria-label="threads"><button type="button" onClick={onNew}>新对话</button></nav>
  },
}))

import Hud from './Hud.jsx'

const OWNER = { username: 'owner', role: 'Owner' }
function setWidth(value) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value })
}

describe('HUD 交互细节', () => {
  let store
  beforeEach(() => {
    setWidth(1440)
    store = new Map([['jws_thread', 'a']])
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(k => (store.has(k) ? store.get(k) : null)),
      setItem: vi.fn((k, v) => store.set(k, String(v))),
      removeItem: vi.fn(k => store.delete(k)),
    })
    global.fetch = vi.fn().mockResolvedValue({ status: 503, ok: false, json: async () => ({ error: '离线' }) })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setWidth(1024)
  })

  it('「新对话」建的是本地新会话：标 fresh 交给对话区（不去拉不存在的历史）', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    const chat = screen.getByLabelText('chat')
    expect(chat).toHaveAttribute('data-thread', 'a')
    expect(chat).toHaveAttribute('data-fresh', 'false')
    await user.click(screen.getByRole('button', { name: '新对话' }))
    expect(chat.getAttribute('data-thread')).toMatch(/^t-/)
    expect(chat).toHaveAttribute('data-fresh', 'true')
  })

  it('今日浮层：打开后焦点移入浮层，Esc 关闭后回到「今日」按钮', async () => {
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    const btn = screen.getByRole('button', { name: '今日' })
    await user.click(btn)
    expect(document.getElementById('jv-today').contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    expect(document.getElementById('jv-today')).not.toHaveClass('open')
    expect(document.activeElement).toBe(btn)
  })

  it('手机会话抽屉：打开后焦点移入抽屉，Esc 关闭后回到开关按钮', async () => {
    setWidth(390)
    const user = userEvent.setup()
    render(<Hud session={OWNER} onLogout={() => {}} />)
    const toggle = screen.getByRole('button', { name: '展开会话栏' })
    await user.click(toggle)
    expect(document.getElementById('jv-sidebar').contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开会话栏' }))
  })
})
