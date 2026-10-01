import { describe, expect, it } from 'vitest'

import {
  createStreamingMarkdown, createStreamingView, loadHighlighter, renderMarkdown,
} from './markdown.js'

describe('Markdown 渲染引擎', () => {
  it('链接渲染为可点击的新窗口安全外链', () => {
    const html = renderMarkdown('来源：[南方周末](https://www.infzm.com/a) 与裸链 https://example.com/x')
    expect(html).toContain('<a')
    expect(html).toContain('href="https://www.infzm.com/a"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('href="https://example.com/x"')  // 裸 URL 自动成链
  })

  it('GFM 表格渲染为真表格', () => {
    const html = renderMarkdown('| 平台 | 评分 |\n| --- | --- |\n| 豆瓣 | 8.9 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>平台</th>')
    expect(html).toContain('<td>豆瓣</td>')
  })

  it('代码块带语言高亮与独立复制按钮（高亮器按需懒加载）', async () => {
    await loadHighlighter()
    const html = renderMarkdown('```python\nprint("hi")\n```')
    expect(html).toContain('language-python')
    expect(html).toContain('hljs-')          // 高亮 token
    expect(html).toContain('class="codecopy"')
    expect(html).toContain('<span class="codelang">python</span>')
  })

  it('流式中未闭合代码块自动补全并带光标', () => {
    const html = renderMarkdown('```js\nconst a = 1', { streaming: true })
    expect(html).toContain('<pre><code')
    expect(html).toContain('class="caret"')
  })

  it('危险 HTML 被消毒:script 与事件属性不落地', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)>点我')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
  })

  it('javascript: 协议链接被 DOMPurify 拦截', () => {
    const html = renderMarkdown('[x](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('引用块、粗体、行内代码与任务列表照常渲染', () => {
    const html = renderMarkdown('> 引用\n\n**重点** `code`\n\n- [ ] 待办项')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('type="checkbox"')
  })
})

const DOC = [
  '### 标题', '第一段正文，带 **加粗** 与 [链接](https://example.com)。',
  '1. **要点一**\n\n   松散列表的续行段落\n\n2. **要点二**\n   - 子项 A\n   - 子项 B',
  '收尾段落顶格，结束上面的列表。',
  '```python\ndef f():\n\n    return 1\n\n\nprint(f())\n```',
  '| 平台 | 评分 |\n| --- | --- |\n| 豆瓣 | 8.9 |',
  '> 引用一行\n> 引用两行', '- [ ] 待办', '最后一句。',
].join('\n\n')

function feed(stream, text, size = 3) {
  let raw = ''
  const out = []
  for (let i = 0; i < text.length; i += size) { raw += text.slice(i, i + size); out.push(stream.update(raw)) }
  return out
}

describe('流式增量渲染', () => {
  it('逐 token 增量拼出的定稿结果与一次性全量渲染逐字节一致', () => {
    const s = createStreamingMarkdown()
    feed(s, DOC)
    expect(s.update(DOC, { final: true }).html).toBe(renderMarkdown(DOC))
  })

  it('已完结块只产出一次，之后的更新只重渲染尾巴', () => {
    const s = createStreamingMarkdown()
    const steps = feed(s, DOC)
    const appended = steps.map(r => r.appendHtml).join('')
    const last = steps[steps.length - 1]
    expect(appended.length).toBeGreaterThan(0)
    expect(last.html).toBe(appended + last.tailHtml)
    expect(steps.filter(r => r.appendHtml).length).toBeGreaterThan(3)   // 确实分块提交了
  })

  it('围栏代码块里的空行不会被当成切点（代码块不被拆开）', () => {
    const s = createStreamingMarkdown()
    const code = '前言\n\n```js\nconst a = 1\n\n\nconst b = 2\n```\n\n后记'
    const steps = feed(s, code, 1)
    for (const r of steps) expect((r.appendHtml.match(/<pre>/g) || []).length).toBeLessThanOrEqual(1)
    expect(steps[steps.length - 1].html.match(/<pre>/g)).toHaveLength(1)
  })

  it('全文被替换（非追加）时自动从头重来', () => {
    const s = createStreamingMarkdown()
    s.update('第一版\n\n第二段\n')
    const r = s.update('完全不同的回答')
    expect(r.reset).toBe(true)
    expect(r.html).toContain('完全不同的回答')
    expect(r.html).not.toContain('第一版')
  })

  it('DOM 视图：已完结块的节点跨更新保持同一实例，不被反复重建', () => {
    const el = document.createElement('div')
    const view = createStreamingView(el)
    view.update('第一段。\n\n第二段')
    view.update('第一段。\n\n第二段继续\n\n第三')
    const first = el.querySelector('p')
    expect(first.textContent).toBe('第一段。')
    view.update('第一段。\n\n第二段继续\n\n第三段写完了')
    expect(el.querySelector('p')).toBe(first)
    expect(el.textContent).toContain('第三段写完了')
    expect(el.querySelectorAll('.caret')).toHaveLength(1)
  })
})
