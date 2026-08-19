/* 划词悬浮工具条：选中文字 → 全局快捷键 → 小条三动作（翻译/解释/改写）。
 * 有辅助功能权限时主进程模拟 ⌘C 自动取词；无权限降级读剪贴板并提示可授权。
 * 本模块只有纯逻辑（指令拼装/降级取舍/提示文案），node --test 可直跑。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSQuickAsk = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  const MAX_TEXT = 4000

  const ACTIONS = {
    translate: {
      label: '翻译',
      build: t => `请翻译下面这段话：中文译成英文，其他语言译成中文；只给译文，不要解释。\n\n${t}`,
    },
    explain: {
      label: '解释',
      build: t => `请用大白话解释下面的内容，讲清它是什么、关键点在哪：\n\n${t}`,
    },
    rewrite: {
      label: '改写',
      build: t => `请把下面这段话改写得更通顺、更专业，保持原意，只给改写结果：\n\n${t}`,
    },
  }

  const AUTH_HINT = '授予「辅助功能」权限后，按快捷键可自动取到选中的文字；本次用的是剪贴板内容。'

  /** 动作 + 原文 → 发进对话流的完整指令；未知动作或空文本返回空串 */
  function buildQuickPrompt(action, text) {
    const spec = ACTIONS[action]
    const clean = (text || '').trim().slice(0, MAX_TEXT)
    if (!spec || !clean) return ''
    return spec.build(clean)
  }

  /** 取词决策：有权限用模拟 ⌘C 抓到的文字；没抓到/没权限降级剪贴板 */
  function quickAskPayload({ accessibility = false, capturedText = '', clipboardText = '' } = {}) {
    const captured = (capturedText || '').trim()
    const clip = (clipboardText || '').trim()
    if (accessibility && captured) {
      return { text: captured.slice(0, MAX_TEXT), degraded: false, notice: '' }
    }
    return {
      text: clip.slice(0, MAX_TEXT),
      degraded: !accessibility,
      notice: accessibility ? '' : AUTH_HINT,
    }
  }

  /** 快捷键注册失败的面板提示（不许静默） */
  function hotkeyFailureNotice(acc) {
    return `划词快捷键 ${acc} 注册失败（可能被其他程序占用），请到设置里换一个组合。`
  }

  return { ACTIONS, MAX_TEXT, buildQuickPrompt, quickAskPayload, hotkeyFailureNotice }
})
