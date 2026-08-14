/** 完整 Markdown 渲染：GFM 表格/链接/任务列表 + 代码高亮 + DOMPurify 消毒。
 *  桌面端 desktop/md-render.js 是本模块的注入版改写，两边逻辑保持一致。 */
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const parser = new Marked({
  gfm: true,
  breaks: true,          // 聊天体：单个换行即换行，与旧渲染行为一致
  renderer: {
    code(token) {
      const lang = String(token.lang || '').trim().split(/\s+/)[0]
      let body = ''
      let cls = 'hljs'
      if (lang && hljs.getLanguage(lang)) {
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

/* 外链一律新窗口打开且不携带 opener（模型回答里要求附来源链接，必须可点且安全） */
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export function renderMarkdown(text, { streaming = false } = {}) {
  let s = String(text ?? '')
  if (((s.match(/```/g) || []).length) % 2 === 1) s += '\n```'  // 流式中未闭合的代码块
  let html = DOMPurify.sanitize(parser.parse(s))
  if (streaming) {
    html = html.endsWith('</p>\n')
      ? `${html.slice(0, -5)}<span class="caret"></span></p>\n`
      : `${html}<span class="caret"></span>`
  }
  return html
}

/** 事件委托：代码块「复制」按钮（渲染的 HTML 无法直接挂 React 事件） */
export function handleCodeCopyClick(e) {
  const btn = e.target?.closest?.('.codecopy')
  if (!btn) return
  const code = btn.closest('.codeblock')?.querySelector('code')
  if (!code) return
  navigator.clipboard?.writeText(code.textContent)
  btn.textContent = '已复制'
  setTimeout(() => { btn.textContent = '复制' }, 1200)
}
