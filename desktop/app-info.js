/* 版本自证与重启：悬浮窗常驻不退出，代码更新后旧进程会无声地跑旧版——
 * 设置页显示 git 短 hash + 启动时间让「跑的是哪版」可见，托盘「重启」一键换代。
 * 纯逻辑、依赖注入，node --test 可直跑。 */

/** 启动时算一次：git 短 hash（无 .git 或打包后退回 package.json 版本号）+ 启动时刻 */
function buildAppInfo({ execSync, dirname, version, startedAt }) {
  let hash = ''
  try {
    hash = execSync('git rev-parse --short HEAD',
      { cwd: dirname, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch { /* 打包环境没有 git，走版本号回退 */ }
  const t = new Date(startedAt)
  const pad = n => String(n).padStart(2, '0')
  return {
    hash: hash || `v${version}`,
    startedAt: `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`,
  }
}

/** 托盘「重启贾维斯」：先注册重启再退出，顺序反了就只退不启 */
function restartApp(app) {
  app.relaunch()
  app.exit(0)
}

module.exports = { buildAppInfo, restartApp }
