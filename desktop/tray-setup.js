/* 系统托盘接线：macOS 上 tray.setContextMenu 会接管左右键（electron#24196），
 * 之后 click 事件不再触发。官方推荐姿势：不设 setContextMenu，左键自己处理、
 * 右键手动 popUpContextMenu。注意 popUpContextMenu 会阻塞主进程直到菜单关闭
 * （electron#13820 官方已知），菜单挂着期间后台定时器停摆属预期。
 * 本模块只做纯接线，Tray/Menu 全注入，node --test 可直跑。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSTraySetup = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  /** 托盘菜单模板：打开对话/语音通话/设置/重启（带当前版本）/退出 */
  function buildTrayMenuTemplate({ onOpen, onVoice, onSettings, onRestart, onQuit, versionHash }) {
    return [
      { label: '打开对话', click: onOpen },
      { label: '语音通话', click: onVoice },
      { label: '设置', click: onSettings },
      { type: 'separator' },
      { label: `重启贾维斯（当前 ${versionHash}）`, click: onRestart },
      { label: '退出贾维斯', click: onQuit },
    ]
  }

  /** 接线：左键切换悬浮窗，右键弹菜单；绝不调用 setContextMenu */
  function wireTray(tray, { menu, onToggle }) {
    tray.on('click', () => onToggle())
    tray.on('right-click', () => tray.popUpContextMenu(menu))
  }

  return { buildTrayMenuTemplate, wireTray }
})
