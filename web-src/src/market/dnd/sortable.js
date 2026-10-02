/* 工具箱抽屉里的拖动排序 + 拖出移除（Linear / iOS 编辑列表 / macOS Dock 的手感）：
 *  - 拎起的那一行变成跟手的拖影，原位留一个虚线空位；其他行用 transform 让位（200ms ease，不触发重排）；
 *  - 松手：拖影滑进空位后才真正换顺序（flushSync 提交后同一帧清掉位移，不闪）；
 *  - 拖出抽屉面板或拖到删除区 = 移除：后面的行补上空位，拖影半透明并标「松手移除」，松手缩到 .6 淡出（160ms）；
 *  - 列表能滚时，拖到上下边缘自动滚动（最快 12px/帧）；Esc 取消。
 *  播报 / 撤销交给调用方：onReorder(from, to, item)、onRemove(id, from, item)。 */
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { inRect, shiftFor, slotOffset, sortTarget } from './engine.js'
import { EASE, EXIT, after, hostFor, makeGhost, play } from './motion.js'
import { beginGesture, retainTouchGuard } from './pointer.js'

const preventNativeDrag = e => e.preventDefault()
const vibrate = ms => { try { navigator.vibrate?.(ms) } catch { /* 不支持就算了 */ } }
const EDGE = 36          // 距列表上下边缘多少 px 内开始自动滚动
const OUT = 16           // 指针离开抽屉面板多远算「拖出」
const SHIFT = 'transform .2s ease'   // 邻居让位（dnd-kit sortable 默认值）

/**
 * items: [{ id, name, icon, sub }]（与列表行同顺序）；onReorder(from, to, item)；onRemove(id, from, item)
 * 返回 { listRef, trashRef, active: { id, removing } | null, rowProps(id), handleProps(id) }
 * 列表的每一行要带 data-id，并展开 rowProps(id)；可选的抓手展开 handleProps(id)（触摸不用长按）。
 */
