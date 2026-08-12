const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')

const { assertTrustedSender, hardenWindow, validateSettingsPatch } = require('./security.js')

test('IPC trusts only the current local index main frame', () => {
  const mainFrame = { url: 'file:///app/index.html' }
  const win = { webContents: { mainFrame } }
  assert.doesNotThrow(() => assertTrustedSender({ sender: win.webContents, senderFrame: mainFrame }, win, mainFrame.url))
  assert.throws(() => assertTrustedSender({ sender: {}, senderFrame: mainFrame }, win, mainFrame.url), /untrusted/i)
  assert.throws(() => assertTrustedSender({ sender: win.webContents, senderFrame: { url: mainFrame.url } }, win, mainFrame.url), /untrusted/i)
  assert.throws(() => assertTrustedSender({ sender: win.webContents, senderFrame: { url: 'https://evil.test' } }, win, mainFrame.url), /untrusted/i)
})

test('window hardening prevents navigation and all new windows', () => {
  const webContents = new EventEmitter()
  let openHandler
  webContents.setWindowOpenHandler = handler => { openHandler = handler }
  hardenWindow({ webContents }, 'file:///app/index.html')
  const same = { prevented: false, preventDefault() { this.prevented = true } }
  const foreign = { prevented: false, preventDefault() { this.prevented = true } }
  webContents.emit('will-navigate', same, 'file:///app/index.html')
  webContents.emit('will-navigate', foreign, 'https://evil.test/')
  assert.equal(same.prevented, false)
  assert.equal(foreign.prevented, true)
  assert.deepEqual(openHandler({ url: 'https://example.test' }), { action: 'deny' })
})

test('settings patch rejects extra fields and invalid types or limits', () => {
  assert.deepEqual(validateSettingsPatch({ server: 'https://self-host.test' }, false), { server: 'https://self-host.test' })
  assert.deepEqual(validateSettingsPatch({ ballSize: 44, ballStyle: 'mini', openAtLogin: true, hotkey: 'Alt+Space' }, false),
    { ballSize: 44, ballStyle: 'mini', openAtLogin: true, hotkey: 'Alt+Space' })
  assert.throws(() => validateSettingsPatch({ server: 'https://ok.test', injected: true }, false), /field/i)
  assert.throws(() => validateSettingsPatch({ ballSize: 1000 }, false), /ballSize/)
  assert.throws(() => validateSettingsPatch({ hotkey: 'x'.repeat(65) }, false), /hotkey/)
})
