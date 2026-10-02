/* 拖影、飞入、弹一下：全部只动 transform / opacity，用 Web Animations API。
 * 浏览器不支持（测试环境）或用户开了「减弱动态效果」时 play() 返回 null，调用方同步收尾。
 * 时长 / 缓动按《第十七轮设计参考》§0.6、§6：按压 100、状态 160、进出 240、飞入 420；回弹只用在计数跳动。 */

export const EASE = 'cubic-bezier(.2,.8,.2,1)'           // --m-ease：位移、落位
export const EXIT = 'cubic-bezier(.4,0,1,1)'             // 退出 / 淡出
export const BOUNCE = 'cubic-bezier(.34,1.4,.64,1)'      // 只用于落进 Dock 时的计数跳动

export function reducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** 播一段动画；不能播时返回 null（调用方用 after() 同步收尾） */
export function play(el, frames, opts = {}) {
  if (!el || typeof el.animate !== 'function' || reducedMotion()) return null
  let a
  try { a = el.animate(frames, { fill: 'forwards', ...opts }) } catch { return null }
  // 后台标签页里动画会被暂停：兜底按时长收尾，不会让拖影一直挂在页面上
  const limit = new Promise(resolve => setTimeout(resolve, (opts.duration || 0) + (opts.delay || 0) + 300))
  return Promise.race([a.finished.catch(() => {}), limit])
}

/** p 为 null 时立刻执行，否则等动画结束 */
export function after(p, fn) {
  if (p && typeof p.then === 'function') return p.then(fn, fn)
  fn()
  return null
}

const ICON_SEL = '[data-dnd-icon],.jvm-card-icon,.jvm-bundle-icon,.jvm-rec-icon'

/** 卡片里的图标元素：自己就是图标、或在所属拖拽源 / 卡片里找 */
export function findIcon(el) {
  if (!el || typeof el.matches !== 'function') return null
  if (el.matches(ICON_SEL)) return el
  const root = el.closest('[data-dnd-source]') || el.closest('article') || el
  return root.querySelector(ICON_SEL)
}

/** 套装卡里前几个插件的图标（药丸上扇形叠放）：[data-dnd-icons] 下的元素，或精选套装卡里的小图标 */
export function iconsOf(el, n = 3) {
  if (!el?.querySelectorAll) return []
  const list = [...el.querySelectorAll('[data-dnd-icons] > *, .jvm-bundle-item [aria-hidden="true"]')]
  return list.map(x => x.textContent.trim()).filter(Boolean).slice(0, n)
}

/** 卡片名称：data-dnd-label → aria-label → aria-labelledby → 标题 */
export function labelOf(el) {
  if (!el) return ''
  const own = el.querySelector?.('[data-dnd-label]')?.textContent
  if (own) return own.trim()
  const aria = el.getAttribute?.('aria-label')
  if (aria) return aria.trim()
  const by = el.getAttribute?.('aria-labelledby')
  const ref = by ? document.getElementById(by.split(/\s+/)[0]) : null
  if (ref?.textContent) return ref.textContent.trim()
  return (el.querySelector?.('h2,h3,h4')?.textContent || '').trim()
}

/** 拖影 / 飞入的图标挂在 body 上（position:fixed、pointer-events:none），层级在一切之上 */
export const hostFor = () => document.body

/** Dock 上新图标会落下的位置：撑开的空位（有的话），否则托盘图标最右一格 */
export function dockTarget(dock) {
  const slot = dock.querySelector('[data-dock-slot]')
  if (slot) {
    const r = slot.getBoundingClientRect()
    if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  const t = dock.querySelector('[data-dock-target]')
  const r = (t || dock).getBoundingClientRect()
  return t ? { x: r.right - 16, y: r.top + r.height / 2 } : { x: r.left + 40, y: r.top + r.height / 2 }
}

/** Dock 计数 / 图标跳一下：1 → 1.12 → 1，220ms，回弹 */
export function bump(dock) {
  if (!dock) return
  dock.querySelectorAll('[data-dock-bump]').forEach(n => {
    play(n, [{ transform: 'scale(1)' }, { transform: 'scale(1.12)', offset: 0.45 }, { transform: 'scale(1)' }],
      { duration: 220, easing: BOUNCE, fill: 'none' })
  })
}

function node(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text) n.textContent = text
  return n
}

