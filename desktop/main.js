const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const BALL = { w: 92, h: 92 }
const PANEL = { w: 420, h: 640 }
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents/com.jws.jarvis.desktop.plist')
let win = null
let expanded = false

/* ---------- 设置持久化 ---------- */
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}
function loadSettings() {
  const defaults = { hotkey: 'Alt+Space', openAtLogin: false }
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) }
  } catch {
    return defaults
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
}

/* ---------- 开机自启：LaunchAgent（开发态运行也可靠） ---------- */
function setAutoLaunch(on) {
  if (on) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jws.jarvis.desktop</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${path.resolve(__dirname)}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>`
    fs.mkdirSync(path.dirname(PLIST), { recursive: true })
    fs.writeFileSync(PLIST, xml)
    try { execSync(`launchctl unload "${PLIST}" 2>/dev/null; launchctl load "${PLIST}"`) } catch {}
  } else {
    try { execSync(`launchctl unload "${PLIST}" 2>/dev/null`) } catch {}
    try { fs.unlinkSync(PLIST) } catch {}
  }
}

/* ---------- 全局唤醒快捷键 ---------- */
function applyHotkey(acc) {
  globalShortcut.unregisterAll()
  if (!acc) return true
  try {
    return globalShortcut.register(acc, summon)
  } catch {
    return false
  }
}

function summon() {
  if (!win) return
  win.show()
  toggleWindow()
  win.webContents.send('set-expanded', expanded)
  if (expanded) win.focus()
}

/* ---------- 窗口 ---------- */
function toggleWindow() {
  const b = win.getBounds()
  const { workArea } = screen.getDisplayMatching(b)
  if (!expanded) {
    let y = b.y
    if (y + PANEL.h > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - PANEL.h - 10
    }
    win.setBounds({ x: b.x + b.width - PANEL.w, y, width: PANEL.w, height: PANEL.h })
  } else {
    win.setBounds({ x: b.x + b.width - BALL.w, y: b.y, width: BALL.w, height: BALL.h })
  }
  expanded = !expanded
  return expanded
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    width: BALL.w,
    height: BALL.h,
    x: workArea.x + workArea.width - BALL.w - 20,
    y: workArea.y + Math.round(workArea.height * 0.32),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webSecurity: false, // 跨域直连服务器 API（个人桌面工具）
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile('index.html')
}

/* ---------- IPC ---------- */
ipcMain.handle('toggle', () => toggleWindow())
ipcMain.handle('collapse', () => {
  if (expanded) toggleWindow()
  return expanded
})
ipcMain.handle('get-settings', () => {
  const s = loadSettings()
  return { ...s, hotkeyOk: !!s.hotkey && globalShortcut.isRegistered(s.hotkey) }
})
ipcMain.handle('set-settings', (_e, patch) => {
  const s = { ...loadSettings(), ...patch }
  saveSettings(s)
  const hotkeyOk = applyHotkey(s.hotkey)
  try { setAutoLaunch(s.openAtLogin) } catch {}
  return { ...s, hotkeyOk }
})

app.whenReady().then(() => {
  createWindow()
  const s = loadSettings()
  applyHotkey(s.hotkey)
  // 自检截图模式：JWS_SHOT=/path/out.png [JWS_SHOT_VIEW=settings] npm start
  if (process.env.JWS_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const b = win.getBounds()
        win.setBounds({ x: b.x + b.width - PANEL.w, y: b.y, width: PANEL.w, height: PANEL.h })
        expanded = true
        win.webContents.send('force-expand')
        if (process.env.JWS_SHOT_VIEW === 'settings') {
          setTimeout(() => win.webContents.executeJavaScript(`
            document.querySelector('#setbtn').click()
            setTimeout(() => {
              document.querySelector('#hk-rec').click()
              setTimeout(() => {
                window.dispatchEvent(new KeyboardEvent('keydown',
                  { ctrlKey: true, code: 'Space', key: ' ', bubbles: true }))
              }, 350)
            }, 400)
          `), 800)
        }
        setTimeout(async () => {
          const img = await win.webContents.capturePage()
          fs.writeFileSync(process.env.JWS_SHOT, img.toPNG())
          app.quit()
        }, 3500)
      }, 1200)
    })
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => app.quit())
