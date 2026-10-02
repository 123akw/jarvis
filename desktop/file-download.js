/* 对话里文件空间的下载链接（/api/files/<id>，服务端按账号鉴权、以附件下发）。
 * 渲染进程是 file:// 页面、也拿不到令牌：相对链接会被当成 file:///api/files/… 外链点不开。
 * 改由主进程带桌面令牌下载、存进「下载」文件夹；其余外链仍交给系统浏览器。
 * 纯逻辑，不依赖 Electron，node --test 直测。 */
'use strict'

const path = require('node:path')

const FILE_LINK = /^\/api\/files\/([A-Za-z0-9_-]{8,64})$/
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024   // 服务端单文件上限 20MB，留点余量

/** 只认同源相对地址 /api/files/<id>；返回 id，不是就返回 '' */
function fileIdFromLink(href) {
  if (typeof href !== 'string') return ''
  const match = href.trim().match(FILE_LINK)
  return match ? match[1] : ''
}

/** Content-Disposition 取文件名：优先 filename*=UTF-8''（中文名），其次 filename="…" */
function filenameFromDisposition(header) {
  if (typeof header !== 'string' || !header) return ''
  const star = header.match(/filename\*\s*=\s*utf-8''([^;]+)/i)
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) } catch { /* 编码坏了退回普通文件名 */ }
  }
  const plain = header.match(/filename\s*=\s*"([^"]*)"/i) || header.match(/filename\s*=\s*([^;]+)/i)
  return plain ? plain[1].trim() : ''
}

/** 落盘文件名：去掉路径分隔符与控制字符、开头的点，过长截断但保留扩展名 */
function safeFileName(name, fallback = 'download') {
  let base = String(name || '').replace(/[/\\:\u0000-\u001f\u007f]/g, '_').replace(/^[.\s]+/, '').trim()
  if (!base) base = fallback
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 16)
    base = base.slice(0, 120 - ext.length) + ext
  }
  return base
}

/** 「下载」里重名时加 (1)、(2)…，不覆盖已有文件 */
function uniqueDownloadPath(dir, name, exists) {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = path.join(dir, name)
  for (let n = 1; exists(candidate) && n < 1000; n += 1) candidate = path.join(dir, `${stem} (${n})${ext}`)
  return candidate
}

module.exports = { FILE_LINK, MAX_DOWNLOAD_BYTES, fileIdFromLink, filenameFromDisposition, safeFileName, uniqueDownloadPath }
