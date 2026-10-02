import { qrMatrix } from '../qr.jsx'

/* 「存成图片」：把账号卡（智能体名、图标、账号、口令、登录页二维码）画成 PNG，方便存进相册。
 * 纯 canvas 2D，不引库；不支持 canvas 的环境返回空串，由调用方提示截图保存。 */

const W = 750
const H = 1180
const FONT = '-apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif'
const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace'

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 长串按宽度缩字号：口令、账号一行放下 */
function fitText(ctx, text, maxWidth, size, family, weight = 600) {
  let s = size
  ctx.font = `${weight} ${s}px ${family}`
  while (s > 22 && ctx.measureText(text).width > maxWidth) {
    s -= 2
    ctx.font = `${weight} ${s}px ${family}`
  }
  return s
}

export function drawAccountCard({ name, icon, accent = '#0A84FF', username, password, url }) {
  let canvas
  let ctx
  try {
    canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    ctx = canvas.getContext('2d')
  } catch { return '' }
  if (!ctx) return ''

  // 底色 + 顶部主题色光晕
  ctx.fillStyle = '#0B0B0F'
  ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(W / 2, -60, 20, W / 2, -60, 620)
  glow.addColorStop(0, `${accent}aa`)
  glow.addColorStop(1, `${accent}00`)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, W, H)

  // 图标
  const iconSize = 132
  const ix = (W - iconSize) / 2
  const grad = ctx.createLinearGradient(ix, 70, ix + iconSize, 70 + iconSize)
  grad.addColorStop(0, accent)
  grad.addColorStop(1, '#00000055')
  roundRect(ctx, ix, 70, iconSize, iconSize, 36)
  ctx.fillStyle = accent
  ctx.fill()
  ctx.fillStyle = grad
  ctx.fill()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `72px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",${FONT}`
  ctx.fillText(icon || '✨', W / 2, 70 + iconSize / 2 + 4)

  // 名字
  ctx.fillStyle = 'rgba(235,235,245,.6)'
  ctx.font = `600 24px ${FONT}`
  ctx.fillText('我的智能体', W / 2, 252)
  ctx.fillStyle = '#F5F5F7'
  fitText(ctx, name || '我的智能体', W - 120, 52, FONT, 700)
  ctx.fillText(name || '我的智能体', W / 2, 306)

  // 账号口令卡
  const cx = 56
  const cw = W - cx * 2
  roundRect(ctx, cx, 360, cw, 300, 32)
  ctx.fillStyle = 'rgba(255,179,64,.10)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,179,64,.55)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(235,235,245,.55)'
  ctx.font = `500 24px ${FONT}`
  ctx.fillText('账号', cx + 36, 420)
  ctx.fillText('口令', cx + 36, 530)
  ctx.fillStyle = '#F5F5F7'
  fitText(ctx, username || '', cw - 72, 44, MONO)
  ctx.fillText(username || '', cx + 36, 466)
  fitText(ctx, password || '', cw - 72, 44, MONO)
  ctx.fillText(password || '', cx + 36, 576)
  ctx.fillStyle = '#FFB340'
  ctx.font = `700 22px ${FONT}`
  ctx.fillText('只显示这一次，请妥善保存', cx + 36, 628)

  // 登录页二维码
  const m = qrMatrix(url || '')
  const qs = 300
  const qx = (W - qs) / 2
  const qy = 712
  roundRect(ctx, qx - 18, qy - 18, qs + 36, qs + 36, 28)
  ctx.fillStyle = '#fff'
  ctx.fill()
  const cell = qs / m.length
  ctx.fillStyle = '#000'
  m.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) ctx.fillRect(qx + c * cell, qy + r * cell, Math.ceil(cell), Math.ceil(cell))
  }))
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(235,235,245,.6)'
  ctx.font = `500 22px ${FONT}`
  ctx.fillText('扫码打开登录页 · 由贾维斯驱动', W / 2, qy + qs + 64)

  try { return canvas.toDataURL('image/png') } catch { return '' }
}
