const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fileIdFromLink, filenameFromDisposition, safeFileName, uniqueDownloadPath, MAX_DOWNLOAD_BYTES } = require('./file-download.js')
const { createSessionGateway } = require('./session.js')

test('只认同源相对的文件空间链接 /api/files/<id>', () => {
  assert.equal(fileIdFromLink('/api/files/AbC123_xyz-98'), 'AbC123_xyz-98')
  for (const href of ['/api/files/../../etc', '/api/files/short', 'https://evil.test/api/files/AbC123_xyz-98',
    'file:///api/files/AbC123_xyz-98', '/api/other/AbC123_xyz-98', '/api/files/AbC123_xyz-98?x=1', null]) {
    assert.equal(fileIdFromLink(href), '', String(href))
  }
})

test('文件名：优先 filename* 的中文名，落盘前去掉路径与控制字符，重名加序号', () => {
  assert.equal(filenameFromDisposition(`attachment; filename="download.xlsx"; filename*=UTF-8''${encodeURIComponent('部门汇总.xlsx')}`), '部门汇总.xlsx')
  assert.equal(filenameFromDisposition('attachment; filename="report.pdf"'), 'report.pdf')
  assert.equal(filenameFromDisposition(''), '')
  assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd')
  assert.equal(safeFileName('.hidden'), 'hidden')
  assert.equal(safeFileName('', 'jarvis-AbC12345'), 'jarvis-AbC12345')
  assert.ok(safeFileName('长'.repeat(300) + '.pdf').endsWith('.pdf'))
  const taken = new Set(['/d/汇总.xlsx', '/d/汇总 (1).xlsx'])
  assert.equal(uniqueDownloadPath('/d', '汇总.xlsx', file => taken.has(file)), '/d/汇总 (2).xlsx')
})

function gatewayWith(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jws-dl-'))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value).toString('base64'),
    decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
  }
  return createSessionGateway({ fetchImpl, safeStorage, fs, path, dataDir: dir, server: 'https://example.test' })
}

test('主进程带桌面令牌下载，返回内容与中文文件名；令牌失效时清登录态', async () => {
  const calls = []
  const instance = gatewayWith(async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/api/desktop/login')) return { status: 200, ok: true, json: async () => ({ access_token: 'desk-token' }) }
    if (url.endsWith('/api/files/AbC123_xyz-98')) {
      return { status: 200, ok: true,
        headers: new Map([['content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent('合并后.pdf')}`], ['content-length', '3']]),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
    }
    return { status: 401, ok: false, json: async () => ({}) }
  })
  assert.deepEqual(await instance.downloadFile('AbC123_xyz-98'), { ok: false, status: 401 })  // 没登录不发请求
  assert.equal(calls.length, 0)
  await instance.login('owner', 'pw')
  const result = await instance.downloadFile('AbC123_xyz-98')
  assert.equal(result.ok, true)
  assert.equal(result.filename, '合并后.pdf')
  assert.deepEqual([...result.data], [1, 2, 3])
  assert.equal(calls.at(-1).url, 'https://example.test/api/files/AbC123_xyz-98')
  assert.equal(calls.at(-1).options.headers['X-JWS-Token'], 'desk-token')
  await assert.rejects(() => instance.downloadFile('../etc'), /not allowed/)
  assert.deepEqual(await instance.downloadFile('Expired1234'), { ok: false, status: 401 })
  assert.equal(instance.authToken(), '')
})

test('超过大小上限不落盘', async () => {
  const instance = gatewayWith(async url => (url.endsWith('/api/desktop/login')
    ? { status: 200, ok: true, json: async () => ({ access_token: 't' }) }
    : { status: 200, ok: true, headers: new Map([['content-length', String(MAX_DOWNLOAD_BYTES + 1)]]), arrayBuffer: async () => new ArrayBuffer(0) }))
  await instance.login('owner', 'pw')
  assert.deepEqual(await instance.downloadFile('AbC123_xyz-98'), { ok: false, status: 413 })
})

test('接线：渲染进程把 /api/files 链接交给主进程下载，其余外链仍走系统浏览器', () => {
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  assert.match(renderer, /if \(raw\.startsWith\('\/api\/files\/'\)\) \{ void downloadFileLink\(raw\); return \}/)
  assert.match(renderer, /void window\.jws\.openExternalLink\(a\.href\)/)
  assert.match(preload, /downloadFile: href => ipcRenderer\.invoke\('download-file', href\)/)
  assert.match(main, /ipcMain\.handle\('download-file', async \(event, href\) => \{\n {2}trusted\(event\)\n {2}const fileId = fileIdFromLink\(href\)/)
  assert.match(main, /app\.getPath\('downloads'\)/)
})
