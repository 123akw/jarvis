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

    /** 不做任何补全的纯渲染：流式增量渲染里「已完结块」走这里（围栏天然成对） */
    const renderBlock = s => DOMPurify.sanitize(parser.parse(s))

    function render(text, opts) {
      const streaming = Boolean(opts && opts.streaming)
      let s = String(text == null ? '' : text)
      if (((s.match(/```/g) || []).length) % 2 === 1) s += '\n```'  // 流式中未闭合的代码块
      let html = renderBlock(s)
      if (streaming) {
        html = html.endsWith('</p>\n')
          ? `${html.slice(0, -5)}<span class="caret"></span></p>\n`
          : `${html}<span class="caret"></span>`
      }
      return html
    }
    render.block = renderBlock
    return render
  }

  /* ---------- 流式增量渲染（与 web-src/src/markdown.js 同逻辑） ----------
   * 旧做法每个 token 都把整篇回答重新 marked → hljs → DOMPurify，长回答是 O(n²)。
   * 空行之后、顶格且不是列表项的新行（且不在围栏代码块里）是安全切点：CommonMark 里这样的行
   * 必然结束前面的段落/列表/引用/表格。已完结块只渲染一次，每次更新只重渲染尾巴。 */
  const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})/
  const FENCE_CLOSE = /^(\s*)(`{3,}|~{3,})\s*$/
  const LIST_ITEM = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/

  function createStreamingMarkdown(render) {
    const renderBlock = render.block || render
    let src = ''
    let done = 0
    let scan = 0
    let fence = ''
    let fenceIndent = 0
    let blank = false
    let doneHtml = ''

    return {
      /** 返回 { reset, appendHtml（本次新完结块）, tailHtml（尾巴）, html（全文） } */
      update(text, opts) {
        const final = Boolean(opts && opts.final)
        text = String(text == null ? '' : text)
        let reset = false
        if (!text.startsWith(src)) {
          done = 0; scan = 0; fence = ''; fenceIndent = 0; blank = false; doneHtml = ''
          reset = true
        }
        src = text
        let appendHtml = ''
        let nl
        while ((nl = text.indexOf('\n', scan)) !== -1) {
          const start = scan
          const line = text.slice(start, nl)
          scan = nl + 1
          if (fence) {
            const m = FENCE_CLOSE.exec(line)
            if (m && m[2][0] === fence[0] && m[2].length >= fence.length && m[1].length <= fenceIndent + 3) fence = ''
            blank = false
            continue
          }
          if (!line.trim()) { blank = true; continue }
          if (blank && start > done && !/^\s/.test(line) && !LIST_ITEM.test(line)) {
            const html = renderBlock(text.slice(done, start))
            doneHtml += html
            appendHtml += html
            done = start
          }
          blank = false
          const open = FENCE_OPEN.exec(line)
          if (open) { fence = open[2]; fenceIndent = open[1].length }
        }
        const tailHtml = render(text.slice(done), { streaming: !final })
        return { reset, appendHtml, tailHtml, html: doneHtml + tailHtml }
      },
    }
  }

  /** 把流式增量结果打到 DOM：已完结块只追加一次，每次只替换尾巴节点 */
  function createStreamingView(el, render) {
    const stream = createStreamingMarkdown(render)
    let kept = 0
    el.textContent = ''
    return {
      update(text) {
        const r = stream.update(text)
        if (r.reset) { el.textContent = ''; kept = 0 }
        while (el.childNodes.length > kept) el.lastChild.remove()
        if (r.appendHtml) {
          el.insertAdjacentHTML('beforeend', r.appendHtml)
          kept = el.childNodes.length
        }
        if (r.tailHtml) el.insertAdjacentHTML('beforeend', r.tailHtml)
      },
    }
  }

  return { createMarkdownRenderer, createStreamingMarkdown, createStreamingView }
}))
