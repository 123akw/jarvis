const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { actOnReminder, actionable, createReminderNotifier, notificationOptions, reminderPayload } = require('./reminder-notify.js')

const MEETING = { id: 3, when: '2026-10-02 15:00', at: '2026-10-02 15:00', title: '项目复盘' }
const HEARTBEAT = { id: 'heartbeat-2026-10-02 15:00-1', when: '2026-10-02 15:00', title: '该回电话了' }

function fakeNotificationClass({ supported = true } = {}) {
  const created = []
  class FakeNotification extends EventEmitter {
    static isSupported() { return supported }
    constructor(options) { super(); this.options = options; this.shown = false; created.push(this) }
    show() { this.shown = true }
  }
  return { FakeNotification, created }
}

test('only schedule reminders with a ring time are actionable', () => {
  assert.equal(actionable(MEETING), true)
  assert.equal(actionable(HEARTBEAT), false)
  assert.equal(actionable({ ...MEETING, at: '明天' }), false)
  assert.equal(actionable({ ...MEETING, id: 0 }), false)
})

test('macOS notifications carry snooze and done buttons; other platforms stay plain', () => {
  const mac = notificationOptions(MEETING, 'darwin')
  assert.equal(mac.title, '贾维斯 · 日程提醒')
  assert.equal(mac.body, '15:00 项目复盘')
  assert.deepEqual(mac.actions.map(a => a.text), ['稍后 10 分钟', '完成'])
  assert.equal(notificationOptions(MEETING, 'win32').actions, undefined)
  assert.equal(notificationOptions(HEARTBEAT, 'darwin').actions, undefined)
  assert.equal(notificationOptions({ ...MEETING, at: '2026-10-02 15:13' }, 'darwin').title, '贾维斯 · 再次提醒')
})

test('actOnReminder maps actions onto whitelisted gateway operations', async () => {
  const calls = []
  const request = async (op, body) => { calls.push([op, body]); return { ok: true, data: { status: 'snoozed' } } }
  assert.deepEqual(await actOnReminder(request, MEETING, 'snooze'), { ok: true, data: { status: 'snoozed' } })
  await actOnReminder(request, MEETING, 'done')
  assert.deepEqual(calls, [
    ['reminderSnooze', { id: 3, at: '2026-10-02 15:00', minutes: 10 }],
    ['reminderDone', { id: 3, at: '2026-10-02 15:00' }],
  ])
  assert.deepEqual(await actOnReminder(request, HEARTBEAT, 'done'), { ok: false, data: {} })
  assert.equal(calls.length, 2)
})

test('button presses act on the reminder and clicks fall back to opening the panel', async () => {
  const { FakeNotification, created } = fakeNotificationClass()
  const calls = [], opened = [], acted = []
  const notifier = createReminderNotifier({
    Notification: FakeNotification, platform: 'darwin',
    request: async (op, body) => { calls.push(op); return { ok: true, data: {} } },
    onOpen: item => opened.push(item.title),
    onActed: (item, action, result) => acted.push([action, result.ok]),
  })
  notifier.notify(MEETING)
  notifier.notify(MEETING)
  assert.equal(created.length, 2)
  assert.equal(created[0].shown, true)
  assert.equal(notifier.liveCount(), 2)            // 持有引用，防 GC 丢回调
  created[0].emit('action', {}, 0)
  created[1].emit('click')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['reminderSnooze'])
  assert.deepEqual(acted, [['snooze', true]])
  assert.deepEqual(opened, ['项目复盘'])
  assert.equal(notifier.liveCount(), 0)
})

test('unsupported notifications are skipped quietly', () => {
  const { FakeNotification, created } = fakeNotificationClass({ supported: false })
  const notifier = createReminderNotifier({ Notification: FakeNotification, platform: 'darwin', request: async () => ({}) })
  assert.equal(notifier.notify(MEETING), null)
  assert.equal(created.length, 0)
})

test('renderer payload keeps only whitelisted fields', () => {
  assert.deepEqual(reminderPayload({ ...MEETING, extra: '<script>' }), { id: 3, at: '2026-10-02 15:00', when: '2026-10-02 15:00', title: '项目复盘' })
  assert.deepEqual(reminderPayload(HEARTBEAT), { id: 0, at: '', when: '2026-10-02 15:00', title: '该回电话了' })
  assert.equal(reminderPayload(null), null)
})
