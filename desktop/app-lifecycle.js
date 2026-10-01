/* 主进程生命周期的三处边界，单独成模块便于 node --test（app/globalShortcut 全注入）。
 *
 * 1. 单实例：以前 requestSingleInstanceLock() 的返回值被丢弃，第二次启动会再起一个
 *    悬浮球并抢 17789 端口。拿不到锁就把唤起交给已在跑的实例，本进程退出。
 * 2. jws:// 协议：dev 模式（`npm start`，process.defaultApp）在 macOS 上注册的是裸
 *    Electron.app 这个 bundle，系统不会带上应用目录参数；所有 dev Electron 共用
 *    bundle id com.github.Electron，LaunchServices 还可能挑中别的项目里的 Electron，
 *    结果网页点「悬浮窗」只弹出 Electron 默认欢迎页。dev+macOS 一律不注册并清掉旧登记；
 *    Windows/Linux 的 dev 模式按官方写法带上 execPath 与应用目录。
 * 3. 退出清理：app 未 ready 就退出时（例如上面第 1 条）will-quit 照样触发，此时调用
 *    globalShortcut 会抛「cannot be used before the app is ready」并弹主进程报错框。 */
const path = require('node:path')

/** 拿单实例锁；拿到或 API 异常（保守放行）返回 true，已有实例在跑返回 false */
function claimSingleInstance(app) {
  try { return app.requestSingleInstanceLock() !== false } catch { return true }
}

/** 按运行形态登记自定义协议，返回实际采取的动作（便于测试与排障） */
function registerProtocol(app, { scheme = 'jws', platform = process.platform, defaultApp = process.defaultApp,
  execPath = process.execPath, argv = process.argv } = {}) {
  try {
    if (!defaultApp) {
      app.setAsDefaultProtocolClient(scheme)
      return 'registered'
    }
    if (platform === 'darwin') {
      app.removeAsDefaultProtocolClient(scheme)
      return 'skipped-dev-mac'
    }
    if (!argv[1]) return 'skipped-no-app-path'
    app.setAsDefaultProtocolClient(scheme, execPath, [path.resolve(argv[1])])
    return 'registered-dev'
  } catch {
    return 'failed'
  }
}

/** will-quit 清理全局快捷键：app 尚未 ready 时什么也不做 */
function releaseShortcuts(app, globalShortcut) {
  if (!app.isReady()) return false
  globalShortcut.unregisterAll()
  return true
}

module.exports = { claimSingleInstance, registerProtocol, releaseShortcuts }
