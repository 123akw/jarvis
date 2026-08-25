const { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, safeStorage, shell, systemPreferences, Tray } = require('electron')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { createSessionGateway, replaceSessionGateway } = require('./session.js')
const { createApiHandlers } = require('./ipc-api.js')
const { assertTrustedSender, hardenWindow, validateSettingsPatch } = require('./security.js')
const { isAllowedProviderLink } = require('./provider-links.js')
const { createWakeServer, parseHandoffUrl } = require('./wake-server.js')
const { buildAppInfo, restartApp } = require('./app-info.js')
const { buildTrayMenuTemplate, wireTray } = require('./tray-setup.js')
const { hotkeyFailureNotice, quickAskPayload } = require('./quick-ask.js')

/* macOS 系统回环音频（会议纪要录「对方」声音）需显式开 Chromium 特性；
 * 三个开关分别覆盖 macOS 13/14/15+ 的三代实现，未知特性名会被静默忽略。 */
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features',
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride,MacCatapSystemAudioLoopbackCapture')
}

// 自检截图可用独立 userData（JWS_SHOT_USERDATA=/tmp/xxx）：避免与常驻实例抢
// Chromium 配置锁（同 profile 双开会卡在页面加载）。必须在 ready 前设置。
if (process.env.JWS_SHOT_USERDATA) {
  try { app.setPath('userData', process.env.JWS_SHOT_USERDATA) } catch { /* 沿用默认 */ }
}

const PANEL = { w: 420, h: 640 }
const ballWin = size => size + 8  // 球体 + 辉光留白
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents/com.jws.jarvis.desktop.plist')
const INDEX_PATH = path.join(__dirname, 'index.html')
const INDEX_URL = pathToFileURL(INDEX_PATH).href
let win = null
let expanded = false
let apiGateway = null
const APP_INFO = buildAppInfo({ execSync, dirname: __dirname, version: app.getVersion(), startedAt: Date.now() })

/* ---------- 设置持久化 ---------- */
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}
function loadSettings() {
  const defaults = { hotkey: 'Alt+Space', quickAskHotkey: 'Alt+Q', openAtLogin: false, ballSize: 64, ballStyle: 'moss', server: 'https://jws.gkgeek-set.cn', wakeWordEnabled: true }
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

/* ---------- 开机自启：macOS 走 LaunchAgent（开发态运行也可靠），Windows 走系统登录项 ---------- */
function setAutoLaunch(on) {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: on, args: [path.resolve(__dirname)] })
    return
  }
  if (process.platform !== 'darwin') return  // Linux 暂不支持
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

/* ---------- 全局快捷键：唤醒 + 划词问 ---------- */
function safeRegister(acc, handler) {
  try {
    return globalShortcut.register(acc, handler)
  } catch {
    return false
  }
}

function applyHotkeys(s) {
  globalShortcut.unregisterAll()
  const hotkeyOk = !s.hotkey || safeRegister(s.hotkey, summon)
  const quickAskOk = !s.quickAskHotkey || safeRegister(s.quickAskHotkey, () => { void triggerQuickAsk() })
  if (s.quickAskHotkey && !quickAskOk && win) {   // 注册失败不许静默：面板给人话提示
    win.webContents.send('wake-server-notice', hotkeyFailureNotice(s.quickAskHotkey))
  }
  return { hotkeyOk, quickAskOk }
}

function summon() {
  if (!win) return
  ballHidden = false
  win.show()
  toggleWindow()
  win.webContents.send('set-expanded', expanded)
  if (expanded) win.focus()
}

/* ---------- 划词问：快捷键取词 → 弹小条（翻译/解释/改写） ---------- */
function hasAccessibility() {
  if (process.platform !== 'darwin') return true   // 非 macOS 无此权限概念
  try { return systemPreferences.isTrustedAccessibilityClient(false) } catch { return false }
}

