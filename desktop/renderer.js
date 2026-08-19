/* 悬浮窗渲染进程：登录 → 拉历史 → 快捷对话（独立线程 desktop，不打扰网页端记录） */
const THREAD = 'desktop'

const $ = s => document.querySelector(s)
const log = $('#plog'), box = $('#box'), send = $('#send'), state = $('#pstate')

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/* 完整 Markdown 渲染（md-render.js 核心 + 页面注入的 marked/DOMPurify/hljs）。
 * 依赖缺失（如 desktop/ 没跑 npm install）时降级为纯文本转义，绝不让整个界面卡死。 */
let renderMd = null
try {
  renderMd = window.JWSMarkdown.createMarkdownRenderer({
    marked: window.marked, DOMPurify: window.DOMPurify, hljs: window.hljs,
  })
} catch (error) {
  console.warn('markdown renderer unavailable, falling back to plain text:', error)
}
const md = (t, streaming) => {
  if (renderMd) {
    try { return renderMd(t, { streaming }) } catch { /* 单条渲染失败也走纯文本 */ }
  }
  return esc(String(t ?? '')).replace(/\n/g, '<br>') + (streaming ? '<span class="caret"></span>' : '')
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
  el.innerHTML = md(raw, streaming)
  log.append(el); log.scrollTop = log.scrollHeight
  return el
}
function sys(text) {
  const el = document.createElement('div')
  el.className = 'sys'; el.textContent = '⚠ ' + text
  log.append(el); log.scrollTop = log.scrollHeight
}

/* The renderer only names approved operations. Main owns token, headers and server URL. */
async function api(operation, body = {}) {
  const result = await authenticatedApi.request(operation, body)
  return { status: result.status, ok: result.ok, json: async () => result.data }
}
const loginController = window.JWSLoginController.createLoginController({
  api: window.jws.api,
  getSettings: window.jws.getSettings,
  setSettings: window.jws.setSettings,
  showLogin: window.jws.showLogin,
  setLoginVisible: visible => {
    document.body.classList.toggle('needs-login', visible)
    if (visible) state.textContent = '请登录'
  },
  clearPassword: () => { $('#desktop-password').value = '' },
  onAuthenticated: async () => {
    state.textContent = '在线'
    await loadHistory()
    void syncCoding().catch(() => {})
  },
})
function requireLogin() { return loginController.requireLogin() }
const authenticatedApi = window.JWSLoginController.createAuthenticatedApi(window.jws.api, { onUnauthorized: requireLogin })
const isAuthenticationRequired = window.JWSLoginController.isAuthenticationRequired
async function submitDesktopLogin(event) {
  event.preventDefault()
  const username = $('#desktop-username').value.trim()
  const password = $('#desktop-password').value
  $('#desktop-login-error').textContent = ''
  try {
    const result = await loginController.login(username, password)
    if (!result.ok) $('#desktop-login-error').textContent = '身份未确认，请重试'
  } catch { $('#desktop-login-error').textContent = '无法安全保存登录态，请重试' }
}
$('#desktop-login-form').addEventListener('submit', event => { void submitDesktopLogin(event) })
$('#desktop-server-save').addEventListener('click', async () => {
  const status = $('#desktop-server-state')
  status.textContent = ''
  try {
    await loginController.saveServer($('#desktop-server').value)
    status.textContent = '服务器地址已保存，请登录'
    status.className = 'desktop-login-state ok'
  } catch (error) {
    status.textContent = error.message || '服务器地址不被允许'
    status.className = 'desktop-login-state bad'
  }
})

/* 工具 → 中文友好名与图标（与 web-src/src/toolInfo.js 同步的副本） */
const TOOL_INFO = {
  now: ['🕐', '当前时间'], calc: ['🧮', '计算'], weather: ['⛅', '城市天气'],
  weather_here: ['📍', '本地天气'], my_location: ['📍', '我的位置'], coding_status: ['⌨️', '编程进度'],
  memo_add: ['📝', '记备忘'], memo_list: ['📝', '查备忘'], memo_del: ['📝', '删备忘'],
  profile_remember: ['◉', '记住画像'], profile_list: ['◉', '查画像'], profile_forget: ['◉', '忘记画像'],
  schedule_add: ['📅', '加日程'], schedule_list: ['📅', '查日程'], schedule_del: ['📅', '删日程'],
  todo_add: ['☑️', '加待办'], todo_list: ['☑️', '查待办'], todo_done: ['☑️', '完成待办'],
  sys_query: ['🖥', '系统查询'], web_search: ['🔎', '联网搜索'], web_extract: ['📄', '读取网页'],
  movie_ratings: ['🎬', '电影评分'], esports_scores: ['🏆', '电竞比分'], ticket_search: ['🎫', '票务查询'],
}
const toolLabel = name => TOOL_INFO[name] ? `${TOOL_INFO[name][0]} ${TOOL_INFO[name][1]}` : `⚙ ${name}`

