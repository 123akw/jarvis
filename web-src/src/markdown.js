/** 完整 Markdown 渲染：GFM 表格/链接/任务列表 + 代码高亮 + DOMPurify 消毒。
 *  桌面端 desktop/md-render.js 是本模块的注入版改写，两边逻辑保持一致。 */
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { copyText } from './clipboard.js'

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* highlight.js（common 36 种语言，约 165KB）按需懒加载：首屏不再背着它；
 * 第一次遇到带语言的代码块才去取，取到前代码块先安全转义输出，取到后通知订阅者重渲染。 */
let hljs = null
let hlPromise = null
let hlVersion = 0
const hlListeners = new Set()

export function loadHighlighter() {
  if (!hlPromise) {
    hlPromise = import('highlight.js/lib/common').then(m => {
      hljs = m.default
      hlVersion += 1
      clearCache()   // 缓存里是未高亮的版本
      hlListeners.forEach(fn => fn())
      return hljs
    }).catch(() => { hlPromise = null; return null })   // 加载失败：保持纯文本代码块，下次再试
  }
  return hlPromise
}
export function subscribeHighlighter(fn) {
  hlListeners.add(fn)
  return () => { hlListeners.delete(fn) }
}
export function highlighterVersion() { return hlVersion }

const parser = new Marked({
  gfm: true,
  breaks: true,          // 聊天体：单个换行即换行，与旧渲染行为一致
  renderer: {
    code(token) {
      const lang = String(token.lang || '').trim().split(/\s+/)[0]
      let body = ''
      let cls = 'hljs'
      if (lang && !hljs) void loadHighlighter()
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

/* 外链一律新窗口打开且不携带 opener（模型回答里要求附来源链接，必须可点且安全） */
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** 不做任何补全的纯渲染：流式增量渲染里「已完结块」走这里（围栏天然成对） */
function renderBlock(s) {
  return DOMPurify.sanitize(parser.parse(s))
}

/* 定稿消息的渲染缓存（按字符预算 FIFO 淘汰）：切换会话/重渲染时历史消息不必再走一遍
 * marked+hljs+DOMPurify。预算约 2M 字符，超长单条不进缓存。 */
const CACHE_BUDGET = 2_000_000
const cache = new Map()
let cacheSize = 0
function clearCache() { cache.clear(); cacheSize = 0 }

export function renderMarkdown(text, { streaming = false } = {}) {
  let s = String(text ?? '')
  if (!streaming) {
    const hit = cache.get(s)
    if (hit !== undefined) return hit
  }
  const key = s
  if (((s.match(/```/g) || []).length) % 2 === 1) s += '\n```'  // 流式中未闭合的代码块
  let html = renderBlock(s)
  if (streaming) {
    html = html.endsWith('</p>\n')
      ? `${html.slice(0, -5)}<span class="caret"></span></p>\n`
      : `${html}<span class="caret"></span>`
  } else {
    const cost = key.length + html.length
    if (cost <= CACHE_BUDGET / 8) {
      while (cacheSize + cost > CACHE_BUDGET && cache.size) {
        const [k, v] = cache.entries().next().value
        cache.delete(k)
        cacheSize -= k.length + v.length
      }
      cache.set(key, html)
      cacheSize += cost
    }
  }
  return html
}

/* ---------- 流式增量渲染 ----------
 * 旧做法每来一个 token 就把整篇回答重新 marked → hljs → DOMPurify，长回答是 O(n²)。
 * 这里把回答切成「已完结块 + 尾巴」：空行之后、顶格且不是列表项的新行（且不在围栏代码块里）
 * 是安全切点——CommonMark 里这样的行必然结束前面的段落/列表/引用/表格。
 * 已完结块只渲染一次并缓存，每次更新只重渲染尾巴。定稿时仍做一次全量渲染保证与旧输出一致。 */
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})/
const FENCE_CLOSE = /^(\s*)(`{3,}|~{3,})\s*$/
const LIST_ITEM = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/

export function createStreamingMarkdown() {
  let src = ''          // 上次见到的全文（判断是否只是追加）
  let done = 0          // 已完结部分的长度
  let scan = 0          // 下一个待扫描行的起点
  let fence = ''        // 未闭合围栏的标记（'' = 不在代码块里）
  let fenceIndent = 0
  let blank = false     // 上一行是否空行
  let doneHtml = ''

  return {
    /** 返回 { reset, appendHtml（本次新完结块）, tailHtml（尾巴）, html（全文） } */
    update(text, { final = false } = {}) {
      text = String(text ?? '')
      let reset = false
      if (!text.startsWith(src)) {   // 不是追加（重答/替换）：从头来
        done = 0; scan = 0; fence = ''; fenceIndent = 0; blank = false; doneHtml = ''
        reset = true
      }
      src = text
      let appendHtml = ''
      let nl
      while ((nl = text.indexOf('\n', scan)) !== -1) {   // 只看新出现的完整行
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
      const tailHtml = renderMarkdown(text.slice(done), { streaming: !final })
      return { reset, appendHtml, tailHtml, html: doneHtml + tailHtml }
    },
  }
}

/** 把流式增量结果打到 DOM：已完结块只追加一次，每次只替换尾巴节点（避免整段 innerHTML 重建） */
export function createStreamingView(el, stream = createStreamingMarkdown()) {
  let kept = 0   // el 里属于已完结块的子节点数
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

/** 事件委托：代码块「复制」按钮（渲染的 HTML 无法直接挂 React 事件） */
export function handleCodeCopyClick(e) {
  const btn = e.target?.closest?.('.codecopy')
  if (!btn) return
  const code = btn.closest('.codeblock')?.querySelector('code')
  if (!code) return
  void copyText(code.textContent).then(ok => {
    btn.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => { btn.textContent = '复制' }, 1200)
  })
}
