import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./Chat.jsx', () => ({ default: () => <section aria-label="chat" /> }))
vi.mock('./Panels.jsx', () => ({ default: () => <aside aria-label="panels" /> }))
vi.mock('./Threads.jsx', () => ({ default: () => <nav aria-label="threads" /> }))
vi.mock('./Moss.jsx', () => ({ MossMini: () => <div aria-label="moss" /> }))

import Hud from './Hud.jsx'

describe('HUD personal WeChat entry', () => {
  beforeEach(() => {
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
  })

  it('opens an accessible personal WeChat dialog from the header', async () => {
    const user = userEvent.setup()
    render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={() => {}} />)

    await user.click(screen.getByRole('button', { name: '接入个人微信' }))

    expect(await screen.findByRole('dialog', { name: '接入个人微信' }))
      .toBeInTheDocument()
  })

  it('keeps a long Member account entry available on a narrow screen and hides WeChat', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    render(<Hud session={{ username: 'very-long-member-name-that-must-not-push-controls-away', role: 'Member' }} onLogout={() => {}} />)
    expect(screen.getByRole('button', { name: '账户设置' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '接入个人微信' })).toBeNull()
  })

  it('returns to login even if logout fails', async () => {
    global.fetch.mockRejectedValueOnce(new Error('offline'))
    const onLogout = vi.fn()
    const user = userEvent.setup()
    render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={onLogout} />)
    await user.click(screen.getByTitle('退出登录'))
    await vi.waitFor(() => expect(onLogout).toHaveBeenCalledOnce())
  })
})
