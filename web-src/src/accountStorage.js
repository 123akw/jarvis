/* 按账号区分的本地存储（第十四轮）。
 *
 * 浏览器本地记住的东西分两类：
 *  - 某个账号的数据：上次打开的会话（jws_thread）、今日简报「今天不再显示」（jws_brief_hide）、
 *    弱口令提醒「稍后」（jws_weak_pw_dismissed，sessionStorage）——键名带用户名，换号互不串；
 *  - 纯界面偏好：主题（jws_theme）、侧栏 / 今日板折叠（jws_sidebar / jws_today）、进场动画——所有账号共用。
 *
 * 当前账号由 App（拿到 /api/session 后）或 Hud 设置；换号时通知订阅者把内存里的账号状态
 * （如「显示记忆回执」开关）复位。上一版不分账号的旧键：App 启动时若浏览器正登着某个账号，
 * 旧键就是它写的，迁到它名下；没登录则无从判断归属，直接丢掉。读写一律 try/catch（隐私模式等）。 */

export const ACCOUNT_KEYS = {
  thread: 'jws_thread',
  briefHide: 'jws_brief_hide',
  weakDismissed: 'jws_weak_pw_dismissed',
}
const SESSION_KEYS = new Set([ACCOUNT_KEYS.weakDismissed])

let current = ''
const listeners = new Set()

const norm = name => String(name || '').trim().toLowerCase()   // 用户名不分大小写（服务端 COLLATE NOCASE）

function storeFor(base) {
  try { return SESSION_KEYS.has(base) ? window.sessionStorage : window.localStorage } catch { return null }
}

export function currentAccount() {
  return current
}

/** 设置当前账号；与之前不同则通知订阅者复位账号相关的内存状态。
 *  会在渲染途中调用（子组件首帧就要读对账号的键），所以通知放到微任务里，不在渲染中触发别的组件更新。 */
export function setCurrentAccount(username) {
  const next = norm(username)
  if (next === current) return
  current = next
  const notify = () => listeners.forEach(fn => { try { fn(next) } catch { /* 订阅者自己兜底 */ } })
  if (typeof queueMicrotask === 'function') queueMicrotask(notify)
  else Promise.resolve().then(notify)
}

export function onAccountChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 某个账号名下的键：jws_thread:alice；没有账号（单独渲染组件的测试等）时就是原键 */
export function accountKey(base, username = current) {
  const who = norm(username)
  return who ? `${base}:${who}` : base
}

export function readAccount(base, username = current) {
  try { return storeFor(base)?.getItem(accountKey(base, username)) ?? null } catch { return null }
}

export function writeAccount(base, value, username = current) {
  try { storeFor(base)?.setItem(accountKey(base, username), String(value)) } catch { /* 写不进只影响本次 */ }
}

/** 上一版的不分账号旧键：有 username 就迁给它（它名下已有值则不覆盖），然后删掉旧键 */
export function migrateLegacy(username) {
  const who = norm(username)
  for (const base of Object.values(ACCOUNT_KEYS)) {
    try {
      const store = storeFor(base)
      const old = store?.getItem(base)
      if (old === null || old === undefined) continue
      if (who && store.getItem(accountKey(base, who)) === null) store.setItem(accountKey(base, who), old)
      store.removeItem(base)
    } catch { /* 存储不可用：什么也不做 */ }
  }
}
