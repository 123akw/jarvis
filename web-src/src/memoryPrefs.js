/** 「显示记忆回执」总开关的前端共享状态：对话区读、记忆面板写、今日板加载时从服务端同步。
 *  缺省开启；服务端读不到时保持开启（宁可多一行回执，也不要让用户以为没记住）。 */
import { onAccountChange } from './accountStorage.js'

let receipts = true
const listeners = new Set()

export function subscribeReceipts(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function receiptsOn() {
  return receipts
}

export function setReceipts(on) {
  const next = on !== false
  if (next === receipts) return
  receipts = next
  listeners.forEach(fn => fn())
}

// 换号：上个账号的开关不带给下一个账号，回到缺省开启，等今日板从服务端同步本账号的设置
onAccountChange(() => setReceipts(true))
