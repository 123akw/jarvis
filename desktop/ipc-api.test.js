const assert = require('node:assert/strict')
const { test } = require('node:test')

const { createApiHandlers } = require('./ipc-api.js')

function fixture() {
  const mainFrame = { url: 'file:///app/index.html' }
  const sent = []
  const webContents = { mainFrame, send: (...args) => sent.push(args) }
  const event = { sender: webContents, senderFrame: mainFrame }
  let release
  const gateway = {
    login: async () => ({ ok: true }),
    request: async () => ({ ok: true, status: 200, data: {} }),
    stream: async (_operation, _body, { onEvent, signal }) => {
      onEvent({ type: 'token', text: 'first' })
      await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }) })
      return signal.aborted ? { status: 0, ok: false, cancelled: true } : { status: 200, ok: true }
    },
  }
  const handlers = createApiHandlers({ gateway, getWindow: () => ({ webContents }), indexUrl: mainFrame.url })
  return { event, sent, handlers, release: () => release?.() }
}

test('API handlers reject a sender outside the current main frame', async () => {
  const { handlers, event } = fixture()
  await assert.rejects(() => handlers.request({ ...event, senderFrame: { url: event.senderFrame.url } }, 'session'), /untrusted/i)
})

test('desktop login IPC accepts only an exact bounded credential object', async () => {
  const { handlers, event } = fixture()
  assert.deepEqual(await handlers.login(event, { username: 'owner', password: 'secret' }), { ok: true })
  await assert.rejects(() => handlers.login(event, { username: 'owner', password: 'secret', extra: true }), /field/i)
  await assert.rejects(() => handlers.login(event, { username: 'x'.repeat(129), password: 'secret' }), /username/i)
})

test('stream handler forwards each event on one fixed channel before completion', async () => {
  const { handlers, event, sent, release } = fixture()
  let complete = false
  const pending = handlers.start(event, 'stream-12345678', 'chat', { thread_id: 'desktop', message: 'hello' }).then(result => { complete = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(complete, false)
  assert.deepEqual(sent, [['api-stream-event', { id: 'stream-12345678', event: { type: 'token', text: 'first' } }]])
  release()
  assert.deepEqual(await pending, { status: 200, ok: true })
})

test('only the stream owner can cancel its in-flight request', async () => {
  const { handlers, event } = fixture()
  const pending = handlers.start(event, 'stream-12345678', 'chat', { thread_id: 'desktop', message: 'hello' })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(() => handlers.cancel({ sender: {}, senderFrame: {} }, 'stream-12345678'), /untrusted/i)
  assert.deepEqual(await handlers.cancel(event, 'stream-12345678'), { cancelled: true })
  assert.deepEqual(await pending, { status: 0, ok: false, cancelled: true })
})
