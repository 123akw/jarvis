/* 拖拽加入（第十七轮契约，见 docs/proposals/2026-10-round17-market.md；手感按 docs/design/2026-10-market-references.md §6 / 第四节）
 * 自写 Pointer Events 实现，零依赖。
 *
 * <DndRoot onAdd canAdd onReorder onRemove>：包住整个市场页（Market.jsx）
 *   onAdd(ids: string[], meta?)    拖入 Dock 后加入（套装是多个 id，已按 canAdd 过滤掉不能加的）；
 *                                  可选的第二参数 meta = { id, kind, label }（套装拖入时可据此顺手记职业）；
 *                                  工具箱里「撤销移除」也走它：meta = { id, kind: 'plugin', restore: true, index }
 *   canAdd(id) => '' | '原因'       不能加入时返回原因（需要配置 / 暂不可用 / 已在工具箱）
 *   onReorder(from, to)             工具箱内拖动排序（下标）
 *   onRemove(id)                    拖出工具箱 / 拖到删除区
 * useDragSource({ id, ids, kind, icon?, icons?, label?, disabled? }) → { dragProps, isDragging, state }
 *   插件卡 / 套装卡的根元素展开 dragProps；kind = 'plugin' | 'bundle'。
 *   dragProps 带 data-dnd="idle|pressing|dragging"（卡片样式据此写）和 data-dnd-source。
 *   icon / icons（套装药丸上扇形叠放的前 3 个）/ label 可选：不给就从卡片里找。卡片里的按钮（「+」）按下不会起拖。
 * flyToDock(fromEl, { icon })：点「+」加入时的飞入动画（reduced-motion 时什么都不做）；返回 Promise<boolean>
 * useDockDrop() → { dropProps, isOver, dragging, reason, landing, tip }：Toolbox（Dock）用；
 *   dropProps 带 id=DOCK_ID 和 data-dock="idle|ready|over|reject|landing"、data-dock-tone="ok|deny|same"。
 *
 * 手势：鼠标按下移动 ≥5px 才算拖；触摸长按 350ms 且移动 ≤8px 才拖起（之前的滑动照常滚动页面）。
 * 拖动期间视口底部 120px 整条都算 Dock 放置区。Esc / 外面松手 / pointercancel = 取消。
 * 键盘 / 读屏的替代：卡片上的「+」，工具箱抽屉里的上移 / 下移 / 移除按钮；aria-live 播报拿起、越过、放下、取消。 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { inRect, resolveAdd, say } from './engine.js'
import { EASE, EXIT, after, bump, dockTarget, findIcon, flyFrom, hostFor, iconsOf, labelOf, makeGhost, play, reducedMotion } from './motion.js'
import { beginGesture, retainTouchGuard } from './pointer.js'
import './dnd.css'

export const DOCK_ID = 'jvm-dock-drop'

const DndCtx = createContext(null)
const IDLE = { drag: null, over: false, pressing: '', settling: '', landing: null, tip: null }
const noopSubscribe = () => () => {}
const idle = () => IDLE
const preventNativeDrag = e => e.preventDefault()   // 卡片里的链接 / 图片不走浏览器原生拖拽
const TIP_KEY = 'jvm-dnd-tip'
const TIP_TEXT = '把卡片拖到这里，或点 +'

function createStore() {
  let state = IDLE
  const subs = new Set()
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch }
      subs.forEach(fn => fn())
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

const getDock = () => (typeof document === 'undefined' ? null : document.getElementById(DOCK_ID))
const vibrate = p => { try { navigator.vibrate?.(p) } catch { /* 不支持就算了 */ } }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const DOCK_ZONE = 120  // 拖动期间视口底部这么高的一整条都算放置区
const DOCK_PAD = 12    // Dock 本身外沿再放宽一点
const INSET = 8        // 药丸内边距：图标对齐原卡片图标时要扣掉
const center = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })

