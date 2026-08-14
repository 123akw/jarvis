const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { createSessionGateway, isAllowedServer, replaceSessionGateway } = require('./session.js')

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

test('request schemas reject extra fields, wrong desktop threads, and oversized messages', async () => {
  const { instance } = gateway()
  await assert.rejects(() => instance.request('session', { extra: true }), /body/i)
  await assert.rejects(() => instance.request('history', { thread_id: 'other' }), /thread/i)
  await assert.rejects(() => instance.request('chat', { thread_id: 'desktop', message: 'x'.repeat(12001) }), /message/i)
  await assert.rejects(() => instance.request('chat', { thread_id: 'desktop', message: 'ok', extra: true }), /field/i)
})

test('provider operations are allowlisted, schema checked, and DELETE carries only the approved body', async () => {
  const { instance, calls } = gateway()
  const llm = { provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-test', api_key: 'transient-key', keep_existing_key: false, admin_password: 'current-password', expected_generation: 0 }
  await instance.request('providerTest', llm)
  assert.equal(calls.at(-1).url, 'https://example.test/api/settings/llm/test')
  assert.equal(JSON.parse(calls.at(-1).options.body).api_key, 'transient-key')
  await assert.rejects(() => instance.request('providerSave', { ...llm, unexpected: true }), /field/i)
  await assert.rejects(() => instance.request('integrationSave', { name: 'unknown', enabled: true, base_url: '', api_key: null, keep_existing_key: false, admin_password: 'p', expected_generation: 0 }), /integration/i)
  await instance.request('providerRestore', { admin_password: 'current-password', expected_generation: 2 })
  assert.equal(calls.at(-1).options.method, 'DELETE')
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { admin_password: 'current-password', expected_generation: 2 })
  await instance.request('integrationRestore', { name: 'tavily', admin_password: 'current-password', expected_generation: 4 })
  assert.equal(calls.at(-1).url, 'https://example.test/api/settings/integrations/tavily')
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { admin_password: 'current-password', expected_generation: 4 })
})

test('login publishes no token when atomic persistence fails', async () => {
  const real = fs
  const failingFs = { ...real, renameSync: () => { throw new Error('rename failed') } }
  const { instance, directory, calls } = gateway({ fs: failingFs })
  await assert.rejects(() => instance.login('owner', 'test-password'), /rename failed/)
  await instance.request('dashboard')
  assert.equal(calls.at(-1).options.headers['X-JWS-Token'], undefined)
  assert.equal(real.existsSync(path.join(directory, 'desktop-session.enc')), false)
})

test('encrypted sessions are bound to their server origin and decrypt failures fail closed', async () => {
  const first = gateway()
  await first.instance.login('owner', 'test-password')
  const foreignCalls = []
  const foreign = createSessionGateway({
    fetchImpl: async (url, options) => { foreignCalls.push({ url, options }); return response(200) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value).toString('base64'),
      decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
    }, fs, path, dataDir: first.directory, server: 'https://other.test',
  })
  await foreign.request('dashboard')
  assert.equal(foreignCalls[0].options.headers['X-JWS-Token'], undefined)
  assert.equal(fs.existsSync(path.join(first.directory, 'desktop-session.enc')), false)

  fs.writeFileSync(path.join(first.directory, 'desktop-session.enc'), 'broken', { mode: 0o600 })
  const broken = createSessionGateway({
    fetchImpl: async (_url, options) => response(200, { authenticated: Boolean(options.headers['X-JWS-Token']) }),
    safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('decrypt failed') } },
    fs, path, dataDir: first.directory, server: 'https://other.test',
  })
  assert.deepEqual((await broken.request('dashboard')).data, { authenticated: false })
  assert.equal(fs.existsSync(path.join(first.directory, 'desktop-session.enc')), false)
})

test('server switching clears credentials before publishing the new origin', async () => {
  const real = fs
  const failingFs = { ...real, unlinkSync: () => { throw new Error('clear failed') } }
  const { instance } = gateway({ fs: failingFs })
  await instance.login('owner', 'test-password')
  await assert.rejects(async () => instance.setServer('https://new.test'), /clear failed/)
  assert.equal(instance.server(), 'https://example.test')
})

test('a valid HTTPS setting repairs an invalid legacy server without constructing it', async () => {
  const calls = []
  const settings = { server: 'http://legacy-host.test' }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jws-repair-'))
  fs.writeFileSync(path.join(directory, 'desktop-session.enc'), 'legacy-ciphertext', { mode: 0o600 })
  const createGateway = server => createSessionGateway({
    fetchImpl: async url => { calls.push(url); return response(200, url.endsWith('/api/desktop/login') ? { access_token: 'replacement-token' } : {}) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value).toString('base64'),
      decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
    },
    fs, path, dataDir: directory, server,
  })
  const replacement = replaceSessionGateway({
    currentGateway: null,
    previousSettings: settings,
    nextSettings: { server: 'https://repaired.test' },
    createGateway,
    persistSettings: next => { Object.assign(settings, next) },
  })
  assert.equal(fs.existsSync(path.join(directory, 'desktop-session.enc')), false)
  await replacement.login('owner', 'secret')
  assert.equal(settings.server, 'https://repaired.test')
  assert.deepEqual(calls, ['https://repaired.test/api/desktop/login'])
})

