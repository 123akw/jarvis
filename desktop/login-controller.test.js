const assert = require('node:assert/strict')
const { test } = require('node:test')

const { createLoginController } = require('./login-controller.js')

test('first launch expands login and lets an unauthenticated user configure the server', async () => {
  const states = []
  const saved = []
  const controller = createLoginController({
    api: { request: async () => ({ ok: false, status: 401 }), login: async () => ({ ok: false }) },
    getSettings: async () => ({ server: 'https://old.test' }),
    setSettings: async patch => { saved.push(patch); return { ...patch } },
    showLogin: async () => states.push('expanded'),
    setLoginVisible: value => states.push(value ? 'login' : 'hidden'),
  })
  assert.deepEqual(await controller.init(), { authenticated: false, server: 'https://old.test' })
  await controller.saveServer('https://new.test')
  assert.deepEqual(states, ['expanded', 'login'])
  assert.deepEqual(saved, [{ server: 'https://new.test' }])
})

test('desktop password is cleared even when main-process login throws', async () => {
  let cleared = 0
  const controller = createLoginController({
    api: { login: async () => { throw new Error('disk failed') } }, clearPassword: () => { cleared += 1 },
  })
  await assert.rejects(() => controller.login('owner', 'secret'), /disk failed/)
  assert.equal(cleared, 1)
})

test('successful first login closes the fail-closed overlay and loads authenticated data', async () => {
  const visible = []
  let loaded = 0
  const controller = createLoginController({
    api: { login: async () => ({ ok: true }) },
    setLoginVisible: value => visible.push(value),
    clearPassword: () => {},
    onAuthenticated: async () => { loaded += 1 },
  })
  assert.deepEqual(await controller.login('owner', 'secret'), { ok: true })
  assert.deepEqual(visible, [false])
  assert.equal(loaded, 1)
})
