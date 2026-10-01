const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { claimSingleInstance, registerProtocol, releaseShortcuts } = require('./app-lifecycle.js')

function fakeApp({ lock = true, ready = true, lockThrows = false } = {}) {
  const calls = []
  return {
    calls,
    requestSingleInstanceLock: () => { if (lockThrows) throw new Error('boom'); return lock },
    setAsDefaultProtocolClient: (...args) => { calls.push(['set', ...args]); return true },
    removeAsDefaultProtocolClient: (...args) => { calls.push(['remove', ...args]); return true },
    isReady: () => ready,
  }
}

test('单实例：拿到锁放行，已有实例在跑则返回 false', () => {
  assert.strictEqual(claimSingleInstance(fakeApp({ lock: true })), true)
  assert.strictEqual(claimSingleInstance(fakeApp({ lock: false })), false)
})

test('单实例：锁 API 异常时保守放行，不让应用起不来', () => {
  assert.strictEqual(claimSingleInstance(fakeApp({ lockThrows: true })), true)
})

test('协议：打包版直接注册 jws', () => {
  const app = fakeApp()
  assert.strictEqual(registerProtocol(app, { defaultApp: false, platform: 'darwin' }), 'registered')
  assert.deepStrictEqual(app.calls, [['set', 'jws']])
})

test('协议：dev+macOS 不注册并清掉旧登记，避免拉起 Electron 欢迎页', () => {
  const app = fakeApp()
  assert.strictEqual(registerProtocol(app, { defaultApp: true, platform: 'darwin' }), 'skipped-dev-mac')
  assert.deepStrictEqual(app.calls, [['remove', 'jws']])
})

test('协议：dev+Windows 带上 execPath 与应用目录', () => {
  const app = fakeApp()
  const result = registerProtocol(app, {
    defaultApp: true, platform: 'win32', execPath: 'C:/electron.exe', argv: ['C:/electron.exe', 'desktop'],
  })
  assert.strictEqual(result, 'registered-dev')
  assert.deepStrictEqual(app.calls, [['set', 'jws', 'C:/electron.exe', [path.resolve('desktop')]]])
})

test('协议：dev 模式拿不到应用目录时不乱注册', () => {
  const app = fakeApp()
  assert.strictEqual(registerProtocol(app, { defaultApp: true, platform: 'linux', argv: ['electron'] }), 'skipped-no-app-path')
  assert.deepStrictEqual(app.calls, [])
})

test('退出清理：app 未 ready 时不碰 globalShortcut（原主进程报错框的根因）', () => {
  let unregistered = 0
  const shortcut = { unregisterAll: () => { unregistered += 1 } }
  assert.strictEqual(releaseShortcuts(fakeApp({ ready: false }), shortcut), false)
  assert.strictEqual(unregistered, 0)
  assert.strictEqual(releaseShortcuts(fakeApp({ ready: true }), shortcut), true)
  assert.strictEqual(unregistered, 1)
})