/**
 * 拖影「药丸」：外层跟手（只改 transform），中间层做浮起 / 落位，内层是图标 40 + 名称（套装是前 3 个图标扇形叠放）。
 * 右上角角标：套装显示会新加的个数；越过 Dock 时变「+」或「⦸」。row = true 是工具箱抽屉里的一行（与原行同宽）。
 */
export function makeGhost({ icon, icons = [], label, sub = '', count = 0, tone = 'ok', width = 0, row = false }) {
  const root = node('div', `jvd-ghost${row ? ' is-row' : ''}`)
  root.setAttribute('aria-hidden', 'true')
  root.dataset.tone = tone
  const lift = node('div', 'jvd-ghost-lift')
  const card = node('div', 'jvd-ghost-card')
  const face = node('span', `jvd-ghost-icon${icons.length > 1 ? ' is-fan' : ''}`)
  if (icons.length > 1) icons.slice(0, 3).forEach(ic => face.append(node('i', '', ic)))
  else face.textContent = icon || icons[0] || '🧩'
  const text = node('span', 'jvd-ghost-text')
  text.append(node('b', '', label || '插件'))
  if (sub) text.append(node('small', '', sub))
  const badge = node('span', 'jvd-ghost-badge', count > 0 ? String(count) : '')
  const tag = node('span', 'jvd-ghost-tag')
  card.append(face, text, tag, badge)
  if (width) card.style.width = `${Math.round(width)}px`
  lift.append(card)
  root.append(lift)
  return { root, lift, card, face, text, badge, tag }
}

/**
 * 点「+」时的飞入：从卡片图标的位置复制一个图标，420ms 弧线飞到 Dock 的图标位，到达时 Dock 计数跳一下。
 * 弧线靠拆分 X / Y 两条缓动：外层 translateX 用 cubic-bezier(.2,.8,.2,1)，内层 translateY 用 cubic-bezier(.6,0,.9,.5)，
 * 飞行中缩放 1 → .45。减弱动态效果 / 找不到 Dock / 元素不可见时什么都不做。返回 Promise<boolean>（是否飞了）。
 */
export function flyFrom(fromEl, dock, { icon } = {}) {
  if (!fromEl || !dock || reducedMotion()) return Promise.resolve(false)
  const iconEl = findIcon(fromEl) || fromEl
  const r = iconEl.getBoundingClientRect()
  if (!r.width || !r.height) return Promise.resolve(false)
  const size = Math.round(Math.max(28, Math.min(56, r.width, r.height)))
  const outer = node('div', 'jvd-fly')
  const inner = node('div', 'jvd-fly-icon', icon || iconEl.textContent?.trim() || '＋')
  if (typeof outer.animate !== 'function') return Promise.resolve(false)
  outer.setAttribute('aria-hidden', 'true')
  inner.style.width = `${size}px`
  inner.style.height = `${size}px`
  inner.style.fontSize = `${Math.round(size * 0.56)}px`
  outer.append(inner)
  const x0 = r.left + r.width / 2 - size / 2
  const y0 = r.top + r.height / 2 - size / 2
  outer.style.transform = `translate(${x0}px, 0)`
  inner.style.transform = `translate(0, ${y0}px)`
  hostFor().appendChild(outer)
  const t = dockTarget(dock)
  const x1 = t.x - size / 2
  const y1 = t.y - size / 2
  const opts = { duration: 420, fill: 'forwards' }
  const px = play(outer, [{ transform: `translate(${x0}px, 0)` }, { transform: `translate(${x1}px, 0)` }], { ...opts, easing: EASE })
  play(inner, [
    { transform: `translate(0, ${y0}px) scale(1)`, opacity: 1 },
    { transform: `translate(0, ${y1}px) scale(.45)`, opacity: 0.9 },
  ], { ...opts, easing: 'cubic-bezier(.6,0,.9,.5)' })
  return new Promise(resolve => {
    after(px, () => {
      outer.remove()
      bump(dock)
      resolve(true)
    })
  })
}
