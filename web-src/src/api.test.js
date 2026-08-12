import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteThread, login } from './api.js'

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
})
