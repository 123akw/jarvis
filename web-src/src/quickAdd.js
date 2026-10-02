/** 一句话速记：把「明天下午3点 复盘」这类输入解析成日程；没有时间词就照旧是待办。
 *
 *  纯前端、零网络、零模型；now 可注入（测试固定在 2026-10-02 周五 10:00）。
 *  返回三种结果：
 *    { kind: 'schedule', title, when: 'YYYY-MM-DD HH:MM', label, rel, past, assumed, matched }
 *    { kind: 'todo', title }                           没有（可用的）时间词：原文照旧加待办
 *    { kind: 'empty', when?, label?, rel? }            只写了时间、没写要做什么（不提交）
 *
 *  规则（与 docs/proposals/2026-10-feature-ideas.md「F2 解析规则 v1」一致）：
 *    相对日期  今天/今晚/今早、明天/明早/明晚、后天、大后天
 *    星期      周X / 星期X / 礼拜X：本周还没过的那天，过了取下周；下周X、下下周X、这周X
 *    绝对日期  X月X日/号、YYYY年X月X日、M/D、YYYY-MM-DD、X号：当年/当月，已过取次年/次月
 *    时段      凌晨 早上 上午 中午 下午 傍晚 晚上…：下午/傍晚/晚上的 1–11 点加 12 小时
 *    时刻      X点、X点半、X点一刻/三刻、X点Y分、X点YY、HH:MM；一到十二、「两点」
 *    无时段    1–6 点按下午、7–11 点按上午、12 点按中午（assumed 标出这层推断）
 *    只有时刻  取今天，已过取明天；只有日期默认 09:00，若是今天且已过 09:00 则按待办
 *  歧义一律保守：「提3点建议」「3号楼」「早一点」「下午茶」不当时间；日期不存在（2月30日）、
 *  时刻越界（25点）按待办。预览里永远用 24 小时制写明解析结果，用户提交前就能看见。 */

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const N = '(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})'
const WEEK = '一二三四五六日'
const pad = n => String(n).padStart(2, '0')

/** 「十一」「二十五」「两」「7」→ 数字；认不出返回 NaN */
export function cnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s)
  const parts = String(s).split('十')
  if (parts.length === 1) return s.length === 1 && s in CN ? CN[s] : NaN
  if (parts.length > 2 || parts[0].length > 1 || parts[1].length > 1) return NaN
  const tens = parts[0] === '' ? 1 : CN[parts[0]]
  const ones = parts[1] === '' ? 0 : CN[parts[1]]
  return tens == null || ones == null ? NaN : tens * 10 + ones
}

const REL = {
  大后天: [3, null], 后天: [2, null], 今天: [0, null], 今日: [0, null], 今儿: [0, null],
  今早: [0, '早上'], 今晚: [0, '晚上'], 今夜: [0, '晚上'],
  明天: [1, null], 明日: [1, null], 明儿: [1, null], 明早: [1, '早上'], 明晚: [1, '晚上'], 明夜: [1, '晚上'],
}
const PM = new Set(['午后', '下午', '傍晚', '晚上', '晚间', '夜里', '夜间', '晚'])
const NIGHT_END = new Set(['晚上', '晚间', '夜里', '夜间', '晚'])         // 「晚上12点」= 次日 0 点
const SMALL_HOURS = new Set(['凌晨', '半夜', '深夜'])                     // 「凌晨12点」= 0 点
const PERIOD_DEFAULT = {
  凌晨: 5, 清晨: 6, 早上: 8, 早晨: 8, 早: 8, 上午: 9, 中午: 12, 午后: 14, 下午: 15,
  傍晚: 18, 晚上: 20, 晚间: 20, 晚: 20, 夜里: 21, 夜间: 21, 半夜: 23, 深夜: 23,
}
// 数字前面是这些字时不是时刻：「第3点」「提3点建议」「这两点」「几点」
const NOT_TIME_BEFORE = '第提讲说写列几条共这那哪'
// 「X号」后面是这些字时是编号不是日期：「3号楼」「2号线」
const NOT_DAY_AFTER = '楼线门床机位房厅馆院台窗座口车'

