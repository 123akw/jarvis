const { test } = require('node:test')
const assert = require('node:assert')
const { buildTrayMenuTemplate, wireTray } = require('./tray-setup.js')

function fakeTray() {
  const handlers = {}
  const calls = { popUp: [], setContextMenu: 0 }
  return {
    on: (ev, fn) => { handlers[ev] = fn },
    popUpContextMenu: menu => calls.popUp.push(menu),
    setContextMenu: () => { calls.setContextMenu += 1 },
    fire: ev => handlers[ev] && handlers[ev](),
    calls,
  }
}

test('菜单模板：五个动作齐全，重启项带当前版本号', () => {
  const hits = []
  const tpl = buildTrayMenuTemplate({
    onOpen: () => hits.push('open'), onVoice: () => hits.push('voice'),
    onSettings: () => hits.push('settings'), onRestart: () => hits.push('restart'),
    onQuit: () => hits.push('quit'), versionHash: 'abc1234',
  })
  const labels = tpl.filter(x => x.label).map(x => x.label)
  assert.deepStrictEqual(labels, ['打开对话', '语音通话', '设置', '重启贾维斯（当前 abc1234）', '退出贾维斯'])
  tpl.filter(x => x.click).forEach(x => x.click())
  assert.deepStrictEqual(hits, ['open', 'voice', 'settings', 'restart', 'quit'])
})

test('接线：左键切换悬浮窗，右键弹菜单', () => {
  const tray = fakeTray()
  let toggles = 0
  const menu = { id: 'menu' }
  wireTray(tray, { menu, onToggle: () => { toggles += 1 } })
  tray.fire('click')
  assert.strictEqual(toggles, 1)
  tray.fire('right-click')
  assert.deepStrictEqual(tray.calls.popUp, [menu])
})

test('绝不调用 setContextMenu（macOS 上它会吃掉左右键 electron#24196）', () => {
  const tray = fakeTray()
  wireTray(tray, { menu: {}, onToggle: () => {} })
  tray.fire('click'); tray.fire('right-click')
  assert.strictEqual(tray.calls.setContextMenu, 0)
})
