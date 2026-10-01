import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { chatStream, getHistory, uploadDocument } from './api.js'
import {
  createStreamingView, handleCodeCopyClick, highlighterVersion, renderMarkdown, subscribeHighlighter,
} from './markdown.js'
import { toolLabel } from './toolInfo.js'
import VoiceCall from './VoiceCall.jsx'

/* 帧调度：token 先进缓冲，一帧最多刷一次（无 rAF 的环境退回 16ms 定时器） */
const hasRaf = typeof requestAnimationFrame === 'function'
const nextFrame = cb => (hasRaf ? requestAnimationFrame(cb) : setTimeout(cb, 16))
const cancelFrame = id => (hasRaf ? cancelAnimationFrame(id) : clearTimeout(id))
const STICK_PX = 80   // 距底部这么近才自动跟随；用户往上翻看时不再被拽回底部

/** 工具调用 chip：中文名 + 成败 + 耗时，点击展开结果摘要 */
function ToolChip({ chip }) {
  const [open, setOpen] = useState(false)
  const status = !chip.done ? '…' : chip.ok === false ? '✗' : '✓'
  return (
    <span className={`tchip${chip.done ? (chip.ok === false ? ' fail' : ' done') : ''}`}>
      <button className="tchip-btn" disabled={!chip.detail}
        onClick={() => setOpen(v => !v)}
        title={chip.detail ? (open ? '收起结果' : '查看结果') : undefined}>
        {toolLabel(chip.name)} <span className="st">{status}</span>
        {chip.done && chip.ms != null && <span className="tms">{chip.ms}ms</span>}
      </button>
      {open && chip.detail && <span className="tdetail">{chip.detail}</span>}
    </span>
  )
}

/** 回答正文：流式时走增量视图（已完结块只渲染/挂载一次，每帧只替换尾巴），
 *  定稿后整条渲染一次（带缓存）。React 不管理其子节点，DOM 由这里直接维护。 */
const JarvisBody = memo(function JarvisBody({ raw, streaming }) {
  const ref = useRef(null)
  const viewRef = useRef(null)
  // 代码高亮器懒加载完成后，含代码块的消息重渲染一次（其余消息不受影响）
  const hlv = useSyncExternalStore(subscribeHighlighter, highlighterVersion)
  const hlDep = raw.includes('```') ? hlv : 0
  useLayoutEffect(() => {
    const el = ref.current
    if (streaming) {
      if (!viewRef.current) viewRef.current = createStreamingView(el)
      viewRef.current.update(raw)
    } else {
      viewRef.current = null
      el.innerHTML = renderMarkdown(raw)
    }
  }, [raw, streaming, hlDep])
  return <div className="jbody" ref={ref} onClick={handleCodeCopyClick} />
})

function copyText(raw) {
  navigator.clipboard?.writeText(raw)
}

/** 单条消息行：memo 后流式刷新只重渲染正在生成的那一行，长对话不再整表重算 */
const MsgRow = memo(function MsgRow({ m, prevUser, busy, onSend, onEdit }) {
  if (m.kind === 'user') {
    return (
      <div className="row-user">
        <div className="uactions">
          <button className="abtn" onClick={() => copyText(m.raw)} title="复制这条消息">复制</button>
          <button className="abtn" title="编辑后重新发送" onClick={() => onEdit(m.raw)}>编辑</button>
        </div>
        <div className="ubox">{m.raw}</div>
      </div>
    )
  }
  return (
    <div className="row-jarvis">
      <div className="jtag">{m.streaming && <span className="jdot" />}J.A.R.V.I.S.</div>
      {m.chips.length > 0 && (
        <div className="chips">
          {m.chips.map((c, i) => <ToolChip key={c.id || i} chip={c} />)}
        </div>
      )}
      <JarvisBody raw={m.raw} streaming={m.streaming} />
      {m.error && (
        <div className="msg-err">⚠ {m.error}
          {!busy && prevUser && (
            <button className="retrybtn" onClick={() => onSend(prevUser)}>重试</button>
          )}
        </div>
      )}
      {!m.streaming && m.raw && (
        <div className="msg-actions">
          <button className="abtn" onClick={() => copyText(m.raw)} title="复制回答原文">复制</button>
          {prevUser && (
            <button className="abtn" disabled={busy} title="就同一个问题再答一次"
              onClick={() => onSend(prevUser)}>重新回答</button>
          )}
        </div>
      )}
    </div>
  )
})

const SUGGESTIONS = ['给我今日晨报', '我在做什么任务？', '今天天气怎么样？', '记一条备忘：']

let nextId = 1

