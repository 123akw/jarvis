'use strict'
/* md-render 核心逻辑单测：真 marked + 真 hljs，DOMPurify 用透传 fake（消毒正确性由
 * web-src/src/markdown.test.js 以真 DOMPurify 覆盖，此处只验渲染结构）。 */
const test = require('node:test')
const assert = require('node:assert')

const marked = require('marked')
const hljs = require('@highlightjs/cdn-assets/highlight.min.js')
const { createMarkdownRenderer } = require('./md-render.js')

const passthroughPurify = { sanitize: html => html, addHook() {} }
const md = createMarkdownRenderer({ marked, DOMPurify: passthroughPurify, hljs })

test('链接渲染为 <a> 且表格渲染为真表格', () => {
  const html = md('[来源](https://example.com/a)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
  assert.match(html, /<a href="https:\/\/example\.com\/a"/)
  assert.match(html, /<table>/)
  assert.match(html, /<th>A<\/th>/)
})

test('代码块带语言高亮与复制按钮', () => {
  const html = md('```python\nprint("hi")\n```')
  assert.match(html, /language-python/)
  assert.match(html, /hljs-/)
  assert.match(html, /class="codecopy"/)
})

test('流式未闭合代码块自动补全并带光标', () => {
  const html = md('```js\nconst a = 1', { streaming: true })
  assert.match(html, /<pre><code/)
  assert.match(html, /class="caret"/)
})

test('无 hljs 依赖时代码块仍安全转义输出', () => {
  const plain = createMarkdownRenderer({ marked, DOMPurify: passthroughPurify, hljs: null })
  const html = plain('```html\n<b>x</b>\n```')
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/)
  assert.doesNotMatch(html, /<code[^>]*><b>/)
})

const { createStreamingMarkdown } = require('./md-render.js')
const LONG = [
  '### 标题', '正文 **加粗** 与 [链接](https://example.com)。',
  '1. **要点一**\n\n   松散列表续行\n\n2. **要点二**\n   - 子项',
  '顶格段落结束列表。',
  '```python\ndef f():\n\n    return 1\n```',
  '| A | B |\n| --- | --- |\n| 1 | 2 |', '> 引用', '最后一句。',
].join('\n\n')

test('流式增量渲染：逐 token 拼出的定稿结果与全量渲染逐字节一致，且确实分块提交', () => {
  const s = createStreamingMarkdown(md)
  let raw = ''
  let commits = 0
  for (let i = 0; i < LONG.length; i += 3) {
    raw += LONG.slice(i, i + 3)
    if (s.update(raw).appendHtml) commits++
  }
  assert.strictEqual(s.update(LONG, { final: true }).html, md(LONG))
  assert.ok(commits >= 4, `commits=${commits}`)
})

test('流式增量渲染：尾巴带光标，代码块内空行不切分', () => {
  const s = createStreamingMarkdown(md)
  const r = s.update('前言\n\n```js\nconst a = 1\n\n\nconst b')
  assert.match(r.html, /class="caret"/)
  assert.strictEqual((r.html.match(/<pre>/g) || []).length, 1)
})
