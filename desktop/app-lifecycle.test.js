const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')
const {
  claimSingleInstance, registerProtocol, releaseShortcuts,
  DATA_DIR_NAME, sharedUserDataPath, protocolLinkFromArgv, createProtocolInbox, autoLaunchMode,
} = require('./app-lifecycle.js')
const { parseHandoffUrl } = require('./wake-server.js')

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

test('打包版与开发版共用用户数据目录 jws-desktop（令牌、设置、单实例锁都在里面）', () => {
  const app = { getPath: name => (name === 'appData' ? '/Users/u/Library/Application Support' : '') }
  assert.strictEqual(sharedUserDataPath(app), '/Users/u/Library/Application Support/jws-desktop')
  // 钥匙串密钥按 app.name（package.json 的 productName || name）命名：加了 productName 打包版就读不出登录态
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'))
  assert.strictEqual(pkg.name, DATA_DIR_NAME)
  assert.strictEqual(pkg.productName, undefined)
})

test('冷启动取票：open-url 早于 ready 时先排队，窗口建好后按序处理并能解析出票', () => {
  const handled = []
  const inbox = createProtocolInbox(url => handled.push(parseHandoffUrl(url)))
  inbox.receive('jws://handoff?ticket=cold-ticket')
  inbox.receive('')            // 空值忽略
  assert.deepStrictEqual(handled, [])
  assert.strictEqual(inbox.pending(), 1)
  inbox.open()
  assert.deepStrictEqual(handled, [{ ticket: 'cold-ticket' }])
  inbox.receive('jws://handoff?ticket=warm')   // ready 之后直接处理
  assert.deepStrictEqual(handled.at(-1), { ticket: 'warm' })
})

test('收件箱：排队有上限，单条处理抛错不影响后续', () => {
  const seen = []
  const inbox = createProtocolInbox(url => { if (url.endsWith('bad')) throw new Error('boom'); seen.push(url) }, { limit: 2 })
  inbox.receive('jws://handoff?ticket=bad')
  inbox.receive('jws://handoff?ticket=a')
  inbox.receive('jws://handoff?ticket=b')    // 超出上限丢弃
  inbox.open()
  assert.deepStrictEqual(seen, ['jws://handoff?ticket=a'])
})

test('argv 里找 jws:// 链接（Windows/Linux 冷启动与 second-instance）', () => {
  assert.strictEqual(protocolLinkFromArgv(['/x/贾维斯', '--flag', 'jws://handoff?ticket=t']), 'jws://handoff?ticket=t')
  assert.strictEqual(protocolLinkFromArgv(['/x/贾维斯']), '')
  assert.strictEqual(protocolLinkFromArgv(undefined), '')
})

test('开机自启：打包版用系统登录项，开发版 macOS 用 LaunchAgent', () => {
  assert.strictEqual(autoLaunchMode({ platform: 'darwin', packaged: true }), 'login-item')
  assert.strictEqual(autoLaunchMode({ platform: 'darwin', packaged: false }), 'launch-agent')
  assert.strictEqual(autoLaunchMode({ platform: 'win32', packaged: false }), 'login-item-dev')
  assert.strictEqual(autoLaunchMode({ platform: 'linux', packaged: true }), 'unsupported')
})

test('main.js 接线：用户数据目录在单实例锁之前固定；open-url / second-instance 都进收件箱，ready 后才放行', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf-8')
  const pin = source.indexOf("app.setPath('userData', sharedUserDataPath(app))")
  const lock = source.indexOf('claimSingleInstance(app)')
  assert.ok(pin > 0 && lock > pin, 'userData 必须在 requestSingleInstanceLock 之前设置')
  assert.match(source, /app\.on\('open-url', \(event, url\) => \{ event\.preventDefault\(\); protocolInbox\.receive\(url\) \}\)/)
  assert.match(source, /if \(link\) protocolInbox\.receive\(link\)/)
  const ready = source.indexOf('app.whenReady().then(')
  const open = source.indexOf('protocolInbox.open()')
  assert.ok(open > ready && open > source.indexOf('createWindow()', ready), '收件箱要在窗口建好后才放行')
})

test('打包版注册 jws 协议（macOS 打包版不再被开发版逻辑跳过）', () => {
  const app = fakeApp()
  assert.strictEqual(registerProtocol(app, { defaultApp: undefined, platform: 'darwin' }), 'registered')
  assert.deepStrictEqual(app.calls, [['set', 'jws']])
})
