/* 把 Dock 上的小图标往上拖出去 = 移除（macOS Dock 的手感）：
 *  - 鼠标移动 ≥5px 起拖；触摸长按 250ms（Dock 本身不滚动，可以比卡片短）；
 *  - 指针高于 Dock 顶边 56px：拖影半透明并标「松手移除」；松手缩到 .6、160ms 淡出，调 onRemove(id)；
 *  - 没拖出去就松手 / Esc：拖影 200ms 回到原图标位置。撤销与播报交给调用方。 */
import { useEffect } from 'react'
import { inRect } from './engine.js'
import { EASE, EXIT, after, hostFor, makeGhost, play } from './motion.js'
import { beginGesture, retainTouchGuard } from './pointer.js'

const OUT = 56
const center = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
const preventNativeDrag = e => e.preventDefault()

/** iconProps(plugin) 展开到 Dock 上每个小图标（<i>）上；dock 取放置区元素（DOCK_ID） */
export function useDockPull({ getDock, onRemove }) {
  useEffect(() => retainTouchGuard(), [])
  function begin(e, p) {
    const el = e.currentTarget
    const s = { removing: false }
    s.move = (x, y) => {
      s.px = x - s.ax
      s.py = y - s.ay
      s.ghost.root.style.transform = `translate3d(${s.px}px, ${s.py}px, 0)`
      const r = s.dock.getBoundingClientRect()
      const removing = y < r.top - OUT && !inRect(x, y, r)
      if (removing === s.removing) return
      s.removing = removing
      s.ghost.root.classList.toggle('is-removing', removing)
      s.ghost.tag.textContent = removing ? '松手移除' : ''
    }
    s.end = cancelled => {
      document.body.classList.remove('jvd-dragging')
      const { ghost } = s
      if (s.removing && !cancelled) {
        after(play(ghost.lift, [{ transform: 'scale(1)', opacity: 0.5 }, { transform: 'scale(.6)', opacity: 0 }], { duration: 160, easing: EXIT }),
          () => ghost.root.remove())
        el.removeAttribute('data-pull')
        onRemove(p.id)
        return
      }
      const a = center(ghost.face.getBoundingClientRect())
      const b = center(el.isConnected ? el.getBoundingClientRect() : s.from)
      ghost.root.classList.remove('is-removing')
      ghost.tag.textContent = ''
      after(play(ghost.root, [
        { transform: `translate3d(${s.px}px, ${s.py}px, 0)`, opacity: 1 },
        { transform: `translate3d(${s.px + b.x - a.x}px, ${s.py + b.y - a.y}px, 0) scale(.8)`, opacity: 0 },
      ], { duration: 200, easing: EASE }), () => {
        ghost.root.remove()
        el.removeAttribute('data-pull')
      })
    }
    beginGesture(e, {
      el,
      delay: 250,
      onStart({ x, y, pointerType }) {
        const dock = getDock()
        if (!dock || !el.isConnected) return false
        const from = el.getBoundingClientRect()
        const ghost = makeGhost({ icon: p.icon, label: p.name })
        ghost.root.classList.add('is-pull')
        hostFor().appendChild(ghost.root)
        const gh = ghost.card.offsetHeight || 56
        Object.assign(s, { ghost, dock, from, ax: 28, ay: pointerType === 'touch' ? gh + 16 : 28 })
        s.move(x, y)
        el.setAttribute('data-pull', 'lifted')
        document.body.classList.add('jvd-dragging')
        if (pointerType === 'touch') { try { navigator.vibrate?.(10) } catch { /* 不支持 */ } }
        return true
      },
      onMove({ x, y }) { s.move(x, y) },
      onEnd() { s.end(false) },
      onCancel() { s.end(true) },
    })
  }
  return {
    iconProps: p => ({ onPointerDown: e => begin(e, p), onDragStart: preventNativeDrag, title: `${p.name}（往上拖出可移除）` }),
  }
}
