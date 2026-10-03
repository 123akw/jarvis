/* 新手引导的调度（第十八轮）：同一时刻只播一个；自动开始要等进场动画结束；记录看过没。
 *
 *  active = { id, mode: 'auto' | 'manual', key }   正在播的引导（引导层按它渲染）
 *  queue  = [id]                                   等着自动开始的（进场动画还在播 / 另一个引导正在播）
 *
 *  - 自动开始（useTour）：该账号没看过、这次打开页面还没自动播过 → 排队，轮到且进场动画已结束就开始；
 *  - 手动开始（startTour / TourButton / 菜单）：立刻开始（打断正在播的那个，被打断的不记录）；
 *  - 结束：看完记 done、点跳过记 skipped（自动播的才记；手动重看不改已有记录，没记录时也记上）；
 *    「目标都找不到」「页面卸载」只是收起，不记录（下次照样会自动出现）。 */
import { INTRO_DONE_EVENT, introPlaying } from '../intro/registry.js'
import { hasSeen, loadSeen, markSeen } from './store.js'
import { TOURS } from './tours.js'

const INTRO_SETTLE_MS = 480   // 进场动画收尾淡出约 420ms：等它退干净再压暗页面

let active = null
let seq = 0
let queue = []
const listeners = new Set()
const autoTried = new Set()
const pages = new Map()       // 已挂载的 useTour：id → 次数（「重看本页」用最后挂上的那个）
let pageOrder = []
let introWait = null

function emit() {
  listeners.forEach(fn => { try { fn(active) } catch { /* 订阅者自己兜底 */ } })
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const getActive = () => active

function waitForIntro() {
  if (introWait || typeof window === 'undefined') return
  const onDone = () => {
    window.removeEventListener(INTRO_DONE_EVENT, onDone)
    clearInterval(poll)
    introWait = setTimeout(() => { introWait = null; pump() }, INTRO_SETTLE_MS)
  }
  // 兜底：万一没收到事件（进场层异常卸载），轮询 introPlaying()
  const poll = setInterval(() => { if (!introPlaying()) onDone() }, 1000)
  window.addEventListener(INTRO_DONE_EVENT, onDone)
  introWait = { cancel: () => { window.removeEventListener(INTRO_DONE_EVENT, onDone); clearInterval(poll) } }
}

/** 轮到下一个排队的自动引导 */
function pump() {
  if (active || !queue.length) return
  if (introPlaying() || introWait) { waitForIntro(); return }
  while (queue.length) {
    const id = queue.shift()
    if (!pages.has(id) || hasSeen(id)) continue   // 页面已经离开 / 期间已经看过
    active = { id, mode: 'auto', key: ++seq }
    emit()
    return
  }
}

/** 立即开始某个引导（重看）。auto=true 是 useTour 内部用的「排队自动开始」。返回是否已经开始。 */
export function startTour(id, { auto = false } = {}) {
  if (!TOURS[id]) return false
  if (active?.id === id) return true
  if (auto) {
    if (!queue.includes(id)) queue.push(id)
    pump()
    return active?.id === id
  }
  queue = queue.filter(x => x !== id)
  active = { id, mode: 'manual', key: ++seq }
  emit()
  return true
}

/** 引导层调用：status = 'done' | 'skipped' 记录；'closed'（找不到目标、页面卸载）只收起 */
export function endTour(status = 'closed', key = active?.key) {
  const cur = active
  if (!cur || cur.key !== key) return
  active = null
  if (status === 'done' || status === 'skipped') {
    if (cur.mode === 'auto' || !hasSeen(cur.id)) markSeen(cur.id, status)
  }
  emit()
  pump()
}

/** useTour 的自动开始：没看过才排队；同一引导这次打开页面只自动播一次 */
export function requestAuto(id) {
  if (!TOURS[id] || autoTried.has(id)) return () => {}
  let alive = true
  loadSeen().then(seen => {
    if (!alive || seen[id] || autoTried.has(id) || !pages.has(id)) return
    autoTried.add(id)
    startTour(id, { auto: true })
  }).catch(() => {})
  return () => {
    alive = false
    queue = queue.filter(x => x !== id)
  }
}

/** useTour 挂载时登记「本页有这个引导」；卸载时若它正在播就收起 */
export function registerPage(id) {
  pages.set(id, (pages.get(id) || 0) + 1)
  pageOrder = [...pageOrder.filter(x => x !== id), id]
  return () => {
    const n = (pages.get(id) || 1) - 1
    if (n > 0) { pages.set(id, n); return }
    pages.delete(id)
    pageOrder = pageOrder.filter(x => x !== id)
    queue = queue.filter(x => x !== id)
    if (active?.id === id) endTour('closed')
  }
}

/** 当前页面的引导（账号菜单 / ⌘K「重看本页」用）；没有登记过就返回 '' */
export function currentPageTour() {
  return pageOrder[pageOrder.length - 1] || ''
}

/** 重置所有引导后：这次打开页面里也允许再自动播 */
export function forgetAutoTried() {
  autoTried.clear()
}

/** 测试用：回到初始状态 */
export function _resetController() {
  active = null
  queue = []
  autoTried.clear()
  pages.clear()
  pageOrder = []
  if (introWait) {
    if (typeof introWait.cancel === 'function') introWait.cancel()
    else clearTimeout(introWait)
  }
  introWait = null
  emit()
}
