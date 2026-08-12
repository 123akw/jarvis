const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { createSessionGateway, isAllowedServer } = require('./session.js')

const response = (status, data = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => data,
  text: async () => '',
})

function gateway(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jws-session-'))
  const calls = []
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value).toString('base64'),
    decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
  }
  const instance = createSessionGateway({
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/api/desktop/login')) return response(200, { access_token: 'desktop-test-token' })
      return response(200, { ok: true })
    },
    safeStorage,
    fs,
    path,
    dataDir: directory,
    server: 'https://example.test',
    ...overrides,
  })
  return { instance, directory, calls }
}

test('only HTTPS servers are allowed outside explicit loopback development', () => {
  assert.equal(isAllowedServer('https://example.test', false), true)
  assert.equal(isAllowedServer('http://127.0.0.1:7789', false), false)
  assert.equal(isAllowedServer('http://127.0.0.1:7789', true), true)
  assert.equal(isAllowedServer('http://localhost:7789', true), false)
  assert.equal(isAllowedServer('https://example.test/other', false), false)
})

test('desktop token is encrypted with mode 0600 and never returned to renderer callers', async () => {
  const { instance, directory, calls } = gateway()
  const result = await instance.login('owner', 'test-password')

  assert.deepEqual(result, { ok: true })
  const stored = fs.readFileSync(path.join(directory, 'desktop-session.enc'))
  assert.doesNotMatch(stored.toString(), /desktop-test-token/)
  assert.equal(fs.statSync(path.join(directory, 'desktop-session.enc')).mode & 0o777, 0o600)
  await instance.request('dashboard')
  assert.equal(calls.at(-1).options.headers['X-JWS-Token'], 'desktop-test-token')
})

test('gateway clears the encrypted token on a 401 and rejects arbitrary operations', async () => {
  const { instance, directory } = gateway({
    fetchImpl: async (url) => url.endsWith('/api/desktop/login')
      ? response(200, { access_token: 'desktop-test-token' })
      : response(401, { error: 'expired' }),
  })
  await instance.login('owner', 'test-password')
  const denied = await instance.request('dashboard')

  assert.equal(denied.status, 401)
  assert.equal(fs.existsSync(path.join(directory, 'desktop-session.enc')), false)
  await assert.rejects(() => instance.request('/api/anything'), /operation/i)
})

test('a fresh main-process gateway restores an encrypted session without exposing it', async () => {
  const first = gateway()
  await first.instance.login('owner', 'test-password')
  const restored = createSessionGateway({
    fetchImpl: async (_url, options) => response(200, { authed: Boolean(options.headers['X-JWS-Token']) }),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value).toString('base64'),
      decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
    }, fs, path, dataDir: first.directory, server: 'https://example.test',
  })
  const result = await restored.request('session')
  assert.deepEqual(result, { status: 200, ok: true, data: { authed: true } })
})

test('safeStorage being unavailable fails closed without writing a plaintext token', async () => {
  const { instance, directory } = gateway({
    safeStorage: { isEncryptionAvailable: () => false },
  })
  await assert.rejects(() => instance.login('owner', 'test-password'), /encryption/i)
  assert.equal(fs.existsSync(path.join(directory, 'desktop-session.enc')), false)
})
