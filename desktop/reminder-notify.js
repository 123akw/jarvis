/* 日程提醒系统通知：「稍后 10 分钟」「完成」两个动作 + 点击降级。本模块不 import electron，便于 node --test。
 *
 * macOS 原生通知按钮（Electron NotificationAction）要求应用已签名、且 Info.plist 的
 * NSUserNotificationAlertStyle 为 alert；开发版和未签名包不会显示按钮。所以点通知本身一律
 * 降级为「展开悬浮窗、显示提醒条」，在提醒条上同样能稍后 / 完成。Windows / Linux 只有点击。 */
'use strict'

const SNOOZE_MINUTES = 10
const ACTIONS = ['snooze', 'done']   // 与 notificationOptions 里按钮顺序一致：action 事件给的是下标
const AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

/* 日程提醒才有「稍后 / 完成」；巡检消息（id 是字符串、没有 at）只能点开看 */
function actionable(item) {
  return Boolean(item) && Number.isInteger(item.id) && item.id > 0 && AT_RE.test(String(item.at || ''))
}

function notificationOptions(item, platform) {
  const again = actionable(item) && item.at !== item.when
  const options = {
    title: again ? '贾维斯 · 再次提醒' : '贾维斯 · 日程提醒',
    body: `${String(item.when || '').slice(11)} ${item.title || ''}`.trim(),
  }
  if (platform === 'darwin' && actionable(item)) {
    options.actions = [{ type: 'button', text: `稍后 ${SNOOZE_MINUTES} 分钟` }, { type: 'button', text: '完成' }]
    options.closeButtonText = '关闭'
  }
  return options
}

/* 统一调服务端（session.js 白名单里的 reminderSnooze / reminderDone）；服务端幂等，重复点无害 */
async function actOnReminder(request, item, action) {
  if (!actionable(item) || !ACTIONS.includes(action)) return { ok: false, data: {} }
  const result = action === 'snooze'
    ? await request('reminderSnooze', { id: item.id, at: item.at, minutes: SNOOZE_MINUTES })
    : await request('reminderDone', { id: item.id, at: item.at })
  return { ok: Boolean(result && result.ok), data: (result && result.data) || {} }
}

function createReminderNotifier({ Notification, request, platform, onOpen = () => {}, onActed = () => {} }) {
  // 必须持有通知对象的引用：被 GC 回收后 click / action 回调会静默丢失（Electron 已知行为）
  const live = new Set()
  function notify(item) {
    if (!Notification || !Notification.isSupported()) return null
    const notification = new Notification(notificationOptions(item, platform))
    live.add(notification)
    const release = () => live.delete(notification)
    notification.on('action', (_event, index) => {
      release()
      const action = ACTIONS[index]
      if (!action) return
      actOnReminder(request, item, action).then(result => onActed(item, action, result)).catch(() => {})
    })
    notification.on('click', () => { release(); onOpen(item) })
    notification.on('close', release)
    notification.show()
    return notification
  }
  return { notify, liveCount: () => live.size }
}

/* 主进程 → 渲染进程的提醒条载荷：只放白名单字段，防止把服务端返回的任意结构透传过去 */
function reminderPayload(item) {
  if (!item || typeof item !== 'object') return null
  return {
    id: actionable(item) ? item.id : 0,
    at: actionable(item) ? item.at : '',
    when: String(item.when || '').slice(0, 16),
    title: String(item.title || '').slice(0, 200),
  }
}

module.exports = { SNOOZE_MINUTES, actOnReminder, actionable, createReminderNotifier, notificationOptions, reminderPayload }
