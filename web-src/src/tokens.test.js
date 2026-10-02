// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 设计 token 的对比度护栏：次要文字（--jv-text-2/-3，含占位符、时间、分组标题）在两种主题下都 ≥ 3:1，
 *  正文 --jv-text ≥ 7:1。直接从 styles.css 读 token，改色时这里会先报警。 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function block(selector) {
  const i = css.indexOf(`${selector}{`)
  if (i < 0) throw new Error(`没找到 ${selector}`)
  return css.slice(i, css.indexOf('}', i))
}
function token(src, name) {
  const m = src.match(new RegExp(`${name}:([^;]+);`))
  if (!m) throw new Error(`没找到 ${name}`)
  return m[1].trim()
}
function rgba(value) {
  if (value.startsWith('#')) {
    const h = value.slice(1)
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }
  }
  const [r, g, b, a = 1] = value.match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number)
  return { r, g, b, a }
}
const lum = ({ r, g, b }) => {
  const f = x => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(fg, bg) {
  const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) }
  const [l1, l2] = [lum(mix), lum(bg)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

describe('设计 token 对比度', () => {
  for (const [theme, sel] of [['暗色', ':root'], ['亮色', 'body.light']]) {
    it(`${theme}：正文 ≥ 7:1，次要文字 ≥ 3:1`, () => {
      const src = block(sel)
      const bg = rgba(token(src, '--jv-bg'))
      expect(contrast(rgba(token(src, '--jv-text')), bg)).toBeGreaterThanOrEqual(7)
      expect(contrast(rgba(token(src, '--jv-text-2')), bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(rgba(token(src, '--jv-text-3')), bg)).toBeGreaterThanOrEqual(3)
    })
  }
})
