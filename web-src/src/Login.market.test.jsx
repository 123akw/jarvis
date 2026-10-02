import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./Presence.jsx', () => ({ default: () => null, prefersReducedMotion: () => true }))

import Login from './Login.jsx'

describe('登录页回市场', () => {
  afterEach(() => { cleanup(); window.history.replaceState({}, '', '/') })

  it('左上字标与右上「逛逛智能体市场」都回到市场首页', async () => {
    window.history.replaceState({}, '', '/login')
    const user = userEvent.setup()
    render(<Login onAuthed={() => {}} />)
    const back = screen.getByRole('link', { name: /逛逛智能体市场/ })
    expect(back).toHaveAttribute('href', '/')
    await user.click(back)
    expect(window.location.pathname).toBe('/')
    window.history.replaceState({}, '', '/login')
    await user.click(screen.getByRole('link', { name: 'J.A.R.V.I.S. 智能体市场首页' }))
    expect(window.location.pathname).toBe('/')
  })
})