async function triggerQuickAsk() {
  if (!win) return
  let captured = ''
  const accessibility = hasAccessibility()
  if (accessibility && process.platform === 'darwin') {
    try {
      // 模拟 ⌘C 把当前选中文字送进剪贴板；System Events 正需要辅助功能权限
      execSync(`osascript -e 'tell application "System Events" to keystroke "c" using command down'`,
        { timeout: 2000 })
      await new Promise(resolve => setTimeout(resolve, 180))
      captured = clipboard.readText() || ''
    } catch { /* 取词失败走剪贴板降级 */ }
  }
  const payload = quickAskPayload({
    accessibility, capturedText: captured, clipboardText: clipboard.readText() || '',
  })
  if (!payload.text) return   // 啥都没有就不打扰
  win.show()
  if (!expanded) toggleWindow()
  win.webContents.send('set-expanded', true)
  win.focus()
  win.webContents.send('quick-ask', payload)
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

/* ---------- 语音通话：麦克风权限 + WS 握手令牌注入 ----------
 * 渲染进程用原生 WebSocket 连 wss://…/api/voice/call；桌面令牌只存在于主进程，
 * 在这里对该精确 URL 的握手请求注入 X-JWS-Token 头（jarvis/voice/gateway.py 的
 * desktop 鉴权路径）。渲染进程永远拿不到令牌。 */
function setupVoiceSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const audioOnly = !details || !Array.isArray(details.mediaTypes)
      || details.mediaTypes.every(t => t === 'audio')
    callback(permission === 'media' && win && wc === win.webContents && audioOnly)
  })
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'microphone')
  ses.webRequest.onBeforeSendHeaders({ urls: ['wss://*/*', 'ws://*/*'] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders }
    try {
      const g = gateway()
      if (details.url === g.voiceCallUrl() || details.url === g.meetingStreamUrl()) {
        const token = g.authToken()
        if (token) requestHeaders['X-JWS-Token'] = token
      }
    } catch { /* 网关未就绪则不注入，服务端会按未登录拒绝 */ }
    callback({ requestHeaders })
  })
  // 会议纪要的系统回环音频：getDisplayMedia 只服务本窗口，视频轨是门票（渲染层拿到即停），
  // 音频指到系统 loopback（配合文件顶部的 Chromium 特性开关）。
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!win || request.frame !== win.webContents.mainFrame) { callback({}); return }
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      if (!sources.length) { callback({}); return }
      callback({ video: sources[0], audio: 'loopback' })
    }).catch(() => callback({}))
  })
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
      // Electron 38 默认沙箱化 preload 只有 polyfill require（不认 crypto/相对模块），
      // 现有多文件 CommonJS preload 直接加载失败（实测主仓库同样复现）。
      // 关沙箱恢复 preload 的 Node require；contextIsolation/nodeIntegration 姿势不变。
      sandbox: false,
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  hardenWindow(win, INDEX_URL)
  setupVoiceSession(win.webContents.session)
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
ipcMain.handle('quick-ask-authorize', event => {
  trusted(event)
  if (process.platform !== 'darwin') return true
  try {
    // prompt=true：用户点了「去授权」才引导去系统设置，绝不启动即弹
    return systemPreferences.isTrustedAccessibilityClient(true)
  } catch {
    return false
  }
})
ipcMain.handle('meeting-screen-access', event => {
  trusted(event)
  if (process.platform !== 'darwin') return 'granted'
  // 屏幕录制/系统音频权限没有编程式请求入口，只能读状态；未授权时渲染层给指引
  try { return systemPreferences.getMediaAccessStatus('screen') } catch { return 'unknown' }
})
ipcMain.handle('voice-mic-access', async event => {
  trusted(event)
  if (process.platform !== 'darwin') return true
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
  try {
    return await systemPreferences.askForMediaAccess('microphone') // macOS 首次弹系统授权
  } catch {
    return false
  }
})
ipcMain.handle('open-provider-link', async (event, url) => {
  trusted(event)
  if (!isAllowedProviderLink(url)) throw new Error('provider link is not allowed')
  await shell.openExternal(url)
  return true
})
ipcMain.handle('open-external-link', async (event, url) => {
  trusted(event)
  let parsed
  try { parsed = new URL(String(url)) } catch { throw new Error('link is not allowed') }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('link is not allowed')
  await shell.openExternal(parsed.toString())  // 回答里的来源链接交给系统浏览器
  return true
})
ipcMain.handle('get-settings', event => {
  trusted(event)
  const s = loadSettings()
  return { ...s, hotkeyOk: !!s.hotkey && globalShortcut.isRegistered(s.hotkey),
    quickAskOk: !!s.quickAskHotkey && globalShortcut.isRegistered(s.quickAskHotkey), appInfo: APP_INFO }
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
  const { hotkeyOk, quickAskOk } = applyHotkeys(s)
  try { setAutoLaunch(s.openAtLogin) } catch {}
  if (!expanded && win) {  // 收起态下即时按新尺寸重排（右缘钉住）
    const b = win.getBounds()
    const bw = ballWin(s.ballSize)
    win.setBounds({ x: b.x + b.width - bw, y: b.y, width: bw, height: bw })
  }
  return { ...s, hotkeyOk, quickAskOk }
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

/* ---------- 悬浮球显隐：网页端设置/托盘均可控；隐藏前先收成球，避免面板态残留 ---------- */
let ballHidden = false
function setBallVisible(visible) {
  if (!win) return
  ballHidden = !visible
  if (visible) {
    win.show()
  } else {
    if (expanded) toggleWindow()
    win.webContents.send('set-expanded', false)
    win.hide()
  }
}

/* ---------- 网页↔桌面接管：本机唤起监听 + jws:// 协议 ----------
 * 监听只绑 127.0.0.1:17789；票据只在主进程转手（gateway().exchange），
 * 不进渲染进程、不落盘、不写日志。端口被占用则降级为面板提示，不崩。 */
let wakeServer = null

function summonForHandoff() {
  if (!win) return
  ballHidden = false
  win.show()
  if (!expanded) toggleWindow()
  win.webContents.send('set-expanded', true)
  win.focus()
}

async function handleHandoffTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') return { ok: false }
  let g
  try { g = gateway() } catch { return { ok: false } }
  if (g.authToken()) return { ok: true, already: true }  // 已登录不再换票
  const result = await g.exchange(ticket)
  if (result.ok && win) win.webContents.send('handoff-authenticated')
  return result
}

function startWakeServer() {
  let serverOrigin = ''
  try { serverOrigin = new URL(loadSettings().server).origin } catch {}
  wakeServer = createWakeServer({
    serverOrigin,
    isLoggedIn: () => { try { return Boolean(gateway().authToken()) } catch { return false } },
    onWake: summonForHandoff,
    onWindowAction: action => {
      if (action === 'show') setBallVisible(true)
      else if (action === 'hide') setBallVisible(false)
      else if (action === 'quit') app.quit()   // 网页端「彻底关闭桌面端」
    },
    exchangeTicket: ticket => handleHandoffTicket(ticket),
    onUnavailable: () => {
      if (win) win.webContents.send('wake-server-notice',
        '本机唤起端口 17789 被占用，网页端「桌面悬浮窗」暂时联系不上我；关掉占用该端口的程序后重启本应用即可恢复。')
    },
  })
  void wakeServer.start()
}

/* jws:// 自定义协议 best-effort：打包后才可靠，dev 尽力而为。 */
function handleProtocolUrl(url) {
  const parsed = parseHandoffUrl(url)
  if (!parsed) return
  summonForHandoff()
  void handleHandoffTicket(parsed.ticket).catch(() => {})
}
try { app.setAsDefaultProtocolClient('jws') } catch {}
try { app.requestSingleInstanceLock() } catch {}
app.on('open-url', (event, url) => { event.preventDefault(); handleProtocolUrl(url) })
app.on('second-instance', (_event, argv) => {
  const link = (argv || []).find(item => typeof item === 'string' && item.startsWith('jws://'))
  if (link) handleProtocolUrl(link)
})

/* ---------- 系统托盘：悬浮球之外的常驻入口（含唯一的显式退出） ---------- */
// 32x32 模板图（黑+alpha，圆环+核心），macOS 菜单栏自动适配深浅色
const TRAY_ICON_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAdUlEQVR42u1XQQ7AMAjq/z/t7kt6gOKgiyTeDNJYLV1rcDHqFZaiu7AVbhGCEMtFsGQSEYpT0BzKPlJcVgEd4wRxIsloHiSA2QvHYusDAXWaxG6//whobYH9EkaNoW0RzVsQ8RxHGJIISxZhSiNseczHZCDHAzhw4x0XbRj0AAAAAElFTkSuQmCC'
let tray = null

function ensureExpanded() {
  if (!win) return
  ballHidden = false
  if (!expanded) toggleWindow()
  win.show()
  win.focus()
  win.webContents.send('set-expanded', true)
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATAURL)
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('J.A.R.V.I.S. 贾维斯')
  const menu = Menu.buildFromTemplate(buildTrayMenuTemplate({
    onOpen: () => ensureExpanded(),
    onVoice: () => { ensureExpanded(); win.webContents.send('tray-command', 'voice') },
    onMeeting: () => { ensureExpanded(); win.webContents.send('tray-command', 'meeting') },
    onToggleBall: () => setBallVisible(ballHidden),
    onSettings: () => { ensureExpanded(); win.webContents.send('tray-command', 'settings') },
    onRestart: () => restartApp(app),
    onQuit: () => app.quit(),
    versionHash: APP_INFO.hash,
  }))
  wireTray(tray, { menu, onToggle: summon })
}

