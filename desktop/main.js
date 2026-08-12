const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, safeStorage } = require('electron')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { createSessionGateway, replaceSessionGateway } = require('./session.js')
const { createApiHandlers } = require('./ipc-api.js')
const { assertTrustedSender, hardenWindow, validateSettingsPatch } = require('./security.js')

const PANEL = { w: 420, h: 640 }
const ballWin = size => size + 8  // 球体 + 辉光留白
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents/com.jws.jarvis.desktop.plist')
const INDEX_PATH = path.join(__dirname, 'index.html')
const INDEX_URL = pathToFileURL(INDEX_PATH).href
let win = null
let expanded = false
let apiGateway = null

/* ---------- 设置持久化 ---------- */
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}
function loadSettings() {
  const defaults = { hotkey: 'Alt+Space', openAtLogin: false, ballSize: 64, ballStyle: 'moss', server: 'https://jws.gkgeek-set.cn' }
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) }
  } catch {
    return defaults
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.chmodSync(settingsPath(), 0o600)
}

function gatewayFor(server) {
  return createSessionGateway({ fetchImpl: fetch, safeStorage, fs, path, dataDir: app.getPath('userData'),
    server, development: process.env.JWS_DESKTOP_DEV === '1' })
}
function gateway() {
  if (!apiGateway) apiGateway = gatewayFor(loadSettings().server)
  return apiGateway
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
  const bw = ballWin(loadSettings().ballSize)
  if (!expanded) {
    let y = b.y
    if (y + PANEL.h > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - PANEL.h - 10
    }
    win.setBounds({ x: b.x + b.width - PANEL.w, y, width: PANEL.w, height: PANEL.h })
  } else {
    win.setBounds({ x: b.x + b.width - bw, y: b.y, width: bw, height: bw })
  }
  expanded = !expanded
  return expanded
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const bw = ballWin(loadSettings().ballSize)
  win = new BrowserWindow({
    width: bw,
    height: bw,
    x: workArea.x + workArea.width - bw - 20,
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
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  hardenWindow(win, INDEX_URL)
  win.loadFile(INDEX_PATH)
}

/* ---------- Claude Code 编程进度采集（读 ~/.claude/projects 会话记录） ---------- */
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')

function gitInfo(cwd) {
  if (!cwd) return {}
  const opt = { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opt).toString().trim()
    const dirty = execSync('git status --porcelain', opt).toString().split('\n').filter(Boolean).length
    const log = execSync('git log --since=midnight --pretty=%s', opt).toString().split('\n').filter(Boolean)
    return { branch, dirty, commits_today: log.length, last_commit: (log[0] || '').slice(0, 50) }
  } catch { return {} }
}

function extractDetail(file) {
  const detail = { task: '', step: '', files: [], cwd: '' }
  try {
    const sz = fs.statSync(file).size
    const len = Math.min(sz, 262144)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    fs.readSync(fd, buf, 0, len, sz - len)
    fs.closeSync(fd)
    const text = buf.toString('utf-8')
    const cwdHit = text.match(/"cwd":"([^"]+)"/)
    if (cwdHit) detail.cwd = cwdHit[1]
    for (const line of text.split('\n').reverse()) {
      if (!detail.task && line.includes('"type":"user"')) {
        try {
          const j = JSON.parse(line)
          let c = j.message && j.message.content
          if (Array.isArray(c)) {
            const t = c.find(x => x && x.type === 'text')
            c = t && t.text
          }
          if (typeof c === 'string' && c.trim() && !c.trim().startsWith('<')) {
            detail.task = c.trim().replace(/\s+/g, ' ').slice(0, 80)
          }
        } catch { /* 跳过坏行 */ }
      }
      if (line.includes('"tool_use"') && (!detail.step || detail.files.length < 3)) {
        try {
          const j = JSON.parse(line)
          const items = (j.message && j.message.content) || []
          if (!Array.isArray(items)) continue
          for (const it of items) {
            if (!it || it.type !== 'tool_use') continue
            const inp = it.input || {}
            if (!detail.step) {
              const target = inp.file_path
                ? inp.file_path.split('/').slice(-2).join('/')
                : (inp.description || inp.command || inp.query || '')
              detail.step = `${it.name} ${String(target).replace(/\s+/g, ' ').slice(0, 48)}`.trim()
            }
            if (inp.file_path && ['Edit', 'Write', 'NotebookEdit'].includes(it.name)) {
              const base = inp.file_path.split('/').pop()
              if (!detail.files.includes(base) && detail.files.length < 3) detail.files.push(base)
            }
          }
        } catch { /* 跳过坏行 */ }
      }
      if (detail.task && detail.step && detail.files.length >= 3) break
    }
  } catch { /* 文件读不了就算了 */ }
  return detail
}