/** 一次「卡片 → Dock」的拖动 */
function dragCard({ e, token, src, store, props, announce }) {
  const el = e.currentTarget
  const s = {}
  const place = (x, y) => {
    s.px = x - s.ax
    s.py = y - s.ay
    s.ghost.root.style.transform = `translate3d(${s.px}px, ${s.py}px, 0)`
    if (s.still) return
    // 在固定的 2° 倾斜上，按横向速度再微微摆一点（像拎起一张卡片）
    s.vx = s.vx * 0.7 + (x - s.lastX) * 0.3
    s.lastX = x
    s.ghost.card.style.setProperty('--jvd-tilt', `${clamp(s.vx * 0.35, -3, 3).toFixed(2)}deg`)
  }
  const overDock = (x, y) => {
    const dock = getDock()
    if (!dock) return false
    return y >= window.innerHeight - DOCK_ZONE || inRect(x, y, dock.getBoundingClientRect(), DOCK_PAD)
  }
  const setBadge = over => {
    const { ghost, r, kind } = s
    const n = kind === 'bundle' ? r.ids.length : 0
    ghost.badge.textContent = over ? (r.tone === 'ok' ? (n ? `+${n}` : '+') : '⦸') : (n ? String(n) : '')
    ghost.badge.dataset.tone = over ? r.tone : ''
  }
  const settle = () => {
    s.ghost.root.remove()
    if (store.get().settling === token) store.set({ settling: '' })
  }

  /** 放下：Dock 先撑开空位，药丸 240ms 缩成 32px 落进去，然后才真正加入、计数跳一下 */
  function land(dock) {
    const { ghost, r, label, kind } = s
    flushSync(() => store.set({ drag: null, over: false, landing: { token, icon: s.icon } }))
    const t = dockTarget(dock)
    const face = ghost.face.getBoundingClientRect()
    const c = center(face)
    const k = face.width ? 32 / face.width : 0.8
    ghost.root.style.transformOrigin = `${(c.x - s.px).toFixed(1)}px ${(c.y - s.py).toFixed(1)}px`
    const w = ghost.card.offsetWidth
    const p = play(ghost.root, [
      { transform: `translate3d(${s.px}px, ${s.py}px, 0)` },
      { transform: `translate3d(${s.px + t.x - c.x}px, ${s.py + t.y - c.y}px, 0) scale(${k.toFixed(3)})` },
    ], { duration: 240, easing: EASE })
    if (w) {
      play(ghost.card, [
        { clipPath: 'inset(0px 0px 0px 0px round 16px)' },
        { clipPath: `inset(${INSET}px ${w - INSET - 40}px ${INSET}px ${INSET}px round 12px)` },
      ], { duration: 240, easing: EASE })
    }
    after(p, () => {
      flushSync(() => props.current.onAdd?.(r.ids, { id: src.id, kind, label }))
      store.set({ landing: null })
      ghost.root.remove()
      bump(getDock())
    })
  }

  /** 取消 / 拒绝：药丸 250ms 回到原卡位置；原卡已滚出视口就原地放大 1.1 淡出（「蒸发」） */
  function goHome(rejected) {
    const { ghost, r, label } = s
    announce(rejected ? say.rejected(label, r.reason, r.tone) : say.cancelled(label))
    store.set({ drag: null, over: false, settling: token, ...(rejected ? { tip: { text: r.reason, tone: r.tone, n: Date.now() } } : {}) })
    const home = el.isConnected ? (findIcon(el) || el).getBoundingClientRect() : null
    const seen = home && home.width && home.bottom > 0 && home.top < window.innerHeight && home.right > 0 && home.left < window.innerWidth
    const cur = `translate3d(${s.px}px, ${s.py}px, 0)`
    let p
    if (seen) {
      const a = center(ghost.face.getBoundingClientRect())
      const b = center(home)
      p = play(ghost.root, [{ transform: cur }, { transform: `translate3d(${s.px + b.x - a.x}px, ${s.py + b.y - a.y}px, 0)` }],
        { duration: 250, easing: 'ease' })
      play(ghost.lift, [{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: 250 })
    } else {
      p = play(ghost.root, [{ transform: `${cur} scale(1)`, opacity: 1 }, { transform: `${cur} scale(1.1)`, opacity: 0 }], { duration: 200, easing: EXIT })
    }
    after(p, settle)
  }

  function finish(over) {
    document.body.classList.remove('jvd-dragging')
    const dock = getDock()
    if (over && s.r.tone === 'ok' && dock) land(dock)
    else {
      s.ghost.root.classList.remove('is-over')
      goHome(over)
    }
  }

  return beginGesture(e, {
    el,
    ignore: 'button,[role="button"],input,select,textarea',
    onPress: () => store.set({ pressing: token }),
    onRelease: () => { if (store.get().pressing === token) store.set({ pressing: '' }) },
    onStart({ x, y, startX, startY, pointerType }) {
      const dock = getDock()
      if (!dock || !el.isConnected) return false
      const kind = src.kind === 'bundle' ? 'bundle' : 'plugin'
      const all = Array.isArray(src.ids) && src.ids.length ? src.ids : [src.id]
      const r = resolveAdd(all, props.current.canAdd, kind)
      const label = src.label || labelOf(el)
      const iconEl = findIcon(el)
      const icon = src.icon || iconEl?.textContent?.trim() || '🧩'
      const icons = kind === 'bundle' ? (src.icons?.length ? src.icons : iconsOf(el)).slice(0, 3) : []
      const box = el.getBoundingClientRect()
      const from = (iconEl || el).getBoundingClientRect()
      const ghost = makeGhost({ icon, icons, label, tone: r.tone, sub: kind === 'bundle' ? `${all.length} 个插件` : '' })
      hostFor().appendChild(ghost.root)
      const gw = ghost.card.offsetWidth || 200
      const gh = ghost.card.offsetHeight || 56
      const touch = pointerType === 'touch'
      // 按住点在卡片上的相对位置，按比例映射到药丸上；触摸时药丸浮在手指上方，不被手指挡住
      const fx = box.width ? clamp((startX - box.left) / box.width, 0.08, 0.92) : 0.5
      const fy = box.height ? clamp((startY - box.top) / box.height, 0.15, 0.85) : 0.5
      Object.assign(s, {
        ghost, r, label, icon, kind, still: reducedMotion(), touch, vx: 0, lastX: x, over: false,
        ax: fx * gw, ay: touch ? gh + 16 : fy * gh,
      })
      place(x, y)
      setBadge(false)
      // 药丸从原卡图标处浮起（120ms）
      play(ghost.lift, [
        { transform: `translate(${(from.left - INSET - s.px).toFixed(1)}px, ${(from.top - INSET - s.py).toFixed(1)}px) scale(.96)`, opacity: 0.6 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      ], { duration: 120, easing: EASE, fill: 'none' })
      document.body.classList.add('jvd-dragging')
      store.set({ drag: { token, id: src.id, ids: r.ids, all, kind, label, icon, tone: r.tone, reason: r.reason }, over: false, pressing: '', settling: '', tip: null })
      announce(say.picked(label))
      if (touch) vibrate(10)
      return true
    },
    onMove({ x, y }) {
      place(x, y)
      const over = overDock(x, y)
      if (over === s.over) return
      s.over = over
      s.ghost.root.classList.toggle('is-over', over)
      setBadge(over)
      store.set({ over })
      if (over) {
        announce(s.r.tone === 'ok' ? say.overOk() : say.overReject(s.r.reason))
        if (s.touch) vibrate(s.r.tone === 'ok' ? 6 : [8, 40, 8])
      }
    },
    onEnd({ x, y }) { finish(overDock(x, y)) },
    onCancel() { finish(false) },
  })
}

export function DndRoot({ onAdd, canAdd, onReorder, onRemove, children }) {
  const props = useRef({})
  props.current = { onAdd, canAdd, onReorder, onRemove }
  const [store] = useState(createStore)
  const [news, setNews] = useState({ text: '', n: 0 })
  const announce = useCallback(text => setNews(v => ({ text, n: v.n + 1 })), [])
  const tipSeen = useRef(null)
  useEffect(() => retainTouchGuard(), [])
  useEffect(() => () => document.body.classList.remove('jvd-dragging'), [])
  const start = useCallback((e, token, src) => dragCard({ e, token, src, store, props, announce }), [store, announce])
  // 第一次用鼠标悬停到卡片上时，在 Dock 上方提示一次「把卡片拖到这里，或点 +」（记在 localStorage）
  const hint = useCallback(e => {
    if (e.pointerType !== 'mouse' || store.get().drag) return
    if (tipSeen.current === null) {
      try { tipSeen.current = !!window.localStorage?.getItem(TIP_KEY) } catch { tipSeen.current = false }
    }
    if (tipSeen.current) return
    tipSeen.current = true
    try { window.localStorage?.setItem(TIP_KEY, '1') } catch { /* 存不了就只提示这一次 */ }
    store.set({ tip: { text: TIP_TEXT, tone: 'info', n: Date.now() } })
  }, [store])
  const value = useMemo(() => ({ store, start, announce, props, hint }), [store, start, announce, hint])
  return (
    <DndCtx.Provider value={value}>
      {children}
      <p className="sr-only jvd-live" aria-live="polite" aria-atomic="true"><span key={news.n}>{news.text}</span></p>
    </DndCtx.Provider>
  )
}

export function useDragSource({ id, ids, kind = 'plugin', icon, icons, label, disabled = false } = {}) {
  const ctx = useContext(DndCtx)
  const token = useId()
  const src = useRef(null)
  src.current = { id, ids, kind, icon, icons, label }
  const store = ctx?.store
  const state = useSyncExternalStore(store ? store.subscribe : noopSubscribe, () => {
    const st = store?.get()
    if (!st) return 'idle'
    if (st.drag?.token === token || st.settling === token || st.landing?.token === token) return 'dragging'
    return st.pressing === token ? 'pressing' : 'idle'
  }, () => 'idle')
  const start = ctx?.start
  const hint = ctx?.hint
  const onPointerDown = useCallback(e => { if (!disabled) start?.(e, token, src.current) }, [start, token, disabled])
  if (!ctx) return { dragProps: {}, isDragging: false, state: 'idle' }
  return {
    dragProps: {
      onPointerDown,
      onPointerEnter: disabled ? undefined : hint,
      onDragStart: preventNativeDrag,
      'data-dnd-source': kind === 'bundle' ? 'bundle' : 'plugin',
      'data-dnd': state,
    },
    isDragging: state === 'dragging',
    state,
  }
}

export function flyToDock(fromEl, { icon } = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false)
  return flyFrom(fromEl, getDock(), { icon })
}

/** Dock 的放置区：dropProps 展开到 Dock 的玻璃条上（带 id，命中判定和飞入都靠它） */
export function useDockDrop() {
  const ctx = useContext(DndCtx)
  const store = ctx?.store
  const st = useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.get : idle, idle)
  const drag = st.drag
  const over = !!(drag && st.over)
  const state = drag ? (over ? (drag.tone === 'ok' ? 'over' : 'reject') : 'ready') : st.landing ? 'landing' : 'idle'
  return {
    dropProps: { id: DOCK_ID, 'data-dock': state, 'data-dock-tone': drag ? drag.tone : undefined },
    isOver: over,
    dragging: drag,
    reason: drag?.reason || '',
    landing: st.landing,
    tip: st.tip,
  }
}

/** 工具箱用：DndRoot 上的回调（没有包 DndRoot 时都是 null） */
export function useDndActions() {
  const ctx = useContext(DndCtx)
  return useMemo(() => {
    const pick = name => () => (ctx?.props.current[name] ? (...a) => ctx.props.current[name](...a) : null)
    return { add: pick('onAdd'), reorder: pick('onReorder'), remove: pick('onRemove') }
  }, [ctx])
}

export { useSortableList } from './sortable.js'
