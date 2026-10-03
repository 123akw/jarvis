import { describe, expect, it } from 'vitest'
import { applyEdit, displayToMarkup, insertToken, markupToDisplay, toDisplay, triggerAt } from './varText.js'

const LABELS = { 'n1.text': 'AI 处理 · 文字', 'sys.date': '系统 · 今天日期' }
const labelOf = (ref, field) => ({ label: LABELS[`${ref}.${field}`] || '已删除的节点 · 文字', broken: !LABELS[`${ref}.${field}`] })

describe('变量输入：markup ↔ display', () => {
  const markup = '总结{{n1.text}}，日期{{sys.date}}。'
  const info = toDisplay(markup, labelOf)

  it('toDisplay 把变量换成人话并记下位置', () => {
    expect(info.display).toBe('总结AI 处理 · 文字，日期系统 · 今天日期。')
    expect(info.chips).toHaveLength(2)
    expect(info.chips[0]).toMatchObject({ start: 2, end: 12, mStart: 2, mEnd: 13, raw: '{{n1.text}}', broken: false })
    expect(toDisplay('{{x.text}}', labelOf).chips[0].broken).toBe(true)
  })

  it('位置互换：chip 外精确，chip 内按末尾', () => {
    expect(displayToMarkup(0, info.chips)).toBe(0)
    expect(displayToMarkup(12, info.chips)).toBe(13)
    expect(displayToMarkup(5, info.chips)).toBe(13)
    expect(displayToMarkup(info.display.length, info.chips)).toBe(markup.length)
    expect(markupToDisplay(13, info.chips)).toBe(12)
    expect(markupToDisplay(6, info.chips)).toBe(12)
    expect(markupToDisplay(markup.length, info.chips)).toBe(info.display.length)
  })

  it('普通打字：插在 chip 前后不碰 chip', () => {
    // 在 chip 前打 "A"（与 chip 首字相同也不误判）
    const n1 = `总结A${info.display.slice(2)}`
    expect(applyEdit(markup, info, n1, 3)).toEqual({ markup: '总结A{{n1.text}}，日期{{sys.date}}。', caret: 3 })
    // 在 chip 后打 "字"（与 chip 末字相同）
    const n2 = `${info.display.slice(0, 12)}字${info.display.slice(12)}`
    expect(applyEdit(markup, info, n2, 13).markup).toBe('总结{{n1.text}}字，日期{{sys.date}}。')
  })

  it('退格碰到 chip 整块删掉；Delete 在 chip 前也整块删', () => {
    const back = info.display.slice(0, 11) + info.display.slice(12)
    expect(applyEdit(markup, info, back, 11)).toEqual({ markup: '总结，日期{{sys.date}}。', caret: 2 })
    const del = info.display.slice(0, 2) + info.display.slice(3)
    expect(applyEdit(markup, info, del, 2).markup).toBe('总结，日期{{sys.date}}。')
  })

  it('选中一段跨 chip 的文字替换掉', () => {
    const n = `总X${info.display.slice(14)}`   // 把「结AI 处理 · 文字，日」换成 X
    expect(applyEdit(markup, info, n, 2).markup).toBe('总X期{{sys.date}}。')
  })

  it('在 chip 中间打字：挪到 chip 后面', () => {
    const n = `${info.display.slice(0, 5)}Z${info.display.slice(5)}`
    expect(applyEdit(markup, info, n, 6).markup).toBe('总结{{n1.text}}Z，日期{{sys.date}}。')
  })

  it('单行模式把换行换成空格；粘贴的 {{…}} 原样存下', () => {
    const one = toDisplay('', labelOf)
    expect(applyEdit('', one, 'a\nb', 3, { singleLine: true }).markup).toBe('a b')
    expect(applyEdit('', one, '看{{n1.text}}', 12).markup).toBe('看{{n1.text}}')
  })

  it('triggerAt 识别刚打的 {{ 与后面的筛选字', () => {
    expect(triggerAt('写{{', 3, [])).toEqual({ start: 1, query: '' })
    expect(triggerAt('写{{文字', 5, [])).toEqual({ start: 1, query: '文字' })
    expect(triggerAt('写{{a}}', 6, [])).toBeNull()
    expect(triggerAt('写{', 2, [])).toBeNull()
  })

  it('打 / 也弹选择（开头、空白或标点后才算，网址里的不算）', () => {
    expect(triggerAt('/', 1, [])).toEqual({ start: 0, query: '' })
    expect(triggerAt('总结 /文字', 6, [])).toEqual({ start: 3, query: '文字' })
    expect(triggerAt('总结，/', 4, [])).toEqual({ start: 3, query: '' })
    expect(triggerAt('https://a', 9, [])).toBeNull()
    expect(triggerAt('a/b', 3, [])).toBeNull()
    expect(triggerAt('/ ', 2, [])).toBeNull()
    expect(triggerAt('/', 1, [], { slash: false })).toBeNull()
  })

  it('insertToken 在指定范围放变量', () => {
    expect(insertToken('写{{文', 1, 4, '{{n1.text}}')).toEqual({ markup: '写{{n1.text}}', caret: 12 })
    expect(insertToken('ab', 5, 9, '{{x.y}}')).toEqual({ markup: 'ab{{x.y}}', caret: 9 })
  })
})
