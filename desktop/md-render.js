/* Markdown 渲染核心：改写自 web-src/src/markdown.js（同逻辑，deps 注入以便 node --test 直测）。
 * 渲染 GFM 表格/链接/任务列表 + 代码高亮，输出经 DOMPurify 消毒；链接一律新窗口安全打开。 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.JWSMarkdown = factory()
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const esc = t => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  function createMarkdownRenderer(deps) {
    const marked = deps.marked
    const DOMPurify = deps.DOMPurify
    const hljs = deps.hljs || null

    const parser = new marked.Marked({
      gfm: true,
      breaks: true,          // 聊天体：单个换行即换行
      renderer: {
        code(token) {
          const lang = String(token.lang || '').trim().split(/\s+/)[0]
          let body = ''
          let cls = 'hljs'
          if (lang && hljs && hljs.getLanguage(lang)) {
            body = hljs.highlight(token.text, { language: lang, ignoreIllegals: true }).value
            cls += ` language-${lang}`
          } else {
            body = esc(token.text)
          }
          return `<div class="codeblock"><div class="codebar"><span class="codelang">${esc(lang || 'text')}</span>`
            + `<button class="codecopy" type="button">复制</button></div>`
            + `<pre><code class="${cls}">${body}</code></pre></div>\n`
        },
      },
    })

    if (DOMPurify.addHook && !DOMPurify.__jwsLinkHook) {
      DOMPurify.addHook('afterSanitizeAttributes', node => {
        if (node.tagName === 'A' && node.hasAttribute('href')) {
          node.setAttribute('target', '_blank')
          node.setAttribute('rel', 'noopener noreferrer')
        }
      })
      DOMPurify.__jwsLinkHook = true
    }

    return function render(text, opts) {
      const streaming = Boolean(opts && opts.streaming)
      let s = String(text == null ? '' : text)
      if (((s.match(/```/g) || []).length) % 2 === 1) s += '\n```'  // 流式中未闭合的代码块
      let html = DOMPurify.sanitize(parser.parse(s))
      if (streaming) {
        html = html.endsWith('</p>\n')
          ? `${html.slice(0, -5)}<span class="caret"></span></p>\n`
          : `${html}<span class="caret"></span>`
      }
      return html
    }
  }

  return { createMarkdownRenderer }
}))
