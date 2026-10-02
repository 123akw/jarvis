/* 打包 / 安装脚本（desktop/tools/pack-mac.js、install-mac.js）里的纯逻辑 */
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { APP_NAME, BUNDLE_ID, appBundlePath, findCachedElectronZipDir, macPackOptions } = require('./tools/pack-mac.js')
const { installTarget, pidsToStop, enableOpenAtLogin } = require('./tools/install-mac.js')

test('打包选项：显示名「贾维斯」、bundle id、jws:// 协议、去掉测试与产物目录', () => {
  const options = macPackOptions({ arch: 'arm64', electronVersion: '38.8.6', appVersion: '1.1.0', electronZipDir: '/cache/x', root: '/r', outDir: '/r/out' })
  assert.strictEqual(APP_NAME, '贾维斯')
  assert.strictEqual(options.name, '贾维斯')
  assert.strictEqual(options.appBundleId, BUNDLE_ID)
  assert.strictEqual(options.platform, 'darwin')
  assert.strictEqual(options.arch, 'arm64')
  assert.deepStrictEqual(options.protocols, [{ name: '贾维斯网页唤起', schemes: ['jws'] }])
  assert.strictEqual(options.extendInfo.CFBundleDisplayName, '贾维斯')
  assert.ok(options.extendInfo.NSMicrophoneUsageDescription)
  assert.strictEqual(options.electronZipDir, '/cache/x')
  assert.strictEqual(options.prune, true)
  const ignored = file => options.ignore.some(pattern => pattern.test(file))
  for (const file of ['/out/贾维斯-darwin-arm64', '/tools/pack-mac.js', '/session.test.js', '/.DS_Store']) assert.ok(ignored(file), file)
  for (const file of ['/main.js', '/index.html', '/node_modules/marked/lib/marked.esm.js', '/wake-server.js']) assert.ok(!ignored(file), file)
  assert.strictEqual(macPackOptions({ electronVersion: '1', appVersion: '1' }).electronZipDir, undefined)
  assert.strictEqual(appBundlePath('arm64', '/r/out'), '/r/out/贾维斯-darwin-arm64/贾维斯.app')
})

test('复用 ~/Library/Caches/electron 里已下载的安装包', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'jws-electron-cache-'))
  fs.mkdirSync(path.join(cache, 'abc123'))
  fs.writeFileSync(path.join(cache, 'abc123', 'electron-v38.8.6-darwin-arm64.zip'), '')
  assert.strictEqual(findCachedElectronZipDir({ version: '38.8.6', arch: 'arm64', cacheRoot: cache }), path.join(cache, 'abc123'))
  assert.strictEqual(findCachedElectronZipDir({ version: '38.8.6', arch: 'x64', cacheRoot: cache }), '')
  assert.strictEqual(findCachedElectronZipDir({ version: '38.8.6', arch: 'arm64', cacheRoot: path.join(cache, 'missing') }), '')
})

test('安装：只退出本仓库的开发版与贾维斯本身，不碰别的 Electron 应用', () => {
  const devBinary = '/Users/u/JWS-Agent/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  const appExe = '/Users/u/Applications/贾维斯.app/Contents/MacOS/贾维斯'
  const ps = [
    `  101 ${devBinary} .`,
    '  102 /Users/u/clawd-on-desk/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
    `  103 ${devBinary.replace('MacOS/Electron', 'Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper')} --type=gpu`,
    `  104 ${appExe}`,
    '  105 node ./node_modules/.bin/electron .',
    '  garbage line',
  ].join('\n')
  assert.deepStrictEqual(pidsToStop(ps, { devBinary, appExecutables: [appExe] }), [101, 104])
  assert.strictEqual(installTarget('/Users/u'), '/Users/u/Applications/贾维斯.app')
})

test('--login：只把 openAtLogin 打开，其它设置原样保留，文件仅本人可读写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jws-settings-'))
  const file = path.join(dir, 'jws-desktop', 'settings.json')
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify({ hotkey: 'Alt+Space', openAtLogin: false }))
  assert.deepStrictEqual(enableOpenAtLogin(file), { hotkey: 'Alt+Space', openAtLogin: true })
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { hotkey: 'Alt+Space', openAtLogin: true })
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  const fresh = path.join(dir, 'new', 'settings.json')
  assert.deepStrictEqual(enableOpenAtLogin(fresh), { openAtLogin: true })
})
