#!/usr/bin/env node
/* 打包 macOS 版「贾维斯.app」：npm run pack:mac [-- --arch=x64]
 *
 * - @electron/packager 出 .app（默认本机架构，Apple Silicon 即 arm64），产物在 desktop/out/（已 gitignore）；
 * - Info.plist 声明 jws:// 协议（CFBundleURLTypes）、显示名「贾维斯」、bundle id cn.gkgeek.jws；
 * - 改完 Info.plist 整包 ad-hoc 重签（codesign --force --deep -s -），Apple Silicon 双击即可打开；
 *   设了 JWS_SIGN_IDENTITY 就改用该证书签（签名稳定，钥匙串「始终允许」在重新打包后仍有效）；
 * - 优先复用 ~/Library/Caches/electron 里已下载的 Electron 安装包，不重复下载。
 * package.json 不能加 productName：用户数据目录与钥匙串密钥都按 name（jws-desktop）找，见 app-lifecycle.js。 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const APP_NAME = '贾维斯'
const BUNDLE_ID = 'cn.gkgeek.jws'
const OUT_DIR = path.join(ROOT, 'out')

/** 产物路径：desktop/out/贾维斯-darwin-arm64/贾维斯.app */
function appBundlePath(arch = process.arch, outDir = OUT_DIR) {
  return path.join(outDir, `${APP_NAME}-darwin-${arch}`, `${APP_NAME}.app`)
}

/** 在 Electron 下载缓存里找对应版本的安装包目录（找不到返回 ''，交给 packager 自己下载） */
function findCachedElectronZipDir({ version, arch, cacheRoot = path.join(os.homedir(), 'Library/Caches/electron'), fsImpl = fs } = {}) {
  const zip = `electron-v${version}-darwin-${arch}.zip`
  let entries = []
  try { entries = fsImpl.readdirSync(cacheRoot) } catch { return '' }
  for (const entry of entries) {
    const dir = path.join(cacheRoot, entry)
    if (fsImpl.existsSync(path.join(dir, zip))) return dir
  }
  return fsImpl.existsSync(path.join(cacheRoot, zip)) ? cacheRoot : ''
}

/** 交给 @electron/packager 的选项（纯函数，便于测试） */
function macPackOptions({ arch = process.arch, electronVersion, appVersion, electronZipDir = '', root = ROOT, outDir = OUT_DIR } = {}) {
  return {
    dir: root,
    out: outDir,
    overwrite: true,
    platform: 'darwin',
    arch,
    name: APP_NAME,
    appBundleId: BUNDLE_ID,
    helperBundleId: `${BUNDLE_ID}.helper`,
    appCategoryType: 'public.app-category.productivity',
    appVersion,
    electronVersion,
    ...(electronZipDir ? { electronZipDir } : {}),
    asar: false,          // 主进程按 __dirname 找 index.html / preload，保持普通目录最省心
    prune: true,          // 去掉 devDependencies（electron、packager 本身）
    protocols: [{ name: '贾维斯网页唤起', schemes: ['jws'] }],
    extendInfo: {
      CFBundleDisplayName: APP_NAME,
      NSMicrophoneUsageDescription: '贾维斯需要麦克风来进行语音对话、唤醒词和会议纪要。',
      NSAudioCaptureUsageDescription: '会议纪要需要录制系统里对方的声音。',
    },
    ignore: [
      /^\/out($|\/)/,
      /^\/tools($|\/)/,
      /\.test\.js$/,
      /(^|\/)\.DS_Store$/,
    ],
  }
}

function readVersions(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
  const electronPkg = JSON.parse(fs.readFileSync(require.resolve('electron/package.json', { paths: [root] }), 'utf-8'))
  return { appVersion: pkg.version, electronVersion: electronPkg.version }
}

async function loadPackager() {
  const paths = [ROOT, ...(process.env.JWS_PACKAGER_DIR ? [process.env.JWS_PACKAGER_DIR] : [])]
  let resolved
  try {
    resolved = require.resolve('@electron/packager', { paths })
  } catch {
    throw new Error('找不到 @electron/packager：先在 desktop/ 下执行 npm install（国内可加 --registry=https://registry.npmmirror.com）')
  }
  const mod = await import(pathToFileURL(resolved).href)
  return mod.packager || mod.default
}

function sign(appPath, identity = process.env.JWS_SIGN_IDENTITY || '-') {
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}

function plistValue(appPath, key) {
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')]).toString().trim()
}

async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'darwin') throw new Error('pack:mac 只能在 macOS 上运行')
  const archArg = argv.find(item => item.startsWith('--arch='))
  const arch = archArg ? archArg.slice('--arch='.length) : process.arch
  const { appVersion, electronVersion } = readVersions()
  const electronZipDir = findCachedElectronZipDir({ version: electronVersion, arch })
  console.log(`打包 ${APP_NAME}.app（Electron ${electronVersion}，${arch}）${electronZipDir ? '，复用本机 Electron 缓存' : '，需要下载 Electron'}`)
  const packager = await loadPackager()
  await packager(macPackOptions({ arch, electronVersion, appVersion, electronZipDir }))
  const appPath = appBundlePath(arch)
  sign(appPath)
  const scheme = plistValue(appPath, 'CFBundleURLTypes.0.CFBundleURLSchemes.0')
  const bundleId = plistValue(appPath, 'CFBundleIdentifier')
  if (scheme !== 'jws' || bundleId !== BUNDLE_ID) throw new Error(`Info.plist 不对：scheme=${scheme} bundleId=${bundleId}`)
  console.log(`完成：${appPath}\n  bundle id ${bundleId}，已声明 jws:// 协议，已签名（${process.env.JWS_SIGN_IDENTITY ? '指定证书' : 'ad-hoc'}）`)
  console.log('下一步：npm run install:mac（装到 ~/Applications 并注册协议；加 -- --login 同时开启开机自启）')
  return appPath
}

if (require.main === module) {
  main().catch(error => { console.error(`打包失败：${error.message}`); process.exit(1) })
}

module.exports = { APP_NAME, BUNDLE_ID, OUT_DIR, appBundlePath, findCachedElectronZipDir, macPackOptions }
