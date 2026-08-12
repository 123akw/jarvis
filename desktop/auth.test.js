const assert = require('node:assert/strict')
const { test } = require('node:test')

let auth = {}
try {
  auth = require('./auth.js')
} catch {
  // RED phase: behavior assertions below describe the required module contract.
}

test('desktop authentication starts clean and mints a desktop access token', async () => {
  assert.equal(typeof auth.createDesktopAuthenticator, 'function')
  const calls = []
  const client = auth.createDesktopAuthenticator({
    username: 'owner', password: 'owner-password',
    request: async (path, options = {}) => {
      calls.push({ path, options })
      if (path === '/api/session') return { ok: true, json: async () => ({ authed: false }) }
      return { ok: true, json: async () => ({ access_token: 'desktop-session-token' }) }
    },
  })

  assert.equal(await client.ensureLogin(), true)
  assert.deepEqual(client.headers(), { 'X-JWS-Token': 'desktop-session-token' })
  assert.deepEqual(calls, [
    { path: '/api/session', options: { headers: {} } },
    { path: '/api/desktop/login', options: {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'owner-password' }),
    } },
  ])
})
