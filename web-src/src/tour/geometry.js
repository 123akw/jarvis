/* 新手引导的几何：挖空框（高亮框）与气泡卡的位置。纯函数，单测直接喂矩形。 */

export const PAD = 6          // 高亮框比目标外扩
export const GAP = 12         // 气泡与高亮框的间距
export const MARGIN = 16      // 气泡离视口边缘至少这么远
export const SHEET_MAX = 640  // 视口窄于它：气泡改成底部卡片

/** 目标矩形 → 高亮框（外扩 PAD，裁进视口内 4px）。radius 由目标自己的圆角决定（圆形目标保持圆形） */
export function holeFor(rect, vw, vh, radius = 12) {
  const top = Math.max(4, rect.top - PAD)
  const left = Math.max(4, rect.left - PAD)
  const bottom = Math.min(vh - 4, rect.bottom + PAD)
  const right = Math.min(vw - 4, rect.right + PAD)
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  return { top, left, width, height, radius: Math.min(radius, width / 2, height / 2) }
}

/** 目标的圆角（px）：读计算样式；百分比当圆形处理 */
export function radiusOf(el) {
  try {
    const raw = window.getComputedStyle(el).borderTopLeftRadius || ''
    if (raw.endsWith('%')) return 9999
    const n = parseFloat(raw)
    return Number.isFinite(n) && n > 0 ? n + PAD : 12
  } catch { return 12 }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi))

/**
 * 气泡卡放哪：
 *  - 手机（vw < SHEET_MAX）：底部卡片；目标会被它挡住（目标底边落进卡片区域）时改放顶部；
 *  - 没有目标：视口正中；
 *  - 其余按 prefer → 下 → 上 → 右 → 左 依次找放得下的一边，横向 / 纵向对齐目标中线并夹在视口里；
 *    都放不下（目标几乎占满视口）就压在视口底部居中。
 * 返回 { mode: 'sheet' | 'float', side, top, left }（sheet 模式只用 side：'bottom' | 'top'）。
 */
export function placeCard(hole, card, view, prefer = '') {
  const { vw, vh } = view
  const w = Math.min(card.w || 0, vw - MARGIN * 2)
  const h = card.h || 0
  if (vw < SHEET_MAX) {
    const covered = hole && hole.top + hole.height > vh - h - 24 && hole.top > h + 24
    return { mode: 'sheet', side: covered ? 'top' : 'bottom', top: 0, left: 0 }
  }
  if (!hole) return { mode: 'float', side: 'center', top: Math.max(MARGIN, (vh - h) / 2), left: Math.max(MARGIN, (vw - w) / 2) }
  const cx = hole.left + hole.width / 2
  const cy = hole.top + hole.height / 2
  const tries = {
    bottom: () => {
      const top = hole.top + hole.height + GAP
      return top + h <= vh - MARGIN ? { top, left: clamp(cx - w / 2, MARGIN, vw - w - MARGIN) } : null
    },
    top: () => {
      const top = hole.top - GAP - h
      return top >= MARGIN ? { top, left: clamp(cx - w / 2, MARGIN, vw - w - MARGIN) } : null
    },
    right: () => {
      const left = hole.left + hole.width + GAP
      return left + w <= vw - MARGIN ? { left, top: clamp(cy - h / 2, MARGIN, vh - h - MARGIN) } : null
    },
    left: () => {
      const left = hole.left - GAP - w
      return left >= MARGIN ? { left, top: clamp(cy - h / 2, MARGIN, vh - h - MARGIN) } : null
    },
  }
  const order = [prefer, 'bottom', 'top', 'right', 'left'].filter((s, i, a) => tries[s] && a.indexOf(s) === i)
  for (const side of order) {
    const at = tries[side]()
    if (at) return { mode: 'float', side, ...at }
  }
  return { mode: 'float', side: 'over', top: Math.max(MARGIN, vh - h - MARGIN), left: Math.max(MARGIN, (vw - w) / 2) }
}

/** 目标是否需要先滚到舒服的位置：贴着顶栏（上 64）或压在底部浮条 / 手机底部卡片区（下 120）都滚到中间；
 *  占满视口的大目标只要中线在视口内就不滚 */
export function needsScroll(rect, vh) {
  if (rect.height >= vh - 200) return rect.top > vh / 2 || rect.bottom < vh / 2
  return rect.top < 64 || rect.bottom > vh - 120
}