export function useSortableList({ items, onReorder, onRemove }) {
  const listRef = useRef(null)
  const trashRef = useRef(null)
  const [active, setActive] = useState(null)
  const live = useRef(null)
  live.current = { items, onReorder, onRemove }
  const busy = useRef(false)
  useEffect(() => retainTouchGuard(), [])
  useEffect(() => () => document.body.classList.remove('jvd-dragging'), [])

  function begin(e, id, mode) {
    const list = listRef.current
    if (!list || busy.current) return
    const rows = [...list.children].filter(n => n.hasAttribute('data-sort-row'))
    const from = rows.findIndex(r => r.dataset.id === id)
    if (from < 0) return
    const rowEl = rows[from]
    const s = { to: from, removing: false, raf: 0 }

    const place = (x, y) => {
      s.x = x
      s.y = y
      s.ghost.root.style.transform = `translate3d(${x - s.ax}px, ${y - s.ay}px, 0)`
    }
    function layout() {
      const removing = s.removing
      rows.forEach((r, i) => {
        if (i === from) return
        const d = shiftFor(i, from, removing ? null : s.to, s.size)
        r.style.transform = d ? `translateY(${d}px)` : ''
      })
      const off = removing ? 0 : slotOffset(s.rects, from, s.to)
      rowEl.style.transform = off ? `translateY(${off}px)` : ''
      rowEl.setAttribute('data-sort', removing ? 'gone' : 'placeholder')
      s.ghost.root.classList.toggle('is-removing', removing)
      s.ghost.tag.textContent = removing ? '松手移除' : ''
    }
    function update() {
      const { x, y } = s
      const trash = trashRef.current?.getBoundingClientRect()
      const panel = s.panel?.getBoundingClientRect()
      const removing = inRect(x, y, trash, 6) || (panel ? !inRect(x, y, panel, OUT) : false)
      let to = s.to
      if (!removing) {
        const lr = list.getBoundingClientRect()
        to = sortTarget(s.rects, from, y - s.ay + s.h / 2 - lr.top + list.scrollTop)
      }
      if (removing === s.removing && to === s.to) return
      const flip = removing !== s.removing
      s.removing = removing
      s.to = to
      layout()
      if (flip) {
        setActive(a => (a ? { ...a, removing } : a))
        if (removing && s.touch) vibrate(8)
      }
    }
    function autoscroll() {
      cancelAnimationFrame(s.raf)
      if (s.removing || list.scrollHeight <= list.clientHeight) return
      const r = list.getBoundingClientRect()
      let v = 0
      if (s.y >= r.top && s.y < r.top + EDGE) v = -Math.min(12, Math.ceil((r.top + EDGE - s.y) / 3))
      else if (s.y <= r.bottom && s.y > r.bottom - EDGE) v = Math.min(12, Math.ceil((s.y - (r.bottom - EDGE)) / 3))
      if (!v) return
      const tick = () => {
        const before = list.scrollTop
        list.scrollTop += v
        if (list.scrollTop === before) return
        update()
        s.raf = requestAnimationFrame(tick)
      }
      s.raf = requestAnimationFrame(tick)
    }
    function reset() {
      rows.forEach(r => {
        r.style.transition = 'none'
        r.style.transform = ''
        r.removeAttribute('data-sort')
      })
      void list.offsetHeight
      rows.forEach(r => { r.style.transition = '' })
    }
    function drop(cancelled) {
      cancelAnimationFrame(s.raf)
      document.body.classList.remove('jvd-dragging')
      busy.current = true
      const { ghost, item } = s
      const { onReorder: reorder, onRemove: remove } = live.current
      const cur = ghost.root.style.transform
      if (s.removing && !cancelled) {
        after(play(ghost.lift, [{ transform: 'scale(1)', opacity: 0.5 }, { transform: 'scale(.6)', opacity: 0 }],
          { duration: 160, easing: EXIT }), () => ghost.root.remove())
        flushSync(() => {
          remove?.(item.id, from, item)
          setActive(null)
        })
        reset()
        busy.current = false
        return
      }
      const to = cancelled || s.removing ? from : s.to
      if (to === from) {
        // 回到原位：其他行带着过渡退回去，拖影滑回空位
        rows.forEach((r, i) => { if (i !== from) r.style.transform = '' })
        rowEl.style.transform = ''
        rowEl.setAttribute('data-sort', 'placeholder')
        ghost.root.classList.remove('is-removing')
        ghost.tag.textContent = ''
      }
      const lr = list.getBoundingClientRect()
      const ty = lr.top - list.scrollTop + s.rects[from].top + slotOffset(s.rects, from, to)
      const p = play(ghost.root, [{ transform: cur }, { transform: `translate3d(${s.left}px, ${ty}px, 0)` }],
        { duration: to === from ? 250 : 200, easing: to === from ? 'ease' : EASE })
      play(ghost.card, [{ transform: 'scale(1.02)' }, { transform: 'scale(1)' }], { duration: 200, easing: EASE })
      after(p, () => {
        flushSync(() => {
          if (to !== from) reorder?.(from, to, item)
          setActive(null)
        })
        reset()
        ghost.root.remove()
        busy.current = false
      })
    }

    beginGesture(e, {
      el: rowEl,
      mode,
      threshold: mode === 'handle' ? 3 : 5,
      onPress: type => { if (type === 'touch') rowEl.setAttribute('data-dnd-press', '') },
      onRelease: () => rowEl.removeAttribute('data-dnd-press'),
      onStart({ x, y, startX, startY, pointerType }) {
        const item = live.current.items.find(p => p.id === id)
        if (!item || !rowEl.isConnected) return false
        const lr = list.getBoundingClientRect()
        const top0 = list.scrollTop
        const rects = rows.map(r => {
          const b = r.getBoundingClientRect()
          return { top: b.top - lr.top + top0, height: b.height }
        })
        const own = rowEl.getBoundingClientRect()
        const gap = rows.length > 1 ? Math.max(0, rects[1].top - rects[0].top - rects[0].height) : 6
        const ghost = makeGhost({ icon: item.icon, label: item.name, sub: item.sub, width: own.width, row: true })
        hostFor().appendChild(ghost.root)
        Object.assign(s, {
          rects, ghost, item, size: own.height + gap, h: own.height, left: own.left,
          ax: startX - own.left, ay: startY - own.top, touch: pointerType === 'touch',
          panel: list.closest('[role="dialog"]'),
        })
        place(x, y)
        rows.forEach(r => { r.style.transition = SHIFT })
        rowEl.setAttribute('data-sort', 'placeholder')
        document.body.classList.add('jvd-dragging')
        setActive({ id, removing: false })
        if (s.touch) vibrate(10)
        return true
      },
      onMove({ x, y }) {
        place(x, y)
        update()
        autoscroll()
      },
      onEnd({ x, y }) {
        place(x, y)
        update()
        drop(false)
      },
      onCancel() { drop(true) },
    })
  }

  return {
    listRef,
    trashRef,
    active,
    rowProps: id => ({ 'data-sort-row': '', onPointerDown: e => begin(e, id, 'auto'), onDragStart: preventNativeDrag }),
    handleProps: id => ({ 'data-sort-handle': '', onPointerDown: e => { e.stopPropagation(); begin(e, id, 'handle') } }),
  }
}