function collectCoding() {
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS) } catch { return out }
  for (const d of dirs) {
    const dir = path.join(CLAUDE_PROJECTS, d)
    let newest = null
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue
        const st = fs.statSync(path.join(dir, f))
        if (!newest || st.mtimeMs > newest.m) newest = { f: path.join(dir, f), m: st.mtimeMs }
      }
    } catch { continue }
    if (!newest || Date.now() - newest.m > 48 * 3600000) continue
    const { cwd, ...detail } = extractDetail(newest.f)
    out.push({
      project: d.replace(/^-Users-[^-]+-/, '') || d,
      active: Date.now() - newest.m < 10 * 60000,
      last_active: new Date(newest.m).toLocaleString('zh-CN',
        { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      ...detail,
      ...gitInfo(cwd),
      _m: newest.m,
    })
  }
  out.sort((a, b) => b._m - a._m)
  return out.slice(0, 5).map(({ _m, ...rest }) => rest)
}

/* ---------- 悬浮球 JS 拖动（整球可拖，松手未移动视为点击） ---------- */
let dragOffset = null
function trusted(event) { assertTrustedSender(event, win, INDEX_URL) }

ipcMain.on('ball-drag-start', (event, point) => {
  trusted(event)
  if (!point || !Number.isFinite(point.mx) || !Number.isFinite(point.my)) return
  const { mx, my } = point
  const [wx, wy] = win.getPosition()
  dragOffset = { ox: mx - wx, oy: my - wy }
})
ipcMain.on('ball-drag-move', (event, point) => {
  trusted(event)
  if (!point || !Number.isFinite(point.mx) || !Number.isFinite(point.my)) return
  const { mx, my } = point
  if (!dragOffset) return
  win.setPosition(Math.round(mx - dragOffset.ox), Math.round(my - dragOffset.oy))
})
ipcMain.on('ball-drag-end', event => { trusted(event); dragOffset = null })

/* ---------- IPC ---------- */
ipcMain.handle('clipboard-text', event => { trusted(event); return clipboard.readText() || '' })
ipcMain.handle('coding-status', event => { trusted(event); return collectCoding() })
ipcMain.handle('toggle', event => { trusted(event); return toggleWindow() })
ipcMain.handle('collapse', event => {
  trusted(event)
  if (expanded) toggleWindow()
  return expanded
})
ipcMain.handle('show-login', event => {
  trusted(event)
  if (!expanded) toggleWindow()
  win.show(); win.focus()
  win.webContents.send('set-expanded', true)
  return true
})
ipcMain.handle('get-settings', event => {
  trusted(event)
  const s = loadSettings()
  return { ...s, hotkeyOk: !!s.hotkey && globalShortcut.isRegistered(s.hotkey) }
})
ipcMain.handle('set-settings', (event, suppliedPatch) => {
  trusted(event)
  const previous = loadSettings()
  const patch = validateSettingsPatch(suppliedPatch, process.env.JWS_DESKTOP_DEV === '1')
  const candidate = { ...previous, ...patch }
  const s = candidate
  if (s.server !== previous.server) {
    const currentGateway = apiGateway
    apiGateway = null
    apiGateway = replaceSessionGateway({ currentGateway, previousSettings: previous, nextSettings: s,
      createGateway: gatewayFor, persistSettings: saveSettings })
  } else saveSettings(s)
  const hotkeyOk = applyHotkey(s.hotkey)
  try { setAutoLaunch(s.openAtLogin) } catch {}
  if (!expanded && win) {  // 收起态下即时按新尺寸重排（右缘钉住）
    const b = win.getBounds()
    const bw = ballWin(s.ballSize)
    win.setBounds({ x: b.x + b.width - bw, y: b.y, width: bw, height: bw })
  }
  return { ...s, hotkeyOk }
})

const apiHandlers = createApiHandlers({
  gateway: {
    login: (...args) => gateway().login(...args),
    request: (...args) => gateway().request(...args),
    stream: (...args) => gateway().stream(...args),
  },
  getWindow: () => win,
  indexUrl: INDEX_URL,
})
ipcMain.handle('api-login', apiHandlers.login)
ipcMain.handle('api-request', apiHandlers.request)
ipcMain.handle('api-stream-start', apiHandlers.start)
ipcMain.handle('api-stream-cancel', apiHandlers.cancel)

app.whenReady().then(() => {
  createWindow()
  const s = loadSettings()
  applyHotkey(s.hotkey)
  // 自检截图模式：JWS_SHOT=/path/out.png [JWS_SHOT_VIEW=settings] npm start
  if (process.env.JWS_SHOT) {
    win.webContents.once('did-finish-load', () => {
      if (process.env.JWS_SHOT_VIEW === 'ball') {
        setTimeout(async () => {
          const img = await win.webContents.capturePage()
          fs.writeFileSync(process.env.JWS_SHOT, img.toPNG())
          app.quit()
        }, 2200)
        return
      }
      setTimeout(async () => {
        const b = win.getBounds()
        win.setBounds({ x: b.x + b.width - PANEL.w, y: b.y, width: PANEL.w, height: PANEL.h })
        expanded = true
        win.webContents.send('force-expand')
        if (process.env.JWS_SHOT_VIEW === 'board') {
          setTimeout(() => win.webContents.executeJavaScript(
            "document.querySelector('#boardbtn').click()"), 900)
        }
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
