import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown.js'

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

  it('代码块带语言高亮与独立复制按钮', () => {
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