function* scan(re, text) {
  for (const m of text.matchAll(re)) yield m
}
const isDigit = c => c >= '0' && c <= '9'
const cjk = c => /[㐀-鿿]/.test(c || '')

function validDate(y, m, d) {
  const t = new Date(y, m - 1, d)
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d
}
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/* ---------- 词法：日期 / 时段 / 时刻候选 ---------- */

function dateCandidates(text) {
  const out = []
  for (const m of scan(/(大后天|后天|今天|今日|今儿|今早|今晚|今夜|明天|明日|明儿|明早|明晚|明夜)/g, text)) {
    const [offset, period] = REL[m[1]]
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'rel', offset, period })
  }
  for (const m of scan(/(下下个?|下个?|这个?|本)?(?:周|星期|礼拜)([一二三四五六日天七1-7])/g, text)) {
    const c = m[2]
    const dow = c === '日' || c === '天' || c === '七' || c === '7' ? 6 : isDigit(c) ? Number(c) - 1 : WEEK.indexOf(c)
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'weekday', dow, mode: weekMode(m[1]) })
  }
  for (const m of scan(/(下下个?|下个?|这个?|本)?周末/g, text)) {
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'weekday', dow: 5, mode: weekMode(m[1]) })
  }
  for (const m of scan(new RegExp(`(?:(\\d{4})\\s*年\\s*)?${N}\\s*月\\s*${N}\\s*([日号])?`, 'g'), text)) {
    if (isDigit(text[m.index - 1] || '')) continue
    const after = text[m.index + m[0].length] || ''
    if (!m[4] && after && !/[\s，,。]/.test(after)) continue   // 「10月8」后面得是空格/标点/结尾
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'abs', y: m[1] ? Number(m[1]) : null, m: cnNumber(m[2]), d: cnNumber(m[3]) })
  }
  for (const m of scan(/(\d{4})-(\d{1,2})-(\d{1,2})/g, text)) {
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'abs', y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) })
  }
  for (const m of scan(/(\d{1,2})\/(\d{1,2})/g, text)) {
    const before = text[m.index - 1] || ''
    const after = text[m.index + m[0].length] || ''
    if (isDigit(before) || before === '/' || isDigit(after) || after === '/') continue
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'abs', y: null, m: Number(m[1]), d: Number(m[2]) })
  }
  for (const m of scan(new RegExp(`${N}\\s*[号日]`, 'g'), text)) {
    const before = text[m.index - 1] || ''
    const after = text[m.index + m[0].length] || ''
    if (isDigit(before) || before === '月' || (after && NOT_DAY_AFTER.includes(after))) continue
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'day', d: cnNumber(m[1]) })
  }
  return out
}

function weekMode(prefix) {
  if (!prefix) return 'bare'
  if (prefix.startsWith('下下')) return 'next2'
  if (prefix.startsWith('下')) return 'next'
  return 'this'
}

function periodCandidates(text) {
  const out = []
  for (const m of scan(/(凌晨|清晨|早上|早晨|上午|中午|午后|下午|傍晚|晚上|晚间|夜里|夜间|半夜|深夜)/g, text)) {
    if (m[1] === '下午' && text[m.index + 2] === '茶') continue   // 下午茶
    out.push({ start: m.index, end: m.index + m[0].length, word: m[1], strong: true })
  }
  for (const m of scan(new RegExp(`([早晚])(?=\\s*${N}\\s*[点时:：])`, 'g'), text)) {
    out.push({ start: m.index, end: m.index + 1, word: m[1], strong: false })
  }
  return out
}

