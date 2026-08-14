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