test('a failed server settings save stays unauthenticated and remains retryable', () => {
  let clears = 0
  const oldGateway = { clear: () => { clears += 1 } }
  const nextSettings = { server: 'https://repaired.test' }
  const createGateway = server => ({ clear: () => { clears += 1 }, server: () => server })

  assert.throws(() => replaceSessionGateway({
    currentGateway: oldGateway,
    previousSettings: { server: 'http://legacy-host.test' },
    nextSettings,
    createGateway,
    persistSettings: () => { throw new Error('save failed') },
  }), /save failed/)
  assert.equal(clears, 2)

  const recovered = replaceSessionGateway({
    currentGateway: null,
    previousSettings: { server: 'http://legacy-host.test' },
    nextSettings,
    createGateway,
    persistSettings: () => {},
  })
  assert.equal(recovered.server(), 'https://repaired.test')
})

test('SSE events are emitted incrementally without response.text buffering and obey event limits', async () => {
  let release
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"token","text":"A"}\n\n'))
      release = () => { controller.enqueue(encoder.encode('data: {"type":"token","text":"B"}\n\n')); controller.close() }
    },
  })
  const { instance } = gateway({ fetchImpl: async () => ({ status: 200, ok: true, body,
    text: async () => { throw new Error('must not buffer') } }) })
  const events = []
  let finished = false
  const pending = instance.stream('chat', { thread_id: 'desktop', message: 'hello' }, { onEvent: event => events.push(event) })
    .then(value => { finished = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, [{ type: 'token', text: 'A' }])
  assert.equal(finished, false)
  release()
  assert.deepEqual(await pending, { status: 200, ok: true })

  const huge = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(`data: ${'x'.repeat(65537)}\n\n`)); controller.close() } })
  const limited = gateway({ fetchImpl: async () => ({ status: 200, ok: true, body: huge }) }).instance
  await assert.rejects(() => limited.stream('chat', { thread_id: 'desktop', message: 'hello' }, { onEvent: () => {} }), /limit/i)
})

test('streaming 401 clears persisted authentication and returns a stable re-login result', async () => {
  const first = gateway()
  await first.instance.login('owner', 'test-password')
  const denied = createSessionGateway({ fetchImpl: async () => response(401, { error: 'expired' }), safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value).toString('base64'),
    decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
  }, fs, path, dataDir: first.directory, server: 'https://example.test' })
  assert.deepEqual(await denied.stream('chat', { thread_id: 'desktop', message: 'hello' }, { onEvent: () => {} }), { status: 401, ok: false })
  assert.equal(fs.existsSync(path.join(first.directory, 'desktop-session.enc')), false)
})

test('voiceCallUrl maps the HTTPS origin to the wss voice endpoint', () => {
  const { instance } = gateway()
  assert.equal(instance.voiceCallUrl(), 'wss://example.test/api/voice/call')
})

test('authToken stays empty before login and loads the persisted token for handshake injection', async () => {
  const { instance } = gateway()
  assert.equal(instance.authToken(), '')
  await instance.login('owner', 'test-password')
  assert.equal(instance.authToken(), 'desktop-test-token')
  instance.clear()
  assert.equal(instance.authToken(), '')
})

test('voice/radio operations validate bodies and hit the right endpoints', async () => {
  const { instance, calls } = gateway()
  await instance.login('admin', 'pw')

  await instance.request('voiceSettingsGet')
  assert.ok(calls.at(-1).url.endsWith('/api/voice/settings'))
  await instance.request('voiceSettingsPut', { voice: 'female-yujie', speed: 1.2 })
  assert.equal(calls.at(-1).options.method, 'PUT')
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { voice: 'female-yujie', speed: 1.2 })
  await instance.request('radioPut', { time: '08:30' })
  assert.ok(calls.at(-1).url.endsWith('/api/radio'))
  await instance.request('radioPut', { time: '' })   // 留空=关闭

  await assert.rejects(() => instance.request('voiceSettingsPut', { voice: '', speed: 1 }), /voice/i)
  await assert.rejects(() => instance.request('voiceSettingsPut', { voice: 'x', speed: 9 }), /speed/i)
  await assert.rejects(() => instance.request('radioPut', { time: '8点半' }), /radio/i)
})
