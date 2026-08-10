/* 悬浮窗渲染进程：登录 → 拉历史 → 快捷对话（独立线程 desktop，不打扰网页端记录） */
const SERVER = localStorage.getItem('jws_server') || 'https://jws.gkgeek-set.cn'
const USER = 'admin'
const PASS = 'admin'
const THREAD = 'desktop'

const $ = s => document.querySelector(s)
const log = $('#plog'), box = $('#box'), send = $('#send'), state = $('#pstate')

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function md(t) {
  let s = t
  if (((s.match(/```/g) || []).length) % 2 === 1) s += '\n```'
  s = esc(s)
  s = s.replace(/```\w*\n?([\s\S]*?)```/g, (_, c) => `<pre>${c.trimEnd()}</pre>`)
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/`([^`]+?)`/g, '<code>$1</code>')
  s = s.replace(/(^|\n)((?:[-•] .*(?:\n|$))+)/g, (_, p, b) =>
    `${p}<ul>${b.trim().split('\n').map(l => `<li>${l.replace(/^[-•] /, '')}</li>`).join('')}</ul>`)
  s = s.replace(/\n/g, '<br>')
  s = s.replace(/<br>(<\/?(?:ul|li|pre))/g, '$1').replace(/(<\/(?:ul|pre)>)<br>/g, '$1')
  return s
}

function addUser(text) {
  const el = document.createElement('div')
  el.className = 'm-user'; el.textContent = text
  log.append(el); log.scrollTop = log.scrollHeight
  return el
}
function addAI(raw = '', streaming = false) {
  const el = document.createElement('div')
  el.className = 'm-ai'
  el.innerHTML = md(raw) + (streaming ? '<span class="caret"></span>' : '')
  log.append(el); log.scrollTop = log.scrollHeight
  return el
}
function sys(text) {
  const el = document.createElement('div')
  el.className = 'sys'; el.textContent = '⚠ ' + text
  log.append(el); log.scrollTop = log.scrollHeight
}

async function api(path, opts = {}) {
  return fetch(SERVER + path, { credentials: 'include', ...opts })
}

async function ensureLogin() {
  let r = await api('/api/session')
  if ((await r.json()).authed) return true
  r = await api('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  return r.ok
}

async function loadHistory() {
  const r = await api(`/api/history?thread_id=${THREAD}`)
  const h = await r.json()
  log.innerHTML = ''
  if (!h.length) {
    log.innerHTML = '<div class="empty">这里是桌面快捷通道。有什么吩咐？</div>'
    return
  }
  for (const m of h.slice(-24)) {
    if (m.role === 'user') addUser(m.content)
    else addAI(m.content)
  }
}

let busy = false
async function ask() {
  const text = box.value.trim()
  if (!text || busy) return
  box.value = ''; box.style.height = 'auto'
  busy = true; send.disabled = true
  document.body.classList.add('busy')
  state.textContent = '思考中…'
  const empty = log.querySelector('.empty'); if (empty) empty.remove()
  addUser(text)
  const el = addAI('', true)
  let raw = ''
  let toolLine = null
  try {
    const r = await api('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, thread_id: THREAD }),
    })
    if (r.status === 401) { sys('登录态失效，正在重连…'); await ensureLogin(); throw new Error('请重发') }
    const reader = r.body.getReader(), dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n'); buf = parts.pop()
      for (const p of parts) {
        if (!p.startsWith('data: ')) continue
        const ev = JSON.parse(p.slice(6))
        if (ev.type === 'token') {
          raw += ev.text
          el.innerHTML = md(raw) + '<span class="caret"></span>'
          log.scrollTop = log.scrollHeight
        } else if (ev.type === 'tool_start') {
          if (!toolLine) {
            toolLine = document.createElement('div')
            toolLine.className = 'tool'
            el.before(toolLine)
          }
          toolLine.textContent = `⚙ ${ev.name} …`
        } else if (ev.type === 'tool_result') {
          if (toolLine) toolLine.textContent = `⚙ ${ev.name} ✓`
        } else if (ev.type === 'error') {
          sys(ev.message)
        }
      }
    }
    el.innerHTML = md(raw) || '<span style="color:var(--dim)">（无回复）</span>'
  } catch (e) {
    el.innerHTML = md(raw)
    sys(e.message)
  } finally {
    busy = false; send.disabled = false
    document.body.classList.remove('busy')
    state.textContent = '在线'
    box.focus()
  }
}

/* 交互接线 */
$('#eye').addEventListener('click', async () => {
  await window.jws.toggle()
  document.body.classList.add('expanded')
  box.focus()
})
$('#minbtn').addEventListener('click', async () => {
  await window.jws.collapse()
  document.body.classList.remove('expanded')
})
$('#clearbtn').addEventListener('click', async () => {
  await api(`/api/thread?thread_id=${THREAD}`, { method: 'DELETE' })
  log.innerHTML = '<div class="empty">已清空。有什么吩咐？</div>'
})
send.addEventListener('click', ask)
box.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() }
})
box.addEventListener('input', () => {
  box.style.height = 'auto'
  box.style.height = Math.min(box.scrollHeight, 96) + 'px'
})
window.jws.onForceExpand(() => document.body.classList.add('expanded'))
window.jws.onSetExpanded(v => {  // 全局快捷键唤醒/收起时同步界面
  document.body.classList.toggle('expanded', v)
  if (v) box.focus()
})

/* ---------- 设置面板：按键录制器 ---------- */
const hkField = $('#hk-rec')
let pendingHotkey = ''   // Electron accelerator 字符串
let recording = false

/** e.code → Electron 按键名 */
function codeToKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  const map = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
    Comma: ',', Period: '.', Slash: '/',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'Delete',
  }
  return map[code] || null
}

/** accelerator → mac 符号显示 */
function displayAcc(acc) {
  if (!acc) return '未启用（点击录制）'
  return acc.split('+').map(p => ({
    CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Ctrl: '⌃',
    Alt: '⌥', Option: '⌥', Shift: '⇧', Super: '❖', Space: 'Space',
  }[p] || p)).join(' ')
}

function renderHkField() {
  hkField.classList.remove('rec')
  hkField.classList.toggle('off', !pendingHotkey)
  hkField.textContent = pendingHotkey ? displayAcc(pendingHotkey) : '未启用（点击录制）'
}

function onRecordKey(e) {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') { stopRecording(); renderHkField(); return }
  const mods = []
  if (e.metaKey) mods.push('Command')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const key = codeToKey(e.code)
  if (!key) {  // 只按了修饰键：实时预览，继续等主键
    hkField.textContent = mods.map(m => displayAcc(m)).join(' ') + ' …'
    return
  }
  if (!mods.some(m => m !== 'Shift') && !/^F\d+$/.test(key)) {
    hkField.textContent = '需要搭配 ⌘ / ⌃ / ⌥ 修饰键'
    return
  }
  pendingHotkey = [...mods, key].join('+')
  stopRecording()
  renderHkField()
  $('#s-hotkey-state').textContent = '已录制，点「保存并应用」生效'
  $('#s-hotkey-state').className = 's-hint'
}

function startRecording() {
  recording = true
  hkField.classList.add('rec')
  hkField.textContent = '请按下组合键…（Esc 取消）'
  window.addEventListener('keydown', onRecordKey, true)
}
function stopRecording() {
  recording = false
  window.removeEventListener('keydown', onRecordKey, true)
}

hkField.addEventListener('click', () => { if (!recording) startRecording() })
$('#hk-clear').addEventListener('click', () => {
  stopRecording()
  pendingHotkey = ''
  renderHkField()
})

async function openSettings() {
  const s = await window.jws.getSettings()
  $('#s-autolaunch').checked = !!s.openAtLogin
  pendingHotkey = s.hotkey || ''
  renderHkField()
  $('#s-hotkey-state').textContent = s.hotkey
    ? (s.hotkeyOk ? `当前生效：${displayAcc(s.hotkey)}` : `注册失败（可能被占用）：${displayAcc(s.hotkey)}`)
    : '未启用'
  $('#s-hotkey-state').className = 's-hint ' + (s.hotkey ? (s.hotkeyOk ? 'ok' : 'bad') : '')
  $('#s-server').value = SERVER
  $('#s-msg').textContent = ''
  document.body.classList.add('show-settings')
}

$('#setbtn').addEventListener('click', openSettings)
$('#backbtn').addEventListener('click', () => {
  stopRecording()
  document.body.classList.remove('show-settings')
})

$('#s-save').addEventListener('click', async () => {
  const r = await window.jws.setSettings({
    hotkey: pendingHotkey,
    openAtLogin: $('#s-autolaunch').checked,
  })
  const server = $('#s-server').value.trim().replace(/\/+$/, '')
  const serverChanged = server && server !== SERVER
  if (serverChanged) localStorage.setItem('jws_server', server)
  const msg = $('#s-msg')
  const st = $('#s-hotkey-state')
  if (pendingHotkey && !r.hotkeyOk) {
    msg.textContent = '⚠ 快捷键注册失败（可能与其他应用冲突），其余设置已保存'
    msg.className = 's-hint bad'
    st.textContent = `注册失败：${displayAcc(pendingHotkey)}`
    st.className = 's-hint bad'
  } else {
    msg.textContent = serverChanged ? '已保存，正在按新服务器地址重连…' : '已保存并生效'
    msg.className = 's-hint ok'
    st.textContent = pendingHotkey ? `当前生效：${displayAcc(pendingHotkey)}` : '未启用'
    st.className = 's-hint ' + (pendingHotkey ? 'ok' : '')
  }
  if (serverChanged) setTimeout(() => location.reload(), 900)
})

/* 启动：登录 + 取历史 */
;(async () => {
  try {
    const ok = await ensureLogin()
    state.textContent = ok ? '在线' : '登录失败'
    if (ok) await loadHistory()
  } catch (e) {
    state.textContent = '离线'
    sys('连不上服务器：' + e.message)
  }
})()
