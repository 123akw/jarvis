import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getSession: vi.fn(async () => ({ authed: true, username: 'owner', role: 'Owner' })) }))
vi.mock('./Hud.jsx', () => ({ default: ({ onLogout }) => <button onClick={() => onLogout('password-changed')}>password changed</button> }))
vi.mock('./Login.jsx', () => ({ default: ({ notice }) => <div role="status">{notice}</div> }))

import App from './App.jsx'

describe('app authentication transitions', () => {
  afterEach(cleanup)
  it('keeps the password-change reason after account UI unmounts', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'password changed' }))
    expect(screen.getByRole('status')).toHaveTextContent('口令已更新，请重新登录。')
  })
})