const EMPTY_HTML = `<div class="empty">这里是桌面快捷通道。有什么吩咐？</div>
<div class="qchips">
  <button data-q="给我今日晨报">☀ 今日晨报</button>
  <button data-q="我在做什么任务？">⌨ 编程进度</button>
  <button data-q="今天有什么安排和待办？">📅 今日安排</button>
</div>`

async function loadHistory() {
  try {
    const h = await (await api('history', { thread_id: THREAD })).json()
    log.innerHTML = ''
    if (!h.length) {
      log.innerHTML = EMPTY_HTML
      return
    }
    for (const m of h.slice(-24)) {
      if (m.role === 'user') addUser(m.content)
      else addAI(m.content)
    }
  } catch (error) {
    if (!isAuthenticationRequired(error)) sys('无法读取历史记录')
  }
}

let busy = false
let currentStream = null
async function ask() {
  const text = box.value.trim()
  if (!text || busy) return
  box.value = ''; box.style.height = 'auto'
  clipbar.style.display = 'none'
  busy = true; send.textContent = '■'; send.title = '停止生成'
  document.body.classList.add('busy')
  state.textContent = '思考中…'
  const empty = log.querySelector('.empty'); if (empty) empty.remove()
  addUser(text)
  const el = addAI('', true)
  let raw = ''
  let toolLine = null
  try {
    currentStream = window.JWSChatStream.startChatStream(window.jws.api, { message: text, thread_id: THREAD }, { onUnauthorized: requireLogin, onEvent: ev => {
      if (ev.type === 'token') {
        raw += ev.text
        el.innerHTML = md(raw, true)
        log.scrollTop = log.scrollHeight
      } else if (ev.type === 'tool_start') {
        if (!toolLine) {
          toolLine = document.createElement('div')
          toolLine.className = 'tool'
          el.before(toolLine)
        }
        toolLine.textContent = `${toolLabel(ev.name)} …`
      } else if (ev.type === 'tool_result') {
        if (toolLine) {
          const mark = ev.ok === false ? '✗' : '✓'
          toolLine.textContent = `${toolLabel(ev.name)} ${mark}${ev.ms != null ? ` · ${ev.ms}ms` : ''}`
        }
      } else if (ev.type === 'error') sys(ev.message)
    } })
    const r = await currentStream.done
    if (!r.ok && !r.cancelled) throw new Error('链路中断')
    el.innerHTML = md(raw) || '<span style="color:var(--dim)">（无回复）</span>'
  } catch (e) {
    el.innerHTML = md(raw)
    sys(e.message)
  } finally {
    currentStream = null
    busy = false; send.textContent = '↑'; send.title = '发送'
    document.body.classList.remove('busy')
    if (!document.body.classList.contains('needs-login')) state.textContent = '在线'
    box.focus()
  }
}

