/* 统一的指针手势：按下 → 判定是不是拖动 → 跟手 → 松手 / 取消。插件卡拖入和工具箱排序共用。
 *  - 鼠标 / 笔：移动 ≥ threshold（默认 5px）才开始，之前都算点击；
 *  - 触摸：按住 delay（默认 350ms）且移动不超过 tolerance（8px）才拖起；这之前移动超过 8px 就交还给浏览器滚动；
 *    起拖后拦掉 touchmove，页面不再跟着滚；
 *  - 抓手（mode = 'handle'，元素自带 touch-action:none）：触摸也按阈值立即开始，不用长按；
 *  - 拖动中 Esc / pointercancel / 窗口失焦 = 取消；松手后吞掉紧随其后的那次 click（不会误开详情）。 */

let current = null          // 同一时间只跑一个手势（多指时后来的不理）
let guards = 0
const IGNORE = 'input,textarea,select,option,[contenteditable=""],[contenteditable="true"],[data-dnd-ignore]'

const guard = e => { if (current?.active && e.cancelable) e.preventDefault() }

/** iOS Safari 只认 touchstart 之前就挂好的非被动 touchmove 监听：挂载期间常驻一个（只在拖动中才真的拦） */
export function retainTouchGuard() {
  if (typeof window === 'undefined') return () => {}
  if (guards++ === 0) window.addEventListener('touchmove', guard, { passive: false })
  let released = false
  return () => {
    if (released) return
    released = true
    if (--guards === 0) window.removeEventListener('touchmove', guard, { passive: false })
  }
}

export const gestureActive = () => !!current?.active

/** 松手后吞掉紧随其后、落在拖拽源（或其祖先，指针捕获失效时 click 落在公共祖先上）的那次 click：
 *  鼠标的 click 和 pointerup 在同一个任务里，下一拍就撤；触摸留得久一点 */
function swallowClick(el, touch) {
  const stop = ev => {
    const t = ev.target
    if (el && t && t.nodeType === 1 && !(el === t || el.contains(t) || t.contains(el))) return
    ev.preventDefault()
    ev.stopPropagation()
    ev.stopImmediatePropagation?.()
    window.removeEventListener('click', stop, true)
  }
  window.addEventListener('click', stop, true)
  setTimeout(() => window.removeEventListener('click', stop, true), touch ? 350 : 0)
}

/**
 * 在 pointerdown 里调用。返回 true 表示开始跟踪（仍可能因为没达到阈值而只是一次点击）。
 * onStart 返回 false = 这次不拖（比如页面上没有工具箱），之后的点击照常。
 */
export function beginGesture(e, {
  el, mode = 'auto', threshold = 5, delay = 350, tolerance = 8, ignore = '',
  onPress, onRelease, onStart, onMove, onEnd, onCancel,
} = {}) {
  if (current || !e) return false
  const type = e.pointerType || 'mouse'
  if (type === 'mouse' && e.button !== 0) return false
  if (e.isPrimary === false) return false
  if (e.target?.closest?.(IGNORE)) return false
  // 卡片里的按钮（「+」、套装里的小图标）按下去不拖：它们各有各的点击
  if (ignore && e.target !== el && e.target?.closest?.(ignore) && el?.contains(e.target.closest(ignore))) return false
  const longPress = type === 'touch' && mode !== 'handle'
  const g = { id: e.pointerId, type, active: false, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, timer: 0 }
  current = g

  function cleanup() {
    clearTimeout(g.timer)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('contextmenu', menu, true)
    window.removeEventListener('blur', blur)
    if (current === g) current = null
    onRelease?.()
  }
  function activate() {
    if (g.active || current !== g) return
    let ok
    try {
      ok = onStart?.({ x: g.x, y: g.y, startX: g.startX, startY: g.startY, pointerType: type })
    } catch (err) {
      cleanup()
      throw err
    }
    if (ok === false) { cleanup(); return }
    g.active = true
    if (type !== 'touch') { try { el?.setPointerCapture?.(g.id) } catch { /* 元素已不在页面上：靠 window 监听也收得到 */ } }
    try { window.getSelection?.()?.removeAllRanges?.() } catch { /* 无所谓 */ }
  }
  function move(ev) {
    if (ev.pointerId !== g.id) return
    g.x = ev.clientX
    g.y = ev.clientY
    if (g.active) {
      if (ev.cancelable) ev.preventDefault()
      onMove?.({ x: g.x, y: g.y })
      return
    }
    const d = Math.hypot(g.x - g.startX, g.y - g.startY)
    if (longPress) {
      if (d > tolerance) cleanup()          // 长按之前就动了：在滚动页面，放弃
      return
    }
    if (d >= threshold) {
      activate()
      if (g.active) onMove?.({ x: g.x, y: g.y })
    }
  }
  function up(ev) {
    if (ev.pointerId !== g.id) return
    const was = g.active
    cleanup()
    if (!was) return
    swallowClick(el, type === 'touch')
    onEnd?.({ x: ev.clientX, y: ev.clientY })
  }
  function cancel(ev) {
    if (ev && ev.pointerId !== undefined && ev.pointerId !== g.id) return
    const was = g.active
    cleanup()
    if (was) onCancel?.()
  }
  function key(ev) {
    if (ev.key !== 'Escape' || !g.active) return
    ev.preventDefault()
    ev.stopImmediatePropagation()           // 只取消拖动，不连带关掉抽屉
    cancel()
  }
  function menu(ev) { if (g.active || longPress) ev.preventDefault() }   // 长按不弹系统菜单
  function blur() { cancel() }

  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('keydown', key, true)
  window.addEventListener('contextmenu', menu, true)
  window.addEventListener('blur', blur)
  onPress?.(type)
  if (longPress) g.timer = setTimeout(activate, delay)
  return true
}
