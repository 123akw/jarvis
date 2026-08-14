import { memo, useEffect, useRef, useState } from 'react'
import { chatStream, getHistory, uploadDocument } from './api.js'
import { handleCodeCopyClick, renderMarkdown } from './markdown.js'
import { toolLabel } from './toolInfo.js'
import VoiceCall from './VoiceCall.jsx'

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

/** 回答正文单独成组件并 memo：流式时只重渲染正在生成的那条，不拖累整个历史 */
const JarvisBody = memo(function JarvisBody({ raw, streaming }) {
  return (
    <div className="jbody" onClick={handleCodeCopyClick} dangerouslySetInnerHTML={{
      __html: renderMarkdown(raw, { streaming })
    }} />
  )
})

const SUGGESTIONS = ['给我今日晨报', '我在做什么任务？', '今天天气怎么样？', '记一条备忘：']

let nextId = 1

export default function Chat({ threadId, location, onBusy, onTurnDone, onExpired }) {
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

  useEffect(() => {  // 切换会话/挂断通话：从服务端记忆库回放历史
    setMsgs([])
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

  useEffect(() => { logRef.current.scrollTop = logRef.current.scrollHeight }, [msgs])
  useEffect(() => { onBusy?.(busy); if (!busy) boxRef.current?.focus() }, [busy])

  function patchLast(fn) {
    setMsgs(ms => {
      const out = [...ms]
      out[out.length - 1] = fn({ ...out[out.length - 1] })
      return out
    })
  }

  function autoGrow() {
    const el = boxRef.current
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 168) + 'px'
  }

  async function send(text) {
    text = text.trim()
    if (!text || busy) return
    setInput('')
    if (boxRef.current) boxRef.current.style.height = 'auto'
    setBusy(true)
    setMsgs(ms => [...ms,
      { id: nextId++, kind: 'user', raw: text, chips: [], streaming: false },
      { id: nextId++, kind: 'jarvis', raw: '', chips: [], streaming: true },
    ])
    abortRef.current = new AbortController()
    try {
      for await (const ev of chatStream(text, location, threadId, abortRef.current.signal)) {
        if (ev.type === 'token') {
          patchLast(m => ({ ...m, raw: m.raw + ev.text }))
        } else if (ev.type === 'tool_start') {
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
      if (err.message === '401') { onExpired?.(); return }
      if (err.name !== 'AbortError') {
        patchLast(m => ({ ...m, error: `链路中断：${err.message}` }))
      }
    } finally {
      abortRef.current = null
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
      const notice = doc.truncated ? '（文档过长，以下为截断后的开头部分）' : ''
      await send(`请通读这份文档《${doc.name}》${notice}，先用不超过 5 条要点总结主要内容；之后我会就它继续提问。\n\n【文档开始】\n${doc.text}\n【文档结束】`)
    } catch (err) {
      if (err.message === '401') { onExpired?.(); return }
      setUploadErr(err.message || '上传失败')
    } finally {
      setUploading(false)
    }
  }

  function copyText(raw) {
    navigator.clipboard?.writeText(raw)
  }

  /** 该条回答对应的上一条用户提问（重新回答 / 失败重试用） */
  function userTextBefore(idx) {
    for (let i = idx - 1; i >= 0; i--) if (msgs[i].kind === 'user') return msgs[i].raw
    return ''
  }

  return (
    <section className="center">
      <div className="log" ref={logRef}>
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
          {msgs.map((m, idx) => m.kind === 'user' ? (
            <div key={m.id} className="row-user">
              <div className="uactions">
                <button className="abtn" onClick={() => copyText(m.raw)} title="复制这条消息">复制</button>
                <button className="abtn" title="编辑后重新发送"
                  onClick={() => { setInput(m.raw); boxRef.current?.focus(); requestAnimationFrame(autoGrow) }}>编辑</button>
              </div>
              <div className="ubox">{m.raw}</div>
            </div>
          ) : (
            <div key={m.id} className="row-jarvis">
              <div className="jtag">{m.streaming && <span className="jdot" />}J.A.R.V.I.S.</div>
              {m.chips.length > 0 && (
                <div className="chips">
                  {m.chips.map((c, i) => <ToolChip key={c.id || i} chip={c} />)}
                </div>
              )}
              <JarvisBody raw={m.raw} streaming={m.streaming} />
              {m.error && (
                <div className="msg-err">⚠ {m.error}
                  {!busy && userTextBefore(idx) && (
                    <button className="retrybtn" onClick={() => send(userTextBefore(idx))}>重试</button>
                  )}
                </div>
              )}
              {!m.streaming && m.raw && (
                <div className="msg-actions">
                  <button className="abtn" onClick={() => copyText(m.raw)} title="复制回答原文">复制</button>
                  {userTextBefore(idx) && (
                    <button className="abtn" disabled={busy} title="就同一个问题再答一次"
                      onClick={() => send(userTextBefore(idx))}>重新回答</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="inputwrap">
        {uploadErr && <div className="upload-err">⚠ {uploadErr}</div>}
        <div className="inputbar2">
          <textarea ref={boxRef} value={input} rows={1}
            onChange={e => { setInput(e.target.value); autoGrow() }}
            onKeyDown={onKey}
            placeholder="吩咐一句…（Enter 发送，Shift+Enter 换行）" autoFocus />
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" style={{ display: 'none' }}
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