/* 交互接线：整球 JS 拖动，松手未移动视为点击展开 */
const ballEl = $('#ball')
let dragState = null
ballEl.addEventListener('mousedown', e => {
  if (e.button !== 0) return   // 右键留给「一键语音通话」
  dragState = { sx: e.screenX, sy: e.screenY, moved: false }
  window.jws.dragStart(e.screenX, e.screenY)
  e.preventDefault()
})
ballEl.addEventListener('contextmenu', async e => {  // 悬浮球右键：直接展开并接通语音（对齐豆包悬浮头像一键通话）
  e.preventDefault()
  await window.jws.toggle()
  document.body.classList.add('expanded')
  void startVoiceCall()
})
window.addEventListener('mousemove', e => {
  if (!dragState) return
  if (Math.abs(e.screenX - dragState.sx) + Math.abs(e.screenY - dragState.sy) > 3) {
    dragState.moved = true
  }
  if (dragState.moved) window.jws.dragMove(e.screenX, e.screenY)
})
window.addEventListener('mouseup', async () => {
  if (!dragState) return
  const moved = dragState.moved
  dragState = null
  window.jws.dragEnd()
  if (!moved) {
    await window.jws.toggle()
    document.body.classList.add('expanded')
    box.focus()
    maybeOfferClip()
  }
})
$('#minbtn').addEventListener('click', async () => {
  await window.jws.collapse()
  document.body.classList.remove('expanded')
})
let clearArmTimer = null   // 清空是删整条 desktop 线程，误触代价高：第一击进确认态
$('#clearbtn').addEventListener('click', async () => {
  const btn = $('#clearbtn')
  if (!clearArmTimer) {
    btn.textContent = '↺?'
    btn.title = '再点一次确认清空'
    btn.style.color = 'var(--alert)'
    clearArmTimer = setTimeout(() => {
      clearArmTimer = null
      btn.textContent = '↺'; btn.title = '清空快捷对话'; btn.style.color = ''
    }, 3000)
    return
  }
  clearTimeout(clearArmTimer); clearArmTimer = null
  btn.textContent = '↺'; btn.title = '清空快捷对话'; btn.style.color = ''
  try {
    await api('deleteThread', { thread_id: THREAD })
    log.innerHTML = '<div class="empty">已清空。有什么吩咐？</div>'
  } catch (error) {
    if (!isAuthenticationRequired(error)) sys('无法清空记录')
  }
})
log.addEventListener('click', e => {  // 空态快捷芯片 / 来源链接 / 代码块复制
  const a = e.target.closest && e.target.closest('a[href]')
  if (a) { e.preventDefault(); void window.jws.openExternalLink(a.href); return }
  const copyBtn = e.target.closest && e.target.closest('.codecopy')
  if (copyBtn) {
    const code = copyBtn.closest('.codeblock')?.querySelector('code')
    if (code) {
      void navigator.clipboard?.writeText(code.textContent)
      copyBtn.textContent = '已复制'
      setTimeout(() => { copyBtn.textContent = '复制' }, 1200)
    }
    return
  }
  const q = e.target && e.target.dataset && e.target.dataset.q
  if (q) { box.value = q; ask() }
})

/* 剪贴板一键问：展开时若有新剪贴内容，给一条金色快捷条 */
const clipbar = $('#clipbar')
let lastClip = ''
async function maybeOfferClip() {
  try {
    const t = (await window.jws.clipboardText()).trim()
    if (t && t !== lastClip && t.length <= 4000) {
      clipbar.dataset.text = t
      clipbar.textContent = `📋 问剪贴板内容（${t.length} 字）：${t.slice(0, 40).replace(/\s+/g, ' ')}…`
      clipbar.style.display = ''
    }
  } catch { /* 读不到剪贴板就不给条 */ }
}
clipbar.addEventListener('click', () => {
  const t = clipbar.dataset.text || ''
  lastClip = t
  clipbar.style.display = 'none'
  box.value = `帮我看看这个：\n\`\`\`\n${t}\n\`\`\``
  ask()
})

send.addEventListener('click', () => { if (busy && currentStream) void currentStream.cancel(); else void ask() })
box.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() }
})
box.addEventListener('input', () => {
  box.style.height = 'auto'
  box.style.height = Math.min(box.scrollHeight, 96) + 'px'
})
window.jws.onForceExpand(() => document.body.classList.add('expanded'))
if (window.jws.onTrayCommand) {  // 托盘菜单：语音通话 / 设置
  window.jws.onTrayCommand(cmd => {
    if (cmd === 'voice') void startVoiceCall()
    if (cmd === 'settings') void openSettings()
  })
}

/* ---------- 语音通话（📞）：核心逻辑在 voice-call.js，这里只做 DOM 接线 ---------- */
const voiceEl = $('#voice')
const VOICE_PHASE_LABEL = {
  connecting: '接通中…',
  listening: '请讲，我在听',
  thinking: '思考中…',
  speaking: '回答中…（开口即可打断）',
  closed: '通话已断开',
}
let activeCall = null