function timeCandidates(text) {
  const out = []
  for (const m of scan(/(\d{1,2})\s*[:：]\s*(\d{2})/g, text)) {
    if (isDigit(text[m.index - 1] || '') || isDigit(text[m.index + m[0].length] || '')) continue
    out.push({ start: m.index, end: m.index + m[0].length, h: Number(m[1]), m: Number(m[2]), loose: false })
  }
  const re = new RegExp(`${N}\\s*[点时](?:\\s*(半|一刻|三刻|${N}\\s*分|(\\d{2})(?!\\d)))?(?:\\s*钟)?(?:\\s*整)?`, 'g')
  for (const m of scan(re, text)) {
    const before = text[m.index - 1] || ''
    if (isDigit(before) || before === '.' || (before && NOT_TIME_BEFORE.includes(before))) continue
    const h = cnNumber(m[1])
    let min = 0
    if (m[2] === '半') min = 30
    else if (m[2] === '一刻') min = 15
    else if (m[2] === '三刻') min = 45
    else if (m[3] != null) min = cnNumber(m[3])
    else if (m[4] != null) min = Number(m[4])
    // 「一点」多半是「快一点」「早一点」：只有紧跟在时段/日期后、或带了分钟时才算 1 点
    out.push({ start: m.index, end: m.index + m[0].length, h, m: min, loose: m[1] === '一' && !m[2] })
  }
  return out
}

