const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { createWakeServer, isAllowedWakeOrigin, parseHandoffUrl, WAKE_PORT } = require('./wake-server.js')
const { createSessionGateway } = require('./session.js')

const PROD = 'https://jws.gkgeek-set.cn'

async function startServer(overrides = {}) {
  const logs = []
  const server = createWakeServer({
    serverOrigin: PROD,
    log: line => logs.push(String(line)),
    port: 0,  // 测试用临时端口，避免占用真实 17789
    ...overrides,
  })
  const started = await server.start()
  assert.equal(started.ok, true)
  return { server, logs, base: `http://127.0.0.1:${started.port}` }
}

test('default wake port is the agreed 17789', () => {
  assert.equal(WAKE_PORT, 17789)
})

test('ping returns app identity, login state and strict CORS headers for the production origin', async t => {
  const { server, base } = await startServer({ isLoggedIn: () => false })
  t.after(() => server.stop())
  const response = await fetch(`${base}/ping`, { headers: { Origin: PROD } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { app: 'jws-desktop', loggedIn: false })
  assert.equal(response.headers.get('access-control-allow-origin'), PROD)
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('localhost origins on any port are allowed and loggedIn reflects gateway state', async t => {
  const { server, base } = await startServer({ isLoggedIn: () => true })
  t.after(() => server.stop())
  const response = await fetch(`${base}/ping`, { headers: { Origin: 'http://localhost:5599' } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { app: 'jws-desktop', loggedIn: true })
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5599')
})

test('origins outside the whitelist are rejected with 403 and no CORS grant', async t => {
  const { server, base, logs } = await startServer({})
  t.after(() => server.stop())
  const badOrigins = ['https://evil.test', 'http://localhost.evil.com', 'https://localhost:5599',
    'http://127.0.0.1:5599', 'jws.gkgeek-set.cn', '']
  for (const origin of badOrigins) {
    const response = await fetch(`${base}/ping`, { headers: origin ? { Origin: origin } : {} })
    assert.equal(response.status, 403, `origin should be denied: ${origin || '(missing)'}`)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  }
  assert.ok(logs.includes('wake-origin-denied'))
  assert.equal(isAllowedWakeOrigin(PROD, PROD), true)
  assert.equal(isAllowedWakeOrigin('http://localhost', PROD), true)
  assert.equal(isAllowedWakeOrigin('https://jws.gkgeek-set.cn.evil.com', PROD), false)
})

test('CORS preflight answers the Chrome private-network-access handshake', async t => {
  const { server, base } = await startServer({})
  t.after(() => server.stop())
  const response = await fetch(`${base}/wake`, {
    method: 'OPTIONS',
    headers: {
      Origin: PROD,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
      'Access-Control-Request-Private-Network': 'true',
    },
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true')
  assert.equal(response.headers.get('access-control-allow-origin'), PROD)
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST')
  assert.equal(response.headers.get('access-control-allow-headers'), 'content-type')
})

test('wake with a ticket exchanges it through the real session gateway into a persisted login', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jws-wake-'))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value).toString('base64'),
    decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
  }
  const upstreamCalls = []
  const gateway = createSessionGateway({
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url, options })
      if (url.endsWith('/api/desktop/handoff/exchange')) {
        return { status: 200, ok: true, json: async () => ({ access_token: 'exchanged-desktop-token', token_type: 'x-jws-token' }) }
      }
      return { status: 200, ok: true, json: async () => ({ ok: true }) }
    },
    safeStorage, fs, path, dataDir: directory, server: 'https://example.test',
  })
  const woken = []
  const { server, base, logs } = await startServer({
    isLoggedIn: () => Boolean(gateway.authToken()),
    onWake: () => woken.push(true),
    exchangeTicket: ticket => gateway.exchange(ticket),
  })
  t.after(() => server.stop())

  const response = await fetch(`${base}/wake`, {
    method: 'POST', headers: { Origin: PROD, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: 'one-time-ticket-abc' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, loggedIn: true })
  assert.equal(woken.length, 1)
  // 换票请求只带票据，永远不带密码字段
  const exchangeCall = upstreamCalls.find(call => call.url.endsWith('/api/desktop/handoff/exchange'))
  assert.deepEqual(JSON.parse(exchangeCall.options.body), { ticket: 'one-time-ticket-abc' })
  // 令牌加密落盘（既有 login 落盘链），密文里不出现明文令牌
  const stored = fs.readFileSync(path.join(directory, 'desktop-session.enc'))
  assert.doesNotMatch(stored.toString(), /exchanged-desktop-token/)
  await gateway.request('dashboard')
  assert.equal(upstreamCalls.at(-1).options.headers['X-JWS-Token'], 'exchanged-desktop-token')
  // 票据不落日志、不落盘
  assert.doesNotMatch(logs.join('\n'), /one-time-ticket-abc/)
  assert.doesNotMatch(stored.toString(), /one-time-ticket-abc/)
})

test('a rejected or throwing exchange leaves the listener alive and logged out', async t => {
  let attempts = 0
  const { server, base, logs } = await startServer({
    isLoggedIn: () => false,
    exchangeTicket: async () => {
      attempts += 1
      if (attempts === 1) return { ok: false, status: 401 }
      throw new Error('network down')
    },
  })
  t.after(() => server.stop())
  for (let round = 0; round < 2; round += 1) {
    const response = await fetch(`${base}/wake`, {
      method: 'POST', headers: { Origin: PROD, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'bad-ticket-zzz' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, loggedIn: false })
  }
  assert.equal(attempts, 2)
  const ping = await fetch(`${base}/ping`, { headers: { Origin: PROD } })
  assert.equal(ping.status, 200)  // 坏票不崩，监听还活着
  assert.doesNotMatch(logs.join('\n'), /bad-ticket-zzz/)
})

test('wake without a ticket only summons the window and never calls exchange', async t => {
  const woken = []
  const exchanged = []
  const { server, base } = await startServer({
    isLoggedIn: () => true,
    onWake: () => woken.push(true),
    exchangeTicket: async ticket => { exchanged.push(ticket); return { ok: true } },
  })
  t.after(() => server.stop())
  const response = await fetch(`${base}/wake`, {
    method: 'POST', headers: { Origin: PROD, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.deepEqual(await response.json(), { ok: true, loggedIn: true })
  assert.equal(woken.length, 1)
  assert.deepEqual(exchanged, [])
})

test('an occupied port degrades to a panel notice instead of crashing', async t => {
  const { server, base } = await startServer({})
  t.after(() => server.stop())
  const notices = []
  const second = createWakeServer({
    serverOrigin: PROD,
    port: Number(new URL(base).port),
    onUnavailable: reason => notices.push(reason),
  })
  const started = await second.start()
  assert.deepEqual(started, { ok: false, reason: 'port-in-use' })
  assert.deepEqual(notices, ['port-in-use'])
  const ping = await fetch(`${base}/ping`, { headers: { Origin: PROD } })
  assert.equal(ping.status, 200)  // 第一个监听不受影响
})

test('oversized or malformed wake bodies are rejected without crashing the listener', async t => {
  const { server, base } = await startServer({})
  t.after(() => server.stop())
  const malformed = await fetch(`${base}/wake`, {
    method: 'POST', headers: { Origin: PROD, 'Content-Type': 'application/json' }, body: '{not json',
  })
  assert.equal(malformed.status, 400)
  await assert.rejects(fetch(`${base}/wake`, {
    method: 'POST', headers: { Origin: PROD, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: 'x'.repeat(8192) }),
  }))  // 超限直接掐断连接
  const ping = await fetch(`${base}/ping`, { headers: { Origin: PROD } })
  assert.equal(ping.status, 200)
})

test('jws:// protocol urls parse into the same wake semantics', () => {
  assert.deepEqual(parseHandoffUrl('jws://handoff?ticket=abc-DEF_123'), { ticket: 'abc-DEF_123' })
  assert.deepEqual(parseHandoffUrl('jws://handoff'), { ticket: '' })
  assert.equal(parseHandoffUrl('jws://steal?ticket=abc'), null)
  assert.equal(parseHandoffUrl('https://handoff?ticket=abc'), null)
  assert.equal(parseHandoffUrl('jws://handoff?ticket=' + 'a'.repeat(600)), null)
  assert.equal(parseHandoffUrl('jws://handoff?ticket=has space'), null)
  assert.equal(parseHandoffUrl('not a url'), null)
})