function renderVoicePhase(p) {
  voiceEl.className = p
  $('#v-phase').textContent = VOICE_PHASE_LABEL[p] || p
  $('#v-interrupt').style.display = p === 'speaking' ? '' : 'none'
  renderVoiceHint()
}
function renderVoiceHint() {
  const s = activeCall && activeCall.state()
  $('#v-hint').textContent = (s && s.micState === 'granted' && s.phase === 'listening')
    ? (s.inputMode === 'stream' ? '实时识别中，直接说话即可' : '说话停顿后自动发送')
    : ''
}
function renderVoiceDegraded() {
  const s = activeCall && activeCall.state()
  const degraded = s && (s.micState === 'denied' || s.micState === 'unsupported')
  $('#v-typebar').style.display = degraded ? '' : 'none'
  if (degraded) $('#v-input').focus()
  renderVoiceHint()
}

async function startVoiceCall() {
  if (activeCall) { document.body.classList.add('show-voice'); return }
  document.body.classList.add('show-voice', 'on-call')
  $('#v-final').textContent = ''
  $('#v-interim').textContent = ''
  $('#v-reply').textContent = ''
  $('#v-tools').innerHTML = ''
  $('#v-notice').style.display = 'none'
  $('#v-typebar').style.display = 'none'
  renderVoicePhase('connecting')
  try { await window.jws.voiceMicAccess() } catch { /* 授权结果由 getUserMedia 再判 */ }
  const s = await window.jws.getSettings()
  const url = String(s.server || '').replace(/^http/, 'ws') + '/api/voice/call'
  activeCall = window.JWSVoiceCall.createVoiceCall({
    url,
    createWebSocket: u => new WebSocket(u),
    player: window.JWSVoiceAudio.createPcmPlayer(),
    pcmSupported: window.JWSVoiceAudio.pcmStreamSupported(),
    startMicStream: window.JWSVoiceAudio.startMicStream,
    isMicError: window.JWSVoiceAudio.isMicError,
    speechCtor: () => window.SpeechRecognition || window.webkitSpeechRecognition || null,
    on: {
      phase: renderVoicePhase,
      micState: renderVoiceDegraded,
      inputMode: renderVoiceHint,
      interim: t => { $('#v-interim').textContent = t; if (t) $('#v-final').textContent = '' },
      heard: t => { $('#v-final').textContent = t ? `「${t}」` : ''; $('#v-interim').textContent = '' },
      reply: r => { const el = $('#v-reply'); el.textContent = r; el.scrollTop = el.scrollHeight },
      tools: ts => {
        $('#v-tools').innerHTML = ts.map(t => `<span>${esc(toolLabel(t.name))}${t.done ? ' ✓' : '…'}</span>`).join('')
      },
      notice: n => {
        const el = $('#v-notice')
        el.textContent = n ? '⚠ ' + n : ''
        el.style.display = n ? '' : 'none'
      },
      expired: () => { endVoiceCall(); requireLogin() },
    },
  })
  activeCall.start()
}

function endVoiceCall() {
  if (activeCall) { activeCall.hangup(); activeCall = null }
  document.body.classList.remove('show-voice', 'on-call')
}

function sendVoiceTyped() {
  const text = $('#v-input').value
  if (!text.trim() || !activeCall) return
  $('#v-input').value = ''
  activeCall.sendTyped(text)
}

