/* 「带变量的文字」输入框背后的纯逻辑。
 *
 * 存的是 markup：`总结 {{n1.text}} 的要点`；
 * 输入框里显示的是 display：`总结 AI 处理 · 文字 的要点`（变量换成人话标签，覆盖层把标签画成 chip）。
 * 用户在 display 上编辑，这里把改动映射回 markup：碰到 chip 的删除会整块删掉变量，
 * 落在 chip 中间的输入挪到 chip 后面；粘贴 / 手打的 {{节点.字段}} 原样存下，重新显示时自动变 chip。
 * （思路同 react-mentions：同一份文字铺两层，对齐天然一致。） */
import { parseVars } from '../graph.js'

/** markup → { display, chips: [{ start, end, mStart, mEnd, raw, label, broken }] } */
export function toDisplay(markup, labelOf) {
  const s = String(markup ?? '')
  let display = ''
  let at = 0
  const chips = []
  for (const v of parseVars(s)) {
    display += s.slice(at, v.start)
    const { label, broken } = labelOf(v.ref, v.field)
    const start = display.length
    display += label
    chips.push({ start, end: display.length, mStart: v.start, mEnd: v.end, raw: v.raw, label, broken: !!broken })
    at = v.end
  }
  display += s.slice(at)
  return { display, chips }
}

/** display 里的位置 → markup 里的位置（位置不在 chip 内部时精确；在内部按 chip 末尾算） */
export function displayToMarkup(pos, chips) {
  let delta = 0
  for (const c of chips) {
    if (pos >= c.end) delta += (c.mEnd - c.mStart) - (c.end - c.start)
    else if (pos > c.start) return c.mEnd
    else break
  }
  return pos + delta
}

/** markup 里的位置 → display 里的位置（落在变量内部时取变量末尾） */
export function markupToDisplay(pos, chips) {
  let delta = 0
  for (const c of chips) {
    if (pos >= c.mEnd) delta += (c.mEnd - c.mStart) - (c.end - c.start)
    else if (pos > c.mStart) return c.end
    else break
  }
  return pos - delta
}

/**
 * 用户把输入框从 oldDisplay 改成 newDisplay，光标停在 caret（新 display 的位置）。
 * 返回 { markup, caret }（caret 为新 markup 里的位置）。
 */
export function applyEdit(markup, info, newDisplay, caret, { singleLine = false } = {}) {
  const o = info.display
  const n = String(newDisplay ?? '')
  const c = Math.max(0, Math.min(caret ?? n.length, n.length))
  // 光标之后的部分没变（打字、删除、粘贴都满足）；不满足时退回普通前后缀比较
  let suffix = n.length - c
  if (!o.endsWith(n.slice(c)) || suffix > o.length) {
    suffix = 0
    const max = Math.min(o.length, n.length)
    while (suffix < max && o[o.length - 1 - suffix] === n[n.length - 1 - suffix]) suffix += 1
  }
  const oldEnd = o.length - suffix
  const newEnd = n.length - suffix
  let prefix = 0
  const cap = Math.min(oldEnd, newEnd)
  while (prefix < cap && o[prefix] === n[prefix]) prefix += 1
  let start = prefix
  let end = oldEnd
  let inserted = n.slice(prefix, newEnd)
  if (singleLine) inserted = inserted.replace(/\r?\n/g, ' ')
  for (const chip of info.chips) {
    if (start === end) {
      // 纯插入落在 chip 中间：挪到 chip 后面
      if (start > chip.start && start < chip.end) { start = chip.end; end = chip.end }
    } else if (chip.start < end && chip.end > start) {
      // 删除 / 替换碰到 chip：整块删掉
      start = Math.min(start, chip.start)
      end = Math.max(end, chip.end)
    }
  }
  const ms = displayToMarkup(start, info.chips)
  const me = displayToMarkup(end, info.chips)
  const next = markup.slice(0, ms) + inserted + markup.slice(me)
  return { markup: next, caret: ms + inserted.length }
}

/**
 * 光标前刚打了 `{{` 或 `/`（后面可能还跟着筛选字）：返回 { start, query }（display 位置），否则 null。
 * `/` 只在开头或空白、标点之后才算（网址里的斜杠不弹）。
 */
export function triggerAt(display, caret, chips, { slash = true } = {}) {
  const before = display.slice(0, caret)
  let m = /\{\{([^{}\n]{0,24})$/.exec(before)
  let start = m ? caret - m[0].length : -1
  if (!m && slash) {
    m = /(^|[\s，。、；：,.;:（(「])\/([^\s/{}]{0,24})$/.exec(before)
    if (m) start = caret - m[0].length + m[1].length
  }
  if (!m) return null
  if (chips.some(c => start < c.end && caret > c.start)) return null
  return { start, query: m[2] ?? m[1] }
}

/** 在 markup 的 [from, to) 处换成变量 token，返回 { markup, caret } */
export function insertToken(markup, from, to, token) {
  const s = String(markup ?? '')
  const a = Math.max(0, Math.min(from, s.length))
  const b = Math.max(a, Math.min(to, s.length))
  return { markup: s.slice(0, a) + token + s.slice(b), caret: a + token.length }
}
