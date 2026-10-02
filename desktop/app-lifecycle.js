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
 *    globalShortcut 会抛「cannot be used before the app is ready」并弹主进程报错框。
 * 4. 打包版「贾维斯.app」与开发版共用用户数据目录（登录令牌、设置、单实例锁），
 *    冷启动时 jws:// 可能早于 ready 到达，先排队、窗口建好再处理；开机自启按运行形态选实现。 */
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

/* 用户数据目录名＝package.json 的 name。打包版（CFBundleName「贾维斯」）与 `npm start` 都落在
 * ~/Library/Application Support/jws-desktop：登录令牌密文、settings.json、单实例锁共用；
 * 钥匙串里的加密密钥也按这个名字（「jws-desktop Safe Storage」）找，所以 package.json
 * 不能加 productName，否则打包版读不出开发版保存的登录态。 */
const DATA_DIR_NAME = 'jws-desktop'

function sharedUserDataPath(app) {
  return path.join(app.getPath('appData'), DATA_DIR_NAME)
}

/** argv 里的 jws:// 链接（Windows/Linux 冷启动与 second-instance 都经 argv 带进来） */
function protocolLinkFromArgv(argv) {
  return (Array.isArray(argv) ? argv : []).find(item => typeof item === 'string' && item.startsWith('jws://')) || ''
}

/** jws:// 收件箱：macOS 冷启动时 open-url 常在 ready 之前到达（窗口、会话网关都还没有），
 *  先排队，open() 之后按到达顺序处理；之后到达的直接处理。处理出错不影响后续。 */
function createProtocolInbox(handle, { limit = 5 } = {}) {
  let opened = false
  const queue = []
  function run(url) { try { handle(url) } catch { /* 单条失败不影响其它 */ } }
  return {
    receive(url) {
      if (typeof url !== 'string' || !url) return
      if (opened) run(url)
      else if (queue.length < limit) queue.push(url)
    },
    open() {
      opened = true
      for (const url of queue.splice(0)) run(url)
    },
    pending: () => queue.length,
  }
}

/** 开机自启的实现：打包版 macOS 用系统登录项（系统设置 → 通用 → 登录项里显示「贾维斯」）；
 *  开发版 macOS 用 LaunchAgent（裸 Electron 登记成登录项只会打开欢迎页）；Windows 用系统登录项。 */
function autoLaunchMode({ platform = process.platform, packaged = false } = {}) {
  if (platform === 'win32') return packaged ? 'login-item' : 'login-item-dev'
  if (platform !== 'darwin') return 'unsupported'
  return packaged ? 'login-item' : 'launch-agent'
}

module.exports = {
  claimSingleInstance, registerProtocol, releaseShortcuts,
  DATA_DIR_NAME, sharedUserDataPath, protocolLinkFromArgv, createProtocolInbox, autoLaunchMode,
}