$('#callbtn').addEventListener('click', () => { void startVoiceCall() })
$('#v-hangup').addEventListener('click', endVoiceCall)
$('#v-interrupt').addEventListener('click', () => { if (activeCall) activeCall.bargeIn() })
$('#v-min').addEventListener('click', async () => {  // 收起为悬浮球，通话继续（球上有红点）
  await window.jws.collapse()
  document.body.classList.remove('expanded')
})
$('#v-send').addEventListener('click', sendVoiceTyped)
$('#v-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendVoiceTyped() })

/* ---------- 悬浮球外观 ---------- */
function applyBallLook(size, style) {
  document.documentElement.style.setProperty('--ball', `${size}px`)
  document.body.classList.remove('ball-moss', 'ball-mini', 'ball-img')
  const img = localStorage.getItem('jws_ball_img')
  if (style === 'img' && !img) style = 'moss'  // 没选过图就回落默认
  document.body.classList.add(`ball-${style}`)
  if (style === 'img') {
    document.documentElement.style.setProperty('--ball-img', `url(${img})`)
  }
}
;(async () => {
  const s = await window.jws.getSettings()
  applyBallLook(s.ballSize || 64, s.ballStyle || 'moss')
})()
window.jws.onSetExpanded(v => {  // 全局快捷键唤醒/收起时同步界面
  document.body.classList.toggle('expanded', v)
  if (v) { box.focus(); maybeOfferClip() }
})

/* ---------- 编程进度采集：同步到服务器，任务台展示 ---------- */
async function syncCoding() {
  try {
    const coding = await window.jws.codingStatus()
    await api('coding', { coding })
    return coding
  } catch (error) {
    if (isAuthenticationRequired(error)) throw error
    return []
  }
}
setInterval(() => { void syncCoding().catch(() => {}) }, 5 * 60 * 1000)

function rowsHtml(items, render) {
  if (!items || !items.length) return '<div class="b-empty">暂无</div>'
  return items.map(render).join('')
}

async function openBoard() {
  document.body.classList.add('show-board')
  $('#b-coding').innerHTML = '<div class="b-empty">读取中…</div>'
  try {
    const coding = await syncCoding()
    $('#b-coding').innerHTML = rowsHtml(coding, c => `
      <div class="row"><span class="tag${c.active ? ' on' : ''}">${c.active ? '● 进行中' : c.last_active}</span>
      <span class="txt"><b>${esc(c.project)}</b>${c.task ? ' · ' + esc(c.task) : ''}
        ${c.step ? `<div class="sub">⚙ ${esc(c.step)}</div>` : ''}
        ${c.files && c.files.length ? `<div class="sub">✎ ${esc(c.files.join('  '))}</div>` : ''}
        ${c.branch ? `<div class="sub">⎇ ${esc(c.branch)}${c.dirty ? ` · 未提交 ${c.dirty} 处` : ''}${c.commits_today ? ` · 今日提交 ${c.commits_today} 个` : ''}</div>` : ''}
      </span></div>`)
    const d = await (await api('dashboard')).json()
    const today = d.time.slice(0, 10)
    const sch = (d.schedule || []).filter(x => x.when.slice(0, 10) === today)
    $('#b-sched').innerHTML = rowsHtml(sch, x => `
      <div class="row"><span class="tag">${esc(x.when.slice(11))}</span>
      <span class="txt">${esc(x.title)}</span></div>`)
    $('#b-todos').innerHTML = rowsHtml(d.todos, x => `
      <div class="row"><input type="checkbox" class="b-tick" data-id="${x.id}" title="点掉即完成">
      <span class="txt">${esc(x.content)}</span></div>`)
  } catch (error) {
    if (!isAuthenticationRequired(error)) {
      $('#b-sched').innerHTML = $('#b-todos').innerHTML = '<div class="b-empty">连不上服务器</div>'
    }
  }
}
$('#b-todos').addEventListener('change', async e => {  // 待办真复选框：点掉即完成
  const box = e.target.closest && e.target.closest('.b-tick')
  if (!box) return
  box.disabled = true
  try {
    await api('todoPatch', { id: parseInt(box.dataset.id, 10), done: true })
  } catch (error) {
    if (isAuthenticationRequired(error)) return
  }
  void openBoard()
})
$('#boardbtn').addEventListener('click', openBoard)
$('#boardback').addEventListener('click', () => document.body.classList.remove('show-board'))
$('#boardrefresh').addEventListener('click', openBoard)

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

/* 图片选择：压成 256px 方图存 localStorage */
$('#s-imgpick').addEventListener('click', () => $('#s-imgfile').click())
$('#s-imgfile').addEventListener('change', () => {
  const f = $('#s-imgfile').files[0]
  if (!f) return
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const ctx = c.getContext('2d')
    const side = Math.min(img.width, img.height)
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256)
    const url = c.toDataURL('image/jpeg', 0.88)
    localStorage.setItem('jws_ball_img', url)
    const prev = $('#s-imgprev')
    prev.src = url; prev.style.display = ''
  }
  img.src = URL.createObjectURL(f)
})

$('#s-ballsize').addEventListener('input', () => {
  $('#s-ballsize-v').textContent = $('#s-ballsize').value + 'px'
})
$('#s-ballstyle').addEventListener('change', () => {
  $('#s-imgrow').style.display = $('#s-ballstyle').value === 'img' ? '' : 'none'
})