/* 桌面指令轮询：登录态下每 10 秒领取服务端指令（对话里「监控会议」由此送达），
 * 顺带同步网页端设置的悬浮球显隐偏好（只在偏好变化时应用，不跟托盘手动操作打架）。 */
let lastBallVisiblePref = true   // 应用启动时球可见；离线期间存下的「隐藏」首轮就要生效
function applyDesktopCommands(data) {
  const visible = data && data.ball_visible
  if (typeof visible === 'boolean' && visible !== lastBallVisiblePref) {
    setBallVisible(visible)
    lastBallVisiblePref = visible
  }
  const commands = data && Array.isArray(data.commands) ? data.commands : []
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== 'object') continue
    if (cmd.command === 'meeting-start') {
      ensureExpanded()
      win.webContents.send('meeting-command', { action: 'start', title: String(cmd.title || '').slice(0, 60) })
    } else if (cmd.command === 'meeting-stop') {
      win.webContents.send('meeting-command', { action: 'stop' })
    }
  }
}
function startCommandPolling() {
  setInterval(async () => {
    try {
      const g = gateway()
      if (!g.authToken()) return
      const r = await g.request('desktopCommands', {})
      if (r.ok) applyDesktopCommands(r.data)
    } catch { /* 离线或服务器不可达时静默，下一轮再试 */ }
  }, 10 * 1000)
}

