'use strict'

const { isAllowedServer } = require('./session.js')

function assertTrustedSender(event, win, indexUrl) {
  const contents = win && win.webContents
  if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== indexUrl) {
    throw new Error('untrusted IPC sender')
  }
}

function hardenWindow(win, indexUrl) {
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== indexUrl) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function validateSettingsPatch(patch, development = false) {
  if (!record(patch)) throw new Error('settings patch must be an object')
  const allowed = new Set(['hotkey', 'openAtLogin', 'ballSize', 'ballStyle', 'server'])
  const keys = Object.keys(patch)
  if (!keys.length || keys.some(key => !allowed.has(key))) throw new Error('settings field is not allowed')
  const out = {}
  if ('hotkey' in patch) {
    if (typeof patch.hotkey !== 'string' || patch.hotkey.length > 64 || /[\r\n\0]/.test(patch.hotkey)) throw new Error('invalid hotkey')
    out.hotkey = patch.hotkey
  }
  if ('openAtLogin' in patch) {
    if (typeof patch.openAtLogin !== 'boolean') throw new Error('invalid openAtLogin')
    out.openAtLogin = patch.openAtLogin
  }
  if ('ballSize' in patch) {
    if (!Number.isInteger(patch.ballSize) || patch.ballSize < 44 || patch.ballSize > 120) throw new Error('invalid ballSize')
    out.ballSize = patch.ballSize
  }
  if ('ballStyle' in patch) {
    if (!['moss', 'mini', 'img'].includes(patch.ballStyle)) throw new Error('invalid ballStyle')
    out.ballStyle = patch.ballStyle
  }
  if ('server' in patch) {
    if (typeof patch.server !== 'string' || patch.server.length > 2048 || !isAllowedServer(patch.server, development)) throw new Error('invalid server')
    out.server = patch.server.replace(/\/$/, '')
  }
  return out
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

module.exports = { assertTrustedSender, hardenWindow, validateSettingsPatch }
