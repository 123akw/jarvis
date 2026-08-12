const assert = require('node:assert/strict')
const { test } = require('node:test')

const { startChatStream } = require('./chat-stream.js')

test('renderer chat orchestration paints events before completion and supports cancel', async () => {
  let callback
  let finish
  const api = {
    startStream: (_operation, _body, onEvent) => { callback = onEvent; return 'stream-1' },
    streamDone: async () => new Promise(resolve => { finish = resolve }),
    cancelStream: async id => ({ cancelled: id === 'stream-1' }),
  }
  const events = []
  const chat = startChatStream(api, { thread_id: 'desktop', message: 'hello' }, { onEvent: event => events.push(event) })
  callback({ type: 'token', text: 'A' })
  assert.deepEqual(events, [{ type: 'token', text: 'A' }])
  assert.deepEqual(await chat.cancel(), { cancelled: true })
  finish({ status: 200, ok: true })
  assert.deepEqual(await chat.done, { status: 200, ok: true })
})

test('renderer chat orchestration sends 401 to the login boundary', async () => {
  let expired = 0
  const api = { startStream: () => 'stream-2', streamDone: async () => ({ status: 401, ok: false }), cancelStream: async () => ({}) }
  const chat = startChatStream(api, { thread_id: 'desktop', message: 'hello' }, { onEvent: () => {}, onUnauthorized: () => { expired += 1 } })
  await assert.rejects(() => chat.done, error => error.code === 'AUTH_REQUIRED')
  assert.equal(expired, 1)
})
