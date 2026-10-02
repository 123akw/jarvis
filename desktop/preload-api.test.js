const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')

const { createEventApi, createPreloadApi } = require('./preload-api.js')

test('preload event subscriptions expose only approved primitives and can unsubscribe', () => {
  assert.equal(typeof createEventApi, 'function')
  const ipc = new EventEmitter()
  const api = createEventApi(ipc)
  const forceArgs = []
  const expandedArgs = []
  const stopForce = api.onForceExpand((...args) => forceArgs.push(args))
  const stopExpanded = api.onSetExpanded((...args) => expandedArgs.push(args))

  ipc.emit('force-expand', { sender: { secret: 'raw-electron-event' } })
  ipc.emit('set-expanded', { sender: { secret: 'raw-electron-event' } }, true)
  ipc.emit('set-expanded', { sender: { secret: 'raw-electron-event' } }, { sender: 'unapproved' })

  assert.deepEqual(forceArgs, [[]])
  assert.deepEqual(expandedArgs, [[true]])
  assert.equal(typeof stopForce, 'function')
  assert.equal(typeof stopExpanded, 'function')
  stopForce()
  stopExpanded()
  ipc.emit('force-expand', { sender: {} })
  ipc.emit('set-expanded', { sender: {} }, false)
  assert.deepEqual(forceArgs, [[]])
  assert.deepEqual(expandedArgs, [[true]])
})

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

test('reminder-open events pass through only well-formed reminder payloads', () => {
  const ipc = new EventEmitter()
  const api = createEventApi(ipc)
  const seen = []
  const stop = api.onReminderOpen(item => seen.push(item))
  ipc.emit('reminder-open', {}, { id: 3, at: '2026-10-02 15:00', when: '2026-10-02 15:00', title: '项目复盘', extra: 'x' })
  ipc.emit('reminder-open', {}, { id: '3', at: '', when: '', title: '' })
  ipc.emit('reminder-open', {}, null)
  assert.deepEqual(seen, [{ id: 3, at: '2026-10-02 15:00', when: '2026-10-02 15:00', title: '项目复盘' }])
  stop()
  ipc.emit('reminder-open', {}, { id: 4, at: '', when: '', title: 'x' })
  assert.equal(seen.length, 1)
})
