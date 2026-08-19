const { test } = require('node:test')
const assert = require('node:assert')
const { MAX_TEXT, buildQuickPrompt, hotkeyFailureNotice, quickAskPayload } = require('./quick-ask.js')

test('三个动作各自拼装指令且带原文；未知动作/空文本返回空串', () => {
  const t = '今天天气不错'
  assert.match(buildQuickPrompt('translate', t), /翻译[\s\S]*今天天气不错/)
  assert.match(buildQuickPrompt('explain', t), /解释[\s\S]*今天天气不错/)
  assert.match(buildQuickPrompt('rewrite', t), /改写[\s\S]*今天天气不错/)
  assert.strictEqual(buildQuickPrompt('nuke', t), '')
  assert.strictEqual(buildQuickPrompt('translate', '   '), '')
  assert.ok(buildQuickPrompt('translate', '长'.repeat(MAX_TEXT + 100)).length
    <= MAX_TEXT + 60)  // 原文截断，指令头不受影响
})

test('有辅助功能权限且抓到选中文字：直取，不降级', () => {
  const p = quickAskPayload({ accessibility: true, capturedText: ' 选中的话 ', clipboardText: '剪贴板旧货' })
  assert.deepStrictEqual(p, { text: '选中的话', degraded: false, notice: '' })
})

test('无权限走剪贴板降级，并给「去授权」提示', () => {
  const p = quickAskPayload({ accessibility: false, capturedText: '', clipboardText: '剪贴板内容' })
  assert.strictEqual(p.text, '剪贴板内容')
  assert.strictEqual(p.degraded, true)
  assert.match(p.notice, /辅助功能/)
})

test('有权限但没抓到字（比如没选中）：退剪贴板但不算降级、不弹授权提示', () => {
  const p = quickAskPayload({ accessibility: true, capturedText: '', clipboardText: '兜底' })
  assert.deepStrictEqual(p, { text: '兜底', degraded: false, notice: '' })
})

test('快捷键注册失败提示含快捷键本体，绝不静默', () => {
  assert.match(hotkeyFailureNotice('Alt+Q'), /Alt\+Q[\s\S]*注册失败/)
})
