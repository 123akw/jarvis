#!/usr/bin/env node
/* 安装打包好的「贾维斯.app」：npm run install:mac [-- --login] [-- --no-open]
 *
 * 1. 退出正在运行的贾维斯，以及本仓库 `npm start` 起的开发版（两者共用单实例锁，不退新版会直接让位）；
 *    只认本仓库 node_modules/electron 那个进程，不碰别的 Electron 应用；
 * 2. 复制到 ~/Applications/贾维斯.app，用 lsregister 登记（jws:// 由它接收）；out/ 里的构建副本注销并删除
 *    （同一 bundle id 留两份，系统可能把 jws:// 交给 out/ 那份，--keep-build 保留）；
 * 3. --login：把设置里的「开机自启」打开（应用启动时登记系统登录项）；
 * 4. 打开新装的贾维斯（--no-open 跳过）。 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { APP_NAME, BUNDLE_ID, appBundlePath } = require('./pack-mac.js')
const { DATA_DIR_NAME } = require('../app-lifecycle.js')

const ROOT = path.resolve(__dirname, '..')
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function installTarget(home = os.homedir()) {
  return path.join(home, 'Applications', `${APP_NAME}.app`)
}

/** 本仓库开发版 Electron 主进程的可执行文件（node_modules 可能是软链接，取真实路径） */
function devElectronBinary(root = ROOT) {
  const binary = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  try { return fs.realpathSync(binary) } catch { return binary }
}

/** 从 `ps -axo pid=,command=` 的输出里挑出要退出的进程：本仓库的开发版 + 已装/构建出的贾维斯 */
function pidsToStop(psOutput, { devBinary, appExecutables }) {
  const pids = []
  for (const line of String(psOutput).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match) continue
    const command = match[2]
    const isDev = command === devBinary || command.startsWith(`${devBinary} `)
    const isApp = appExecutables.some(exe => command === exe || command.startsWith(`${exe} `))
    if (isDev || isApp) pids.push(Number(match[1]))
  }
  return pids
}

/** 把 settings.json 的 openAtLogin 打开（保留其它设置；文件只给本人读写） */
function enableOpenAtLogin(settingsFile) {
  let current = {}
  try { current = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) } catch { /* 首次安装没有设置文件 */ }
  const next = { ...current, openAtLogin: true }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.chmodSync(settingsFile, 0o600)
  return next
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function waitGone(pids, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pids.some(isAlive)) return true
    execFileSync('sleep', ['0.2'])
  }
  return !pids.some(isAlive)
}

function stopRunning({ source, target }) {
  const appExecutables = [source, target].map(app => path.join(app, 'Contents/MacOS', APP_NAME))
  const ps = execFileSync('ps', ['-axo', 'pid=,command=']).toString()
  const pids = pidsToStop(ps, { devBinary: devElectronBinary(), appExecutables })
  if (!pids.length) return []
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ } }
  if (!waitGone(pids)) {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    waitGone(pids, 3000)
  }
  return pids
}

function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'darwin') throw new Error('install:mac 只能在 macOS 上运行')
  const archArg = argv.find(item => item.startsWith('--arch='))
  const source = appBundlePath(archArg ? archArg.slice('--arch='.length) : process.arch)
  const target = installTarget()
  if (!fs.existsSync(source)) throw new Error(`没找到 ${source}，先运行 npm run pack:mac`)

  const stopped = stopRunning({ source, target })
  if (stopped.length) console.log(`已退出正在运行的贾维斯 / 开发版（${stopped.length} 个进程）`)

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  execFileSync('ditto', [source, target])
  try { execFileSync(LSREGISTER, ['-u', source]) } catch { /* 没登记过 */ }
  if (!argv.includes('--keep-build')) fs.rmSync(path.dirname(source), { recursive: true, force: true })
  execFileSync(LSREGISTER, ['-f', '-R', '-trusted', target])
  console.log(`已安装到 ${target}，并登记 jws:// 协议（${BUNDLE_ID}）`)

  if (argv.includes('--login')) {
    const settingsFile = path.join(os.homedir(), 'Library/Application Support', DATA_DIR_NAME, 'settings.json')
    enableOpenAtLogin(settingsFile)
    console.log('已打开「开机自启」：贾维斯启动后会登记到 系统设置 → 通用 → 登录项')
  }
  if (!argv.includes('--no-open')) {
    execFileSync('open', [target])
    console.log('已启动贾维斯。首次启动若弹出钥匙串提示「贾维斯想要使用 jws-desktop Safe Storage」，点「始终允许」即可沿用原来的登录态。')
  }
}

if (require.main === module) {
  try { main() } catch (error) { console.error(`安装失败：${error.message}`); process.exit(1) }
}

module.exports = { installTarget, devElectronBinary, pidsToStop, enableOpenAtLogin }