/* ---------- 接入个人微信（复用服务器 /api/wechat/*，桌面走令牌鉴权） ---------- */
let wxController = null
function renderWx(s = {}) {
  const area = $('#wx-area'), st = $('#wx-state')
  if (!area || !st || !window.JarvisWeChatUI) return
  const view = window.JarvisWeChatUI.viewFor(s)
  st.textContent = view.status
  st.className = view.statusClass
  if (view.kind === 'connected') {
    area.innerHTML = '<button type="button" id="wx-disc">断开连接</button>'
    $('#wx-disc').addEventListener('click', () => wxController.disconnect())
  } else if (view.kind === 'waiting') {
    area.innerHTML = ''
    const img = document.createElement('img')
    img.id = 'wx-qr'
    img.src = view.qrUri
    img.alt = '微信登录二维码'
    area.append(img)
    if (view.canDisconnect) {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.id = 'wx-disc'
      cancel.textContent = '取消本次扫码'
      cancel.addEventListener('click', () => wxController.disconnect())
      area.append(cancel)
    }
  } else if (view.kind === 'loading') {
    area.innerHTML = ''
  } else {
    area.innerHTML = '<button type="button" id="wx-connect">生成二维码接入</button>'
    $('#wx-connect').addEventListener('click', () => wxController.connect())
  }
}
wxController = window.JarvisWeChatUI.createController({
  request: async (path, options = {}) => {
    const operation = ({
      '/api/wechat/status': 'wechatStatus', '/api/wechat/connect': 'wechatConnect', '/api/wechat/disconnect': 'wechatDisconnect',
    })[path]
    if (!operation) throw new Error('unsupported WeChat operation')
    return api(operation, options.body)
  },
  render: renderWx,
  reauthenticate: async () => { requireLogin(); return false },
})

