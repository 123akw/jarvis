import { useEffect, useRef, useState } from 'react'
import { chatStream, getHistory } from './api.js'

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 迷你 Markdown 渲染：代码块/标题/列表/粗体/行内代码，够聊天用，不引依赖 */
function md(t) {
  let s = t
  if (((s.match(/```/g) || []).length) % 2 === 1) s += '\n```'  // 流式中未闭合的代码块
  s = esc(s)
  s = s.replace(/```\w*\n?([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trimEnd()}</code></pre>`)
  s = s.replace(/^#{1,3} (.+)$/gm, '<h4>$1</h4>')
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/`([^`]+?)`/g, '<code>$1</code>')
  s = s.replace(/(^|\n)((?:[-•] .*(?:\n|$))+)/g, (_, pre, block) =>
    `${pre}<ul>${block.trim().split('\n').map(l => `<li>${l.replace(/^[-•] /, '')}</li>`).join('')}</ul>`)
  s = s.replace(/(^|\n)((?:\d+[.、] .*(?:\n|$))+)/g, (_, pre, block) =>
    `${pre}<ol>${block.trim().split('\n').map(l => `<li>${l.replace(/^\d+[.、] /, '')}</li>`).join('')}</ol>`)
  s = s.replace(/\n/g, '<br>')
  s = s.replace(/<br>(<\/?(?:ul|ol|li|h4|pre))/g, '$1').replace(/(<\/(?:ul|ol|h4|pre)>)<br>/g, '$1')
  return s
}

const SUGGESTIONS = ['今天天气怎么样？', '我今天有什么安排？', '记一条备忘：']

let nextId = 1

export default function Chat({ threadId, location, onBusy, onTurnDone, onExpired }) {
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef()
  const boxRef = useRef()
  const abortRef = useRef(null)

  useEffect(() => {  // 切换会话：从服务端记忆库回放历史
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
  }, [threadId])

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
          patchLast(m => ({ ...m, chips: [...m.chips, { name: ev.name, done: false }] }))
        } else if (ev.type === 'tool_result') {
          patchLast(m => {
            const chips = [...m.chips]
            const i = chips.findIndex(c => c.name === ev.name && !c.done)
            if (i >= 0) chips[i] = { ...chips[i], done: true }
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

  function copyText(raw) {
    navigator.clipboard?.writeText(raw)
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
          {msgs.map(m => m.kind === 'user' ? (
            <div key={m.id} className="row-user"><div className="ubox">{m.raw}</div></div>
          ) : (
            <div key={m.id} className="row-jarvis">
              <div className="jtag">J.A.R.V.I.S.</div>
              {m.chips.length > 0 && (
                <div className="chips">
                  {m.chips.map((c, i) => (
                    <span key={i} className={`tchip${c.done ? ' done' : ''}`}>
                      ⚙ {c.name} <span className="st">{c.done ? '✓' : '…'}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="jbody" dangerouslySetInnerHTML={{
                __html: md(m.raw) + (m.streaming ? '<span class="caret"></span>' : '')
              }} />
              {m.error && <div className="msg-err">⚠ {m.error}</div>}
              {!m.streaming && m.raw && (
                <button className="copybtn" onClick={() => copyText(m.raw)}>复制</button>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="inputwrap">
        <div className="inputbar2">
          <textarea ref={boxRef} value={input} rows={1}
            onChange={e => { setInput(e.target.value); autoGrow() }}
            onKeyDown={onKey}
            placeholder="吩咐一句…（Enter 发送，Shift+Enter 换行）" autoFocus />
          {busy
            ? <button className="stopbtn" onClick={() => abortRef.current?.abort()} title="停止生成">◼</button>
            : <button className="sendbtn" onClick={() => send(input)} disabled={!input.trim()} title="发送">↑</button>}
        </div>
      </div>
    </section>
  )
}
