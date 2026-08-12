const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')

const { createPreloadApi } = require('./preload-api.js')

test('preload stream uses fixed IPC channels, forwards incrementally, and cancels', async () => {
  const ipc = new EventEmitter()
  const calls = []
  let finish
  ipc.invoke = (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'api-stream-start') return new Promise(resolve => { finish = resolve })
    return Promise.resolve({ cancelled: true })
  }
  const api = createPreloadApi(ipc, () => 'stream-12345678')
  const events = []
  const id = api.startStream('chat', { thread_id: 'desktop', message: 'hi' }, event => events.push(event))
  assert.equal(id, 'stream-12345678')
  ipc.emit('api-stream-event', {}, { id: 'stream-12345678', event: { type: 'token', text: 'A' } })
  assert.deepEqual(events, [{ type: 'token', text: 'A' }])
  assert.deepEqual(await api.cancelStream(id), { cancelled: true })
  finish({ status: 0, ok: false, cancelled: true })
  await api.streamDone(id)
  assert.deepEqual(calls.map(call => call[0]), ['api-stream-start', 'api-stream-cancel'])
})
