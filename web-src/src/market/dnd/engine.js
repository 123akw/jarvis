/* 拖拽的纯逻辑：放置判定、能否加入、排序下标、播报文案。不碰 DOM，单测直接测。 */

/** 点 (x, y) 是否落在矩形里；pad > 0 往外放宽（磁吸），< 0 往里收 */
export function inRect(x, y, r, pad = 0) {
  if (!r) return false
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
}

/** 原因的语气：'' → ok；「已在工具箱」一类 → same（灰）；其余（需要配置 / 不可用）→ deny（红） */
export function toneOf(reason) {
  if (!reason) return 'ok'
  return /已在|已经在|已加入|都在/.test(reason) ? 'same' : 'deny'
}

/**
 * 拖入时判定能加哪些：单个插件就是 [id]，套装是多个 id。
 * 返回 { ids: 能加入的, reason, tone }：有能加的就只加这些（其余跳过）；一个都不能加时给出原因。
 */
export function resolveAdd(ids, canAdd, kind = 'plugin') {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && x))]
  if (!list.length) return { ids: [], reason: '没有可以加入的插件', tone: 'deny' }
  if (typeof canAdd !== 'function') return { ids: list, reason: '', tone: 'ok' }
  const ok = []
  const reasons = []
  for (const id of list) {
    let r = ''
    try { r = canAdd(id) || '' } catch { r = '' }
    if (r) reasons.push(String(r))
    else ok.push(id)
  }
  if (ok.length) return { ids: ok, reason: '', tone: 'ok' }
  const many = kind === 'bundle' || list.length > 1
  const same = reasons.filter(r => toneOf(r) === 'same')
  // 套装里只要有已在工具箱的，就当「这一套都在了」（不可用的本来就不进套装）
  if (same.length === reasons.length || (many && same.length)) {
    return { ids: [], reason: many ? '这一套都已在工具箱里' : same[0], tone: 'same' }
  }
  return { ids: [], reason: reasons.find(r => toneOf(r) === 'deny') || reasons[0], tone: 'deny' }
}

/**
 * 排序：被拖条目中心落在 centerY 时的目标下标。
 * rows: 拖动开始时各行的 { top, height }（同一坐标系，按当前顺序），from: 被拖行原下标。
 */
export function sortTarget(rows, from, centerY) {
  let to = from
  for (let i = 0; i < rows.length; i++) {
    if (i === from) continue
    const mid = rows[i].top + rows[i].height / 2
    if (i < from && centerY < mid) to = Math.min(to, i)
    if (i > from && centerY > mid) to = Math.max(to, i)
  }
  return to
}

/** 排序过程中第 i 行要让多少位移（px）。to === null 表示被拖的那行要被移除：后面的行补上空位 */
export function shiftFor(i, from, to, size) {
  if (i === from) return 0
  if (to === null) return i > from ? -size : 0
  if (from < to && i > from && i <= to) return -size
  if (from > to && i >= to && i < from) return size
  return 0
}

/** 被拖的那行从原位到目标位要移动的距离（px） */
export function slotOffset(rows, from, to) {
  if (to === from || !rows[from] || !rows[to]) return 0
  if (to > from) return rows[to].top + rows[to].height - (rows[from].top + rows[from].height)
  return rows[to].top - rows[from].top
}

/** 把 list[from] 挪到 to，返回新数组 */
export function moveItem(list, from, to) {
  const out = [...list]
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out
  const [x] = out.splice(from, 1)
  out.splice(to, 0, x)
  return out
}

const q = s => `「${s}」`

/** 读屏播报（aria-live=polite）：拿起、越过、放下、取消四句，加上排序 / 移除 / 撤销 */
export const say = {
  picked: label => `已拿起${q(label)}。拖到底部工具箱松手即可加入，按 Esc 取消。`,
  overOk: () => '在工具箱上方，松手加入。',
  overReject: reason => `不能加入：${reason}。`,
  added: (label, total) => `已加入${q(label)}，工具箱共 ${total} 个。`,
  addedMany: (n, total) => `已加入 ${n} 个插件，工具箱共 ${total} 个。`,
  rejected: (label, reason, tone = 'deny') => (tone === 'same' ? `${q(label)}${reason}，已放回原处。` : `${q(label)}${reason}，不能加入，已放回原处。`),
  cancelled: label => `已取消，${q(label)}放回原处。`,
  removed: label => `已移除${q(label)}，5 秒内可以撤销。`,
  restored: (label, pos) => `已撤销，${q(label)}回到第 ${pos} 位。`,
  moved: (label, pos) => `${q(label)}移到第 ${pos} 位`,
}