/* 日程主动提醒：登录态下每分钟领取一次到点日程，弹系统通知（服务端按通道只发一次） */
function startReminderPolling() {
  setInterval(async () => {
    try {
      const g = gateway()
      if (!g.authToken()) return
      const r = await g.request('remindersPending', {})
      if (!r.ok || !Array.isArray(r.data?.items)) return
      for (const item of r.data.items) {
        if (Notification.isSupported()) {
          new Notification({
            title: '贾维斯 · 日程提醒',
            body: `${String(item.when || '').slice(11)} ${item.title || ''}`.trim(),
          }).show()
        }
      }
    } catch { /* 离线或服务器不可达时静默，下一轮再试 */ }
  }, 60 * 1000)
}

app.whenReady().then(() => {
  createWindow()
  createTray()
  const s = loadSettings()
  applyHotkeys(s)
  startWakeServer()
  startReminderPolling()
  startCommandPolling()
  // 自检截图模式：JWS_SHOT=/path/out.png [JWS_SHOT_VIEW=settings] npm start
  if (process.env.JWS_SHOT) {
    win.webContents.once('did-finish-load', () => {
      if (process.env.JWS_SHOT_VIEW === 'ball') {
        setTimeout(async () => {
          const phase = process.env.JWS_SHOT_BALL_PHASE  // listening|thinking|speaking：拍通话态外显
          if (phase) {
            await win.webContents.executeJavaScript(
              `new Promise(done => {
                 window.JWSVoiceBall.applyBallPhase(document.body.classList, ${JSON.stringify(phase)})
                 requestAnimationFrame(() => setTimeout(done, 250))
               })`)
          }
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
        if (process.env.JWS_SHOT_VIEW === 'meeting') {  // 会议纪要面板演示态（自检截图用）
          setTimeout(() => win.webContents.executeJavaScript(`
            document.body.classList.remove('needs-login')
            document.body.classList.add('show-meeting', 'on-meeting')
            document.querySelector('#meeting').className = 'recording'
            document.querySelector('#m-phase').textContent = '监控中（我+对方双路转写）'
            document.querySelector('#m-count').textContent = '6 段'
            document.querySelector('#m-captions').innerHTML = [
              '<div class="m-line"><b>我</b>主要瓶颈在多群聊切换和录入正文，快则十二秒慢则三十秒。</div>',
              '<div class="m-line"><b>对方</b>对，之前就是这个问题，读消息其实不需要焦点。</div>',
              '<div class="m-line"><b>我</b>那把焦点操作放主线程，发送走队列拿焦点。</div>',
              '<div class="m-line"><b>对方</b>可以，本周分公司接完至少三百个群，得往底层走。</div>',
              '<div class="m-part">我：先加日志把慢的原因定位出来，明天……</div>',
            ].join('')
          `), 900)
        }
        if (process.env.JWS_SHOT_VIEW === 'quickbar') {  // 划词条演示态（自检截图用）
          setTimeout(() => win.webContents.executeJavaScript(`
            document.body.classList.add('show-quickbar')
            document.querySelector('#qb-preview').textContent = '✂ tray.setContextMenu 会在 macOS 上接管左右键…'
            document.querySelector('#qb-auth').style.display = ''
          `), 900)
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
          if (process.env.JWS_SHOT_PROBE) {  // 自检探针：打印语音设置请求的真实返回
            try {
              const probe = await win.webContents.executeJavaScript(`(async () => {
                const out = { state: document.querySelector('#s-voice-state')?.textContent || '',
                              options: document.querySelectorAll('#s-voice option').length }
                try { out.resp = await window.jws.api.request('voiceSettingsGet', {}) }
                catch (e) { out.error = String(e && e.message || e) }
                return JSON.stringify(out)
              })()`)
              console.log('JWS_SHOT_PROBE', probe)
            } catch (e) { console.log('JWS_SHOT_PROBE failed', String(e)) }
          }
          if (process.env.JWS_SHOT_SCROLL === 'bottom') {
            // 滚动后必须等重绘落地再截图，否则 capturePage 拿到的还是滚动前的帧
            await win.webContents.executeJavaScript(
              `new Promise(done => {
                 document.querySelectorAll('.s-body').forEach(el => { el.scrollTop = el.scrollHeight })
                 requestAnimationFrame(() => setTimeout(done, 150))
               })`)
          }
          const img = await win.webContents.capturePage()
          fs.writeFileSync(process.env.JWS_SHOT, img.toPNG())
          app.quit()
        }, parseInt(process.env.JWS_SHOT_WAIT || '3500', 10))  // 设置页要等真实网络往返时可调
      }, 1200)
    })
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => app.quit())