/* ---------- 每用户模型 API / Owner 联网数据源 ---------- */
let providerSettings = null
function providerItem() { return providerSettings?.catalog?.find(item => item.id === $('#api-provider').value) }
function sameProviderScope() {
  try {
    const current = new URL(providerSettings.llm.base_url), next = new URL($('#api-base').value)
    return providerSettings.llm.provider === $('#api-provider').value && current.origin === next.origin
  } catch { return false }
}
function clearProviderSecrets() { $('#api-key').value = ''; $('#api-password').value = '' }
function clearIntegrationSecrets() { $('#integration-key').value = ''; $('#integration-password').value = '' }
function renderProvider() {
  const item = providerItem()
  $('#api-base').readOnly = !item?.editable
  $('#api-key-link').hidden = !item?.key_url
  $('#api-keep-row').hidden = !(providerSettings.llm.key_configured && sameProviderScope())
  if ($('#api-keep-row').hidden) $('#api-keep').checked = false
}
function renderIntegration() {
  const name = $('#integration-name').value, current = providerSettings.integrations[name]
  $('#integration-enabled').checked = Boolean(current?.enabled)
  const searchUrl = name === 'searxng'
  $('#integration-base-row').hidden = !searchUrl; $('#integration-key-row').hidden = searchUrl
  $('#integration-keep-row').hidden = searchUrl || !current?.key_configured
  $('#integration-base').value = current?.base_url || 'http://127.0.0.1:18888'
  $('#integration-key').value = ''; $('#integration-keep').checked = false
}
async function loadProviderSettings() {
  const response = await api('providerSettings'), data = await response.json()
  if (!response.ok) throw new Error(data.error || '无法读取 API 设置')
  providerSettings = data
  const select = $('#api-provider')
  select.innerHTML = data.catalog.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')
  select.value = data.llm.provider; $('#api-base').value = data.llm.base_url; $('#api-model').value = data.llm.model
  clearProviderSecrets(); $('#api-keep').checked = false; renderProvider()
  const owner = Object.keys(data.integrations || {}).length > 0
  $('#integration-setting').hidden = !owner
  if (owner) { renderIntegration(); clearIntegrationSecrets() }
}
function llmSettingsBody() {
  return { provider: $('#api-provider').value, base_url: $('#api-base').value.trim(), model: $('#api-model').value.trim(), api_key: $('#api-key').value || null, keep_existing_key: Boolean($('#api-keep').checked && sameProviderScope()), admin_password: $('#api-password').value, expected_generation: providerSettings.llm.generation }
}
async function providerAction(operation) {
  const state = $('#api-state'); state.textContent = '处理中…'; state.className = 's-hint wait'
  try {
    const body = operation === 'providerRestore' ? { admin_password: $('#api-password').value, expected_generation: providerSettings.llm.generation } : llmSettingsBody()
    const response = await api(operation, body), data = await response.json()
    if (!response.ok) throw new Error(data.error || '操作失败')
    state.textContent = operation === 'providerTest' ? `测试通过 · ${data.latency_ms || 0} ms` : '已保存并应用'
    state.className = 's-hint ok'
    if (operation !== 'providerTest') await loadProviderSettings()
  } catch (error) { if (!isAuthenticationRequired(error)) { state.textContent = error.message; state.className = 's-hint bad' } }
  finally { clearProviderSecrets() }
}
function integrationBody() {
  const name = $('#integration-name').value, current = providerSettings.integrations[name]
  return { name, enabled: $('#integration-enabled').checked, base_url: name === 'searxng' ? $('#integration-base').value.trim() : '', api_key: $('#integration-key').value || null, keep_existing_key: $('#integration-keep').checked, admin_password: $('#integration-password').value, expected_generation: current.generation }
}
async function integrationAction(operation) {
  const state = $('#integration-state'); state.textContent = '处理中…'; state.className = 's-hint wait'
  try {
    const full = integrationBody()
    const body = operation === 'integrationRestore' ? { name: full.name, admin_password: full.admin_password, expected_generation: full.expected_generation } : full
    const response = await api(operation, body), data = await response.json()
    if (!response.ok) throw new Error(data.error || '操作失败')
    state.textContent = operation === 'integrationTest' ? '测试通过' : '已更新联网数据源'; state.className = 's-hint ok'
    if (operation !== 'integrationTest') await loadProviderSettings()
  } catch (error) { if (!isAuthenticationRequired(error)) { state.textContent = error.message; state.className = 's-hint bad' } }
  finally { clearIntegrationSecrets() }
}
$('#api-provider').addEventListener('change', () => { const item = providerItem(); $('#api-base').value = item?.base_url || ''; $('#api-key').value = ''; $('#api-keep').checked = false; renderProvider() })
$('#api-base').addEventListener('input', () => { $('#api-key').value = ''; $('#api-keep').checked = false; renderProvider() })
$('#api-key-link').addEventListener('click', () => { const url = providerItem()?.key_url; if (url) void window.jws.openProviderLink(url) })
$('#api-test').addEventListener('click', () => void providerAction('providerTest'))
$('#api-save').addEventListener('click', () => void providerAction('providerSave'))
$('#api-restore').addEventListener('click', () => void providerAction('providerRestore'))
$('#integration-name').addEventListener('change', renderIntegration)
$('#integration-test').addEventListener('click', () => void integrationAction('integrationTest'))
$('#integration-save').addEventListener('click', () => void integrationAction('integrationSave'))
$('#integration-restore').addEventListener('click', () => void integrationAction('integrationRestore'))

/* ---------- 语音与晨报设置（服务端每用户偏好，与网页端共用） ---------- */
async function loadVoiceSettings() {
  const state = $('#s-voice-state')
  try {
    const voiceResp = await api('voiceSettingsGet')
    const v = await voiceResp.json()
    if (!voiceResp.ok) throw new Error(v.error || '读取语音设置失败')
    $('#s-voice').innerHTML = (v.catalog || [])
      .map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')
    $('#s-voice').value = v.voice
    $('#s-speed').value = v.speed
    $('#s-speed-v').textContent = `${Number(v.speed).toFixed(2)}×`
    const radioResp = await api('radioGet')
    const r = await radioResp.json()
    if (!radioResp.ok) throw new Error(r.error || '读取晨报设置失败')
    $('#s-radio').value = r.time || ''
    state.textContent = ''; state.className = 's-hint'
  } catch (error) {
    if (!isAuthenticationRequired(error)) { state.textContent = error.message || '读取语音设置失败'; state.className = 's-hint bad' }
  }
}
$('#s-speed').addEventListener('input', () => {
  $('#s-speed-v').textContent = `${Number($('#s-speed').value).toFixed(2)}×`
})
$('#s-voice-save').addEventListener('click', async () => {
  const state = $('#s-voice-state')
  state.textContent = '保存中…'; state.className = 's-hint wait'
  try {
    const put = await api('voiceSettingsPut', { voice: $('#s-voice').value, speed: Number($('#s-speed').value) })
    const radio = await api('radioPut', { time: $('#s-radio').value || '' })
    if (!put.ok || !radio.ok) throw new Error('保存失败')
    state.textContent = '已保存；下一通语音通话生效'; state.className = 's-hint ok'
  } catch (error) {
    if (!isAuthenticationRequired(error)) { state.textContent = error.message || '保存失败'; state.className = 's-hint bad' }
  }
})

