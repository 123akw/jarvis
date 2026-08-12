import { beforeEach, describe, expect, it, vi } from 'vitest'

import { changePassword, chatStream, createUser, csrfHeaders, deleteThread, login, logout, updateUser } from './api.js'

describe('web CSRF transport', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  it('loads the server-issued CSRF proof after web login', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ json: async () => ({ authed: true, csrf_token: 'csrf-proof' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })

    await login('owner', 'password')
    await deleteThread('thread-1')

    expect(global.fetch).toHaveBeenNthCalledWith(
      3, '/api/thread?thread_id=thread-1',
      { method: 'DELETE', headers: { 'X-JWS-CSRF': 'csrf-proof' } },
    )
  })

  it('adds CSRF to every account write', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ authed: true, csrf_token: 'csrf-account' }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    await login('owner', 'password')
    await changePassword('old', 'new')
    await createUser({ username: 'member', password: 'initial', role: 'Member' })
    await updateUser('user/1', { role: 'Owner' })

    for (const call of global.fetch.mock.calls.slice(2)) {
      expect(call[1].headers['X-JWS-CSRF']).toBe('csrf-account')
    }
    expect(global.fetch.mock.calls.at(-1)[0]).toBe('/api/admin/users/user%2F1')
  })

  it('clears CSRF after a failed logout and on any 401', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ authed: true, csrf_token: 'csrf-old' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'failed' }) })
    await login('owner', 'password')
    await expect(logout()).rejects.toThrow('failed')
    expect(csrfHeaders()).toEqual({})

    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'expired' }) })
    await expect(createUser({ username: 'x', password: 'y', role: 'Member' })).rejects.toThrow('401')
    expect(csrfHeaders()).toEqual({})

    global.fetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ authed: true, csrf_token: 'csrf-stream' }) })
      .mockResolvedValueOnce({ ok: false, status: 401 })
    await login('owner', 'password')
    await expect(chatStream('hello').next()).rejects.toThrow('401')
    expect(csrfHeaders()).toEqual({})
  })
})