/** 已选片段之后可顺带吃掉的尾巴：时间段的结束时刻（9:30-10:30）、「前/之前」 */
function swallowTail(text, end) {
  const range = new RegExp(`^\\s*[-~～到至]\\s*(?:\\d{1,2}\\s*[:：]\\s*\\d{2}|${N}\\s*[点时](?:半|\\d{2})?)`).exec(text.slice(end))
  if (range) end += range[0].length
  const before = /^\s*(?:之前|以前|前(?=[\s，,]|$))/.exec(text.slice(end))
  return before ? end + before[0].length : end
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end
const gapBlank = (text, from, to) => from <= to && text.slice(from, to).trim() === ''

/* ---------- 求值 ---------- */

function resolveDate(c, now) {
  const today = dayStart(now)
  if (c.kind === 'rel') return addDays(today, c.offset)
  if (c.kind === 'weekday') {
    const idx = (now.getDay() + 6) % 7
    const diff = c.mode === 'bare' ? (c.dow - idx + 7) % 7
      : c.mode === 'this' ? c.dow - idx
        : c.mode === 'next' ? 7 - idx + c.dow : 14 - idx + c.dow
    return addDays(today, diff)
  }
  if (c.kind === 'abs') {
    if (!Number.isFinite(c.m) || !Number.isFinite(c.d)) return null
    let y = c.y ?? now.getFullYear()
    if (!validDate(y, c.m, c.d)) {
      if (c.y != null || !validDate(y + 1, c.m, c.d)) return null
      y += 1                                         // 2/29：今年没有就落到下一个有的年份
    }
    let d = new Date(y, c.m - 1, c.d)
    if (c.y == null && d < today) {                 // 没写年份且已过：取次年（跨年）
      if (!validDate(y + 1, c.m, c.d)) return null
      d = new Date(y + 1, c.m - 1, c.d)
    }
    return d
  }
  // X号：本月，已过或本月没有这天就往后找（跨月、跨年）
  if (!Number.isFinite(c.d) || c.d < 1 || c.d > 31) return null
  for (let k = 0; k < 13; k += 1) {
    const y = now.getFullYear() + Math.floor((now.getMonth() + k) / 12)
    const mo = (now.getMonth() + k) % 12
    if (validDate(y, mo + 1, c.d) && new Date(y, mo, c.d) >= today) return new Date(y, mo, c.d)
  }
  return null
}

function applyPeriod(h, word) {
  if (!word) {
    if (h >= 1 && h <= 6) return [h + 12, 'pm']
    if (h >= 7 && h <= 11) return [h, 'am']
    return [h, null]
  }
  if (PM.has(word)) {
    if (h >= 1 && h <= 11) return [h + 12, null]
    if (h === 12 && NIGHT_END.has(word)) return [24, null]
    return [h, null]
  }
  if (word === '中午') return [h >= 1 && h <= 3 ? h + 12 : h, null]
  if (SMALL_HOURS.has(word)) return [h === 12 ? 0 : h, null]
  return [h, null]
}

export function formatWhen(date, now = new Date()) {
  const y = date.getFullYear() !== now.getFullYear() ? `${date.getFullYear()}年` : ''
  return `${y}${date.getMonth() + 1}月${date.getDate()}日 周${WEEK[(date.getDay() + 6) % 7]} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function relLabel(date, now) {
  const diff = Math.round((dayStart(date) - dayStart(now)) / 86400000)
  return diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : ''
}

const LEAD = /^(?:请|麻烦)?(?:帮我|给我)?(?:提醒我一下|提醒一下|提醒我|提醒|记得要|记得|别忘了|不要忘了|不要忘记|要)\s*/
const EDGE = /^[\s，,、。.:：;；\-—~～]+|[\s，,、。.:：;；\-—~～]+$/g

function titleWithout(text, spans) {
  const parts = []
  let last = 0
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    parts.push(text.slice(last, s.start))
    last = s.end
    if (text[last] === '的' && text.slice(last + 1).trim()) last += 1   // 「3点的会」「明天的早餐」
  }
  parts.push(text.slice(last))
  let out = ''
  for (const p of parts.map(x => x.trim()).filter(Boolean)) {
    out += out && !(cjk(out[out.length - 1]) && cjk(p[0])) ? ` ${p}` : p
  }
  return out.replace(EDGE, '').replace(LEAD, '').replace(EDGE, '')
}

export function parseQuickAdd(input, now = new Date()) {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { kind: 'empty' }
  const todo = { kind: 'todo', title: text }

  // 日期：全文最靠前的一个（同起点取更长的）
  const dates = dateCandidates(text).sort((a, b) => a.start - b.start || b.end - a.end)
  const date = dates[0] || null
  const taken = date ? [date] : []
  // 时刻：不与日期重叠的第一个
  const periods = periodCandidates(text).filter(p => !taken.some(t => overlaps(p, t)))
  let time = null
  let period = null
  for (const t of timeCandidates(text).sort((a, b) => a.start - b.start)) {
    if (taken.some(x => overlaps(t, x))) continue
    const p = periods.find(x => gapBlank(text, x.end, t.start))
    const afterDate = date && gapBlank(text, date.end, t.start)
    if (t.loose && !(p?.strong || afterDate)) continue      // 「早一点」「快一点」
    time = t
    period = p || null
    break
  }
  if (!time && date) period = periods.find(x => x.strong && gapBlank(text, date.end, x.start)) || null
  const periodWord = period?.word || date?.period || null
  if (!date && !time) return todo

  if (time && (time.h > 24 || time.m > 59 || !Number.isFinite(time.h) || !Number.isFinite(time.m))) return todo
  const base = date ? resolveDate(date, now) : dayStart(now)
  if (!base) return todo                                     // 2月30日之类：日期不存在

  let hour = 9
  let minute = 0
  let assumed = null
  const dateOnly = !time && !periodWord
  if (time) {
    [hour, assumed] = applyPeriod(time.h, periodWord)
    minute = time.m
  } else if (periodWord) {
    hour = PERIOD_DEFAULT[periodWord] ?? 9
  }
  let at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute)
  if (dateOnly && dayStart(at).getTime() === dayStart(now).getTime() && at <= now) return todo

  let past = false
  const later = n => new Date(at.getFullYear(), at.getMonth(), at.getDate() + n, at.getHours(), at.getMinutes())
  if (at <= now) {
    if (!date) at = later(1)                                 // 只写了时刻且已过：明天
    else if (date.kind === 'weekday' && date.mode === 'bare') at = later(7)   // 今天周五写「周五 9点」
    else past = true
  }

  const spans = taken.map(s => ({ ...s, end: swallowTail(text, s.end) }))
  if (period && !(date && overlaps(period, date))) spans.push(period)
  if (time) spans.push({ ...time, end: swallowTail(text, time.end) })
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  const result = {
    when, label: formatWhen(at, now), rel: relLabel(at, now), past, assumed,
    matched: spans.sort((a, b) => a.start - b.start).map(s => text.slice(s.start, s.end).trim()),
  }
  const title = titleWithout(text, spans)
  return title ? { kind: 'schedule', title, ...result } : { kind: 'empty', ...result }
}