async function openSettings() {
  const s = await window.jws.getSettings()
  $('#s-autolaunch').checked = !!s.openAtLogin
  $('#s-ballsize').value = s.ballSize || 64
  $('#s-ballsize-v').textContent = (s.ballSize || 64) + 'px'
  $('#s-ballstyle').value = s.ballStyle || 'moss'
  $('#s-imgrow').style.display = (s.ballStyle === 'img') ? '' : 'none'
  const savedImg = localStorage.getItem('jws_ball_img')
  if (savedImg) { $('#s-imgprev').src = savedImg; $('#s-imgprev').style.display = '' }
  pendingHotkey = s.hotkey || ''
  renderHkField()
  $('#s-hotkey-state').textContent = s.hotkey
    ? (s.hotkeyOk ? `当前生效：${displayAcc(s.hotkey)}` : `注册失败（可能被占用）：${displayAcc(s.hotkey)}`)
    : '未启用'
  $('#s-hotkey-state').className = 's-hint ' + (s.hotkey ? (s.hotkeyOk ? 'ok' : 'bad') : '')
  $('#s-server').value = s.server || ''
  $('#s-about').textContent = s.appInfo
    ? `版本 ${s.appInfo.hash} · 本次启动 ${s.appInfo.startedAt}（更新代码后请从托盘重启）` : ''
  $('#s-msg').textContent = ''
  document.body.classList.add('show-settings')
  void loadVoiceSettings()
  void wxController.start()
  try { await loadProviderSettings() } catch (error) { if (!isAuthenticationRequired(error)) { $('#api-state').textContent = error.message; $('#api-state').className = 's-hint bad' } }
}

$('#setbtn').addEventListener('click', openSettings)
$('#backbtn').addEventListener('click', () => {
  stopRecording()
  wxController.stop()
  document.body.classList.remove('show-settings')
})

$('#s-save').addEventListener('click', async () => {
  const ballSize = parseInt($('#s-ballsize').value, 10)
  const ballStyle = $('#s-ballstyle').value
  const server = $('#s-server').value.trim().replace(/\/+$/, '')
  const r = await window.jws.setSettings({
    hotkey: pendingHotkey,
    openAtLogin: $('#s-autolaunch').checked,
    ballSize,
    ballStyle,
    server,
  })
  applyBallLook(ballSize, ballStyle)
  const msg = $('#s-msg')
  const st = $('#s-hotkey-state')
  if (pendingHotkey && !r.hotkeyOk) {
    msg.textContent = '⚠ 快捷键注册失败（可能与其他应用冲突），其余设置已保存'
    msg.className = 's-hint bad'
    st.textContent = `注册失败：${displayAcc(pendingHotkey)}`
    st.className = 's-hint bad'
  } else {
    msg.textContent = '已保存并生效；如更换服务器，请重新登录'
    msg.className = 's-hint ok'
    st.textContent = pendingHotkey ? `当前生效：${displayAcc(pendingHotkey)}` : '未启用'
    st.className = 's-hint ' + (pendingHotkey ? 'ok' : '')
  }
})

/* 网页端接管：主进程换票成功后重新探活进入已登录状态；唤起端口被占用时给人话提示。 */
if (window.jws.onHandoffAuthenticated) {
  window.jws.onHandoffAuthenticated(() => { void loginController.init().catch(() => {}) })
}
if (window.jws.onWakeNotice) {
  window.jws.onWakeNotice(text => sys(text))
}

/* 启动：仅主进程可恢复安全会话；失效时自动展开登录与自托管配置。 */
;(async () => {
  try {
    const result = await loginController.init()
    $('#desktop-server').value = result.server
    if (!result.authenticated) state.textContent = '请登录'
  } catch (e) {
    requireLogin()
    sys('连不上服务器：' + e.message)
  }
})()
