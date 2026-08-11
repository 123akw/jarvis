const assert = require('node:assert/strict')
const { test } = require('node:test')

let wechatUi = {}
try {
  wechatUi = require('./wechat-ui.js')
} catch {
  // RED 阶段模块尚不存在；下面以行为断言失败，而不是收集时报错。
}

function response(state, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => state,
  }
}

test('viewFor maps waiting state to a scannable QR view', () => {
  assert.equal(typeof wechatUi.viewFor, 'function')

  assert.deepEqual(wechatUi.viewFor({
    state: 'waiting', qr_uri: 'data:image/svg+xml,qr', since: '13:40:00',
  }), {
    kind: 'waiting',
    qrUri: 'data:image/svg+xml,qr',
    status: '用微信「扫一扫」扫描上方二维码，手机确认登录（建议用专用小号）',
    statusClass: 's-hint wait',
  })
})

test('controller start polls immediately and owns only one timer', async () => {
  assert.equal(typeof wechatUi.createController, 'function')
  const rendered = []
  const timers = []
  const cleared = []
  const controller = wechatUi.createController({
    request: async () => response({ state: 'idle' }),
    render: state => rendered.push(state),
    setIntervalFn: (fn, ms) => {
      const timer = { fn, ms, id: timers.length + 1 }
      timers.push(timer)
      return timer
    },
    clearIntervalFn: timer => cleared.push(timer.id),
  })

  await controller.start()
  await controller.start()
  controller.stop()

  assert.deepEqual(rendered, [{ state: 'idle' }, { state: 'idle' }])
  assert.deepEqual(timers.map(item => item.ms), [2000, 2000])
  assert.deepEqual(cleared, [1, 2])
})

test('controller renders loading then the QR returned by connect', async () => {
  assert.equal(typeof wechatUi.createController, 'function')
  const rendered = []
  const calls = []
  const controller = wechatUi.createController({
    request: async (path, options) => {
      calls.push({ path, options })
      return response({ state: 'waiting', qr_uri: 'data:image/svg+xml,qr' })
    },
    render: state => rendered.push(state),
  })

  await controller.connect()

  assert.deepEqual(rendered, [
    { state: 'loading' },
    { state: 'waiting', qr_uri: 'data:image/svg+xml,qr' },
  ])
  assert.deepEqual(calls, [{
    path: '/api/wechat/connect', options: { method: 'POST' },
  }])
})

test('controller reauthenticates once when status returns 401', async () => {
  assert.equal(typeof wechatUi.createController, 'function')
  const rendered = []
  let requests = 0
  let logins = 0
  const controller = wechatUi.createController({
    request: async () => {
      requests += 1
      return requests === 1
        ? response({ error: '未登录' }, 401)
        : response({ state: 'connected' })
    },
    reauthenticate: async () => {
      logins += 1
      return true
    },
    render: state => rendered.push(state),
  })

  await controller.poll()

  assert.equal(logins, 1)
  assert.equal(requests, 2)
  assert.deepEqual(rendered, [{ state: 'connected' }])
})

test('controller exposes a retryable state after a network failure', async () => {
  assert.equal(typeof wechatUi.createController, 'function')
  const rendered = []
  const controller = wechatUi.createController({
    request: async () => { throw new TypeError('network down') },
    render: state => rendered.push(state),
  })

  await controller.connect()

  assert.deepEqual(rendered, [
    { state: 'loading' },
    { state: 'error', error: '连不上服务器，请稍后重试' },
  ])
})
