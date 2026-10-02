import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ changePassword: vi.fn(), createUser: vi.fn(), getUsers: vi.fn(), updateUser: vi.fn() }))

import { changePassword, createUser, getUsers, updateUser } from './api.js'
import AccountSettings from './AccountSettings.jsx'

const OWNER = { authed: true, username: 'owner', role: 'Owner' }

describe('账户设置的反馈', () => {
  beforeEach(() => { vi.clearAllMocks(); getUsers.mockResolvedValue([]) })
  afterEach(cleanup)

  it('改口令失败时显示服务端给的原因（而不是笼统的「无法更新口令」）', async () => {
    changePassword.mockRejectedValue(Object.assign(new Error('当前口令不对或新口令无效'), { status: 400 }))
    render(<AccountSettings session={OWNER} />)
    fireEvent.change(screen.getByLabelText('当前口令'), { target: { value: 'wrong-current' } })
    fireEvent.change(screen.getByLabelText('新口令'), { target: { value: 'Another-Pass-2026' } })
    fireEvent.click(screen.getByRole('button', { name: '更新口令' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('当前口令不对或新口令无效')
  })

  it('新口令少于 8 位：不发请求，就地说明', async () => {
    render(<AccountSettings session={OWNER} />)
    fireEvent.change(screen.getByLabelText('当前口令'), { target: { value: 'old-password' } })
    fireEvent.change(screen.getByLabelText('新口令'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: '更新口令' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('至少 8 位')
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('创建用户：口令太短不提交；成功后给出「已创建」反馈', async () => {
    createUser.mockResolvedValue({ id: 'u-3', username: 'member-three', role: 'Member', active: 1 })
    render(<AccountSettings session={OWNER} />)
    fireEvent.click(screen.getByRole('button', { name: '用户管理' }))
    fireEvent.change(screen.getByLabelText('新用户名'), { target: { value: 'member-three' } })
    fireEvent.change(screen.getByLabelText('初始口令'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: '创建用户' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('至少 8 位')
    expect(createUser).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('初始口令'), { target: { value: 'long-enough-pass' } })
    fireEvent.click(screen.getByRole('button', { name: '创建用户' }))
    expect(await screen.findByText('已创建用户 member-three')).toBeInTheDocument()
  })

  it('创建用户失败：提示可能是用户名重复', async () => {
    createUser.mockRejectedValue(Object.assign(new Error('无法创建用户'), { status: 400 }))
    render(<AccountSettings session={OWNER} />)
    fireEvent.click(screen.getByRole('button', { name: '用户管理' }))
    fireEvent.change(screen.getByLabelText('新用户名'), { target: { value: 'owner' } })
    fireEvent.change(screen.getByLabelText('初始口令'), { target: { value: 'long-enough-pass' } })
    fireEvent.click(screen.getByRole('button', { name: '创建用户' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名可能已被占用')
  })

  it('重置他人口令成功给出反馈', async () => {
    getUsers.mockResolvedValue([{ id: 'u-2', username: 'member-two', role: 'Member', active: 1 }])
    updateUser.mockResolvedValue({ ok: true })
    render(<AccountSettings session={OWNER} />)
    fireEvent.click(screen.getByRole('button', { name: '用户管理' }))
    fireEvent.change(await screen.findByLabelText('重置 member-two 口令'), { target: { value: 'brand-new-pass' } })
    fireEvent.click(screen.getByRole('button', { name: '重置口令' }))
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith('u-2', { password: 'brand-new-pass' }))
    expect(await screen.findByText('已重置 member-two 的口令')).toBeInTheDocument()
  })
})
