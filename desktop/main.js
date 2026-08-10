const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('fs')
const path = require('path')

const BALL = { w: 92, h: 92 }
const PANEL = { w: 420, h: 640 }
let win = null
let expanded = false

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

/** 展开/收起：窗口右缘钉住不动，向左下生长 */
ipcMain.handle('toggle', () => {
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
})

ipcMain.handle('collapse', () => {
  if (expanded) {
    const b = win.getBounds()
    win.setBounds({ x: b.x + b.width - BALL.w, y: b.y, width: BALL.w, height: BALL.h })
    expanded = false
  }
  return expanded
})

app.whenReady().then(() => {
  createWindow()
  // 自检截图模式：JWS_SHOT=/path/out.png npm start → 展开、截图、退出
  if (process.env.JWS_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const b = win.getBounds()
        win.setBounds({ x: b.x + b.width - PANEL.w, y: b.y, width: PANEL.w, height: PANEL.h })
        expanded = true
        win.webContents.send('force-expand')
        setTimeout(async () => {
          const img = await win.webContents.capturePage()
          fs.writeFileSync(process.env.JWS_SHOT, img.toPNG())
          app.quit()
        }, 3500)
      }, 1200)
    })
  }
})

app.on('window-all-closed', () => app.quit())