function Chat({ threadId, location, onBusy, onTurnDone, onExpired, injected = null }) {
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [calling, setCalling] = useState(false)
  const [histSeq, setHistSeq] = useState(0) // 通话挂断后 +1，回放通话期间的对话
  const logRef = useRef()
  const boxRef = useRef()
  const abortRef = useRef(null)
  const fileRef = useRef()
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  const stickRef = useRef(true)     // 视口是否贴底（贴底才自动跟随）
  const tokBuf = useRef('')         // 尚未刷到界面的 token
  const tokFrame = useRef(0)

  useEffect(() => {  // 切换会话/挂断通话：从服务端记忆库回放历史
    setMsgs([])
    stickRef.current = true
    let alive = true
    getHistory(threadId).then(h => {
      if (!alive) return
      setMsgs(h.map(m => ({
        id: nextId++, kind: m.role === 'user' ? 'user' : 'jarvis',
        raw: m.content, chips: [], streaming: false,
      })))
    }).catch(e => { if (e.message === '401') onExpired?.() })
    return () => { alive = false }
  }, [threadId, histSeq])

  /* 自动滚动：只在贴底时跟随，且在绘制前同步完成（旧版每个 token 都无条件 scrollTop=scrollHeight，
   * 叠加 CSS smooth 滚动反复重启动画，既抖又会把正在往上翻的用户拽回底部） */
  const stickToBottom = useCallback(() => {
    const el = logRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [])
  useLayoutEffect(stickToBottom, [msgs])
  useEffect(() => {   // 内容高度的异步变化（图片、代码块换行、content-visibility 估高落地）也跟随
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(stickToBottom)
    ro.observe(logRef.current.firstElementChild)
    return () => ro.disconnect()
  }, [stickToBottom])
  function onLogScroll() {
    const el = logRef.current
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
  }

  useEffect(() => { onBusy?.(busy); if (!busy) boxRef.current?.focus() }, [busy])
  useEffect(() => () => { if (tokFrame.current) cancelFrame(tokFrame.current) }, [])

  useEffect(() => {  // 外部注入的消息（会议纪要「追问」）：整条自动发出，后续可连续追问
    if (injected?.text) void send(injected.text)
  }, [injected?.seq])

  function patchLast(fn) {
    setMsgs(ms => {
      const out = [...ms]
      out[out.length - 1] = fn({ ...out[out.length - 1] })
      return out
    })
  }

  /** 把缓冲的 token 一次性并入最后一条回答（每帧至多一次 setState） */
  function flushTokens() {
    if (tokFrame.current) { cancelFrame(tokFrame.current); tokFrame.current = 0 }
    const text = tokBuf.current
    if (!text) return
    tokBuf.current = ''
    patchLast(m => ({ ...m, raw: m.raw + text }))
  }

  function queueToken(text) {
    tokBuf.current += text
    if (!tokFrame.current) tokFrame.current = nextFrame(() => { tokFrame.current = 0; flushTokens() })
  }

  function autoGrow() {
    const el = boxRef.current
    if (!el) return  // 「编辑」经 rAF 延后调用，期间组件可能已卸载
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 168) + 'px'
  }

  async function send(text) {
    text = text.trim()
    if (!text || busy) return
    setInput('')
    if (boxRef.current) boxRef.current.style.height = 'auto'
    setBusy(true)
    stickRef.current = true   // 自己发的消息总是滚到底
    tokBuf.current = ''
    setMsgs(ms => [...ms,
      { id: nextId++, kind: 'user', raw: text, chips: [], streaming: false },
      { id: nextId++, kind: 'jarvis', raw: '', chips: [], streaming: true },
    ])
    abortRef.current = new AbortController()
    try {
      for await (const ev of chatStream(text, location, threadId, abortRef.current.signal)) {
        if (ev.type === 'token') {
          queueToken(ev.text)
          continue
        }
        flushTokens()   // 工具/错误事件前先把已到的正文落地，保持先后顺序
        if (ev.type === 'tool_start') {
          patchLast(m => ({ ...m, chips: [...m.chips, { id: ev.id, name: ev.name, done: false }] }))
        } else if (ev.type === 'tool_result') {
          patchLast(m => {
            const chips = [...m.chips]
            // 按调用 id 精确配对；旧服务端无 id 时退回「同名未完成」
            const i = ev.id
              ? chips.findIndex(c => c.id === ev.id)
              : chips.findIndex(c => c.name === ev.name && !c.done)
            if (i >= 0) chips[i] = { ...chips[i], done: true, ok: ev.ok, ms: ev.ms, detail: ev.detail }
            return { ...m, chips }
          })
        } else if (ev.type === 'error') {
          patchLast(m => ({ ...m, error: ev.message }))
        }
      }
    } catch (err) {
      flushTokens()
      if (err.message === '401') { onExpired?.(); return }
      if (err.name !== 'AbortError') {
        patchLast(m => ({ ...m, error: `链路中断：${err.message}` }))
      }
    } finally {
      abortRef.current = null
      flushTokens()
      patchLast(m => ({ ...m, streaming: false }))
      setBusy(false)
      onTurnDone?.()
    }
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
  }

  /** 📎 文档上传：解析成文本后作为一条消息发出，让贾维斯先总结、后续可追问 */
  async function onPickFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || busy || uploading) return
    setUploadErr('')
    if (file.size > 10 * 1024 * 1024) { setUploadErr('文件超过 10MB 上限'); return }
    setUploading(true)
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
      const doc = await uploadDocument(file.name, b64)
      if (doc.kind === 'image') {
        await send(`我发了一张图片《${doc.name}》，以下是对画面的识别描述，请基于它先简要回应，我可能会继续追问图里的细节。\n\n【图片内容】\n${doc.text}\n【图片内容结束】`)
      } else if (doc.kind === 'video') {
        await send(`我发了一段视频《${doc.name}》，以下是对画面的识别描述（无声音），请基于它先简要回应，我可能会继续追问。\n\n【视频内容】\n${doc.text}\n【视频内容结束】`)
      } else {
        const notice = doc.truncated ? '（文档过长，以下为截断后的开头部分）' : ''
        await send(`请通读这份文档《${doc.name}》${notice}，先用不超过 5 条要点总结主要内容；之后我会就它继续提问。\n\n【文档开始】\n${doc.text}\n【文档结束】`)
      }
    } catch (err) {
      if (err.message === '401') { onExpired?.(); return }
      setUploadErr(err.message || '上传失败')
    } finally {
      setUploading(false)
    }
  }

  /* 行组件拿到的回调保持引用稳定（memo 才生效），内部总是调用最新一版 send */
  const sendRef = useRef(send)
  sendRef.current = send
  const onRowSend = useCallback(text => { void sendRef.current(text) }, [])
  const onRowEdit = useCallback(raw => {
    setInput(raw); boxRef.current?.focus(); requestAnimationFrame(autoGrow)
  }, [])

  let lastUser = ''   // 每条回答对应的上一条用户提问（重新回答 / 失败重试用）
  return (
    <section className="center">
      <div className="log" ref={logRef} onScroll={onLogScroll}>
        <div className="logcol">
          {msgs.length === 0 && !busy && (
            <div className="chat-empty">
              <div className="ce-title">有什么吩咐？</div>
              <div className="ce-chips">
                {SUGGESTIONS.map(s => (
                  <button key={s} className="ce-chip" onClick={() =>
                    s.endsWith('：') ? (setInput(s), boxRef.current?.focus()) : send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map(m => {
            const prevUser = m.kind === 'user' ? '' : lastUser
            if (m.kind === 'user') lastUser = m.raw
            return (
              <MsgRow key={m.id} m={m} prevUser={prevUser} busy={m.kind === 'user' ? false : busy}
                onSend={onRowSend} onEdit={onRowEdit} />
            )
          })}
        </div>
      </div>
      <div className="inputwrap">
        {uploadErr && <div className="upload-err">⚠ {uploadErr}</div>}
        <div className="inputbar2">
          <textarea ref={boxRef} value={input} rows={1}
            onChange={e => { setInput(e.target.value); autoGrow() }}
            onKeyDown={onKey}
            placeholder="吩咐一句…（Enter 发送，Shift+Enter 换行）" autoFocus />
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.webp,.bmp,.mp4,.mov" style={{ display: 'none' }}
            aria-label="选择文档" onChange={onPickFile} />
          <button className="callbtn" onClick={() => fileRef.current?.click()}
            disabled={busy || uploading}
            title="上传文档（PDF / Word / TXT / MD）" aria-label="上传文档">{uploading ? '…' : '📎'}</button>
          <button className="callbtn" onClick={() => setCalling(true)} disabled={busy}
            title="语音通话" aria-label="语音通话">📞</button>
          {busy
            ? <button className="stopbtn" onClick={() => abortRef.current?.abort()} title="停止生成">◼</button>
            : <button className="sendbtn" onClick={() => send(input)} disabled={!input.trim()} title="发送">↑</button>}
        </div>
      </div>
      {calling && (
        <VoiceCall threadId={threadId} onExpired={onExpired}
          onClose={() => { setCalling(false); setHistSeq(s => s + 1) }} />
      )}
    </section>
  )
}

/* 顶栏时钟、任务台轮询等父组件刷新不再连带整个对话区重渲染 */
export default memo(Chat)
