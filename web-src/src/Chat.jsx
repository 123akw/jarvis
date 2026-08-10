import { useEffect, useRef, useState } from 'react'
import { chatStream } from './api.js'

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const md = t => esc(t)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/`([^`]+?)`/g, '<code>$1</code>')
  .replace(/\n/g, '<br>')

let nextId = 1

export default function Chat({ onBusy, onTurnDone, onExpired, location }) {
  const [msgs, setMsgs] = useState([{
    id: 0, kind: 'jarvis', raw: '先生，各系统自检完毕，随时候命。日程、待办、备忘在右侧面板实时同步。',
    chips: [], streaming: false,
  }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef()
  const boxRef = useRef()

  useEffect(() => { logRef.current.scrollTop = logRef.current.scrollHeight }, [msgs])
  useEffect(() => { onBusy?.(busy); if (!busy) boxRef.current?.focus() }, [busy])

  function patchLast(fn) {
    setMsgs(ms => {
      const out = [...ms]
      out[out.length - 1] = fn({ ...out[out.length - 1] })
      return out
    })
  }

  async function ask(e) {
    e?.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setMsgs(ms => [...ms,
      { id: nextId++, kind: 'user', raw: text, chips: [], streaming: false },
      { id: nextId++, kind: 'jarvis', raw: '', chips: [], streaming: true },
    ])
    try {
      for await (const ev of chatStream(text, location)) {
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
      patchLast(m => ({ ...m, error: `链路中断：${err.message}` }))
    } finally {
      patchLast(m => ({ ...m, streaming: false }))
      setBusy(false)
      onTurnDone?.()
    }
  }

  return (
    <section className="center">
      <div className="pane logpane">
        <div className="log" ref={logRef}>
          {msgs.map(m => (
            <div key={m.id} className={`msg ${m.kind}`}>
              <div className="who">{m.kind === 'user' ? '领导' : 'J.A.R.V.I.S.'}</div>
              {m.chips.length > 0 && (
                <div className="chips">
                  {m.chips.map((c, i) => (
                    <span key={i} className={`tchip${c.done ? ' done' : ''}`}>
                      ⚙ {c.name} <span className="st">{c.done ? '✓' : '…'}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="body"
                dangerouslySetInnerHTML={{ __html: md(m.raw) + (m.streaming ? '<span class="caret"></span>' : '') }} />
              {m.error && <div className="msg-err">⚠ {m.error}</div>}
            </div>
          ))}
        </div>
      </div>
      <form className="pane inputbar" onSubmit={ask}>
        <span className="prompt">&gt;</span>
        <input ref={boxRef} value={input} onChange={e => setInput(e.target.value)}
          placeholder="吩咐一句…（Enter 发送）" autoComplete="off" disabled={busy} autoFocus />
        <button className="send" disabled={busy}>执行</button>
      </form>
    </section>
  )
}
