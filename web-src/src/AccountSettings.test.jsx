import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  changePassword: vi.fn(),
  createUser: vi.fn(),
  getUsers: vi.fn(),
  updateUser: vi.fn(),
}))

import { changePassword, createUser, getUsers } from './api.js'
import AccountSettings from './AccountSettings.jsx'

describe('account settings', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it('shows the signed-in username and role, while Members have no user management entry', () => {
    render(<AccountSettings session={{ authed: true, username: 'member-one', role: 'Member' }} />)

    expect(screen.getByText('member-one · Member')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '用户管理' })).toBeNull()
  })

  it('allows an Owner to create a user and clears password fields after the write', async () => {
    getUsers.mockResolvedValue([])
    createUser.mockResolvedValue({ id: 'u-2', username: 'member-two', role: 'Member', active: 1 })
    render(<AccountSettings session={{ authed: true, username: 'owner', role: 'Owner' }} />)

    fireEvent.click(screen.getByRole('button', { name: '用户管理' }))
    await screen.findByText('用户管理')
    fireEvent.change(screen.getByLabelText('新用户名'), { target: { value: 'member-two' } })
    fireEvent.change(screen.getByLabelText('初始口令'), { target: { value: 'not-echoed' } })
    fireEvent.click(screen.getByRole('button', { name: '创建用户' }))

    await waitFor(() => expect(createUser).toHaveBeenCalledWith({
      username: 'member-two', password: 'not-echoed', role: 'Member',
    }))
    expect(screen.getByLabelText('初始口令').value).toBe('')
  })

  it('changes the current password then clears inputs and requests a new login', async () => {
    changePassword.mockResolvedValue({ ok: true })
    const onReauth = vi.fn()
    render(<AccountSettings session={{ authed: true, username: 'owner', role: 'Owner' }} onReauth={onReauth} />)

    fireEvent.change(screen.getByLabelText('当前口令'), { target: { value: 'old-password' } })
    fireEvent.change(screen.getByLabelText('新口令'), { target: { value: 'new-password' } })
    fireEvent.click(screen.getByRole('button', { name: '更新口令' }))

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('old-password', 'new-password'))
    expect(screen.getByLabelText('当前口令').value).toBe('')
    expect(screen.getByText('口令已更新，请重新登录。')).toBeTruthy()
    expect(onReauth).toHaveBeenCalledOnce()
  })

  it('hands a 401 from Owner management back to the app login boundary', async () => {
    getUsers.mockRejectedValue(new Error('401'))
    const onReauth = vi.fn()
    render(<AccountSettings session={{ authed: true, username: 'owner', role: 'Owner' }} onReauth={onReauth} />)

    await waitFor(() => expect(onReauth).toHaveBeenCalledOnce())
  })
})
