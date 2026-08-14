import { useEffect, useState } from 'react'
import { addProfile, deleteProfile, getPersona, getProfile, savePersona } from './api.js'

/** 人设工坊：称呼 / J.A.R.V.I.S.↔MOSS 人格 / 语气口头禅 */
function PersonaSection({ onExpired }) {
  const [style, setStyle] = useState('jarvis')
  const [address, setAddress] = useState('')
  const [flavor, setFlavor] = useState('')
  const [state, setState] = useState('')

  useEffect(() => {
    getPersona()
      .then(p => { setStyle(p.style); setAddress(p.address); setFlavor(p.flavor) })
      .catch(e => { if (e.message === '401') onExpired?.() })
  }, [])

  async function save() {
    setState('保存中…')
    try {
      await savePersona(style, address.trim(), flavor.trim())
      setState('已保存；新对话立即生效。')
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setState(e.message || '保存失败')
    }
  }

  return (
    <div className="persona-box">
      <div className="persona-grid">
        <label>人格
          <select aria-label="人格" value={style} onChange={e => setStyle(e.target.value)}>
            <option value="jarvis">J.A.R.V.I.S. · 英式管家</option>
            <option value="moss">MOSS · 冷静理性</option>
          </select>
        </label>
        <label>怎么称呼你
          <input aria-label="称呼" value={address} maxLength={12} placeholder="默认「领导」"
            onChange={e => setAddress(e.target.value)} />
        </label>
      </div>
      <label className="persona-flavor">语气 / 口头禅（可选）
        <input aria-label="语气" value={flavor} maxLength={120}
          placeholder="例如：回答末尾偶尔加一句冷幽默"
          onChange={e => setFlavor(e.target.value)} />
      </label>
      <div className="persona-foot">
        <button className="persona-save" onClick={save}>保存人设</button>
        <span className="persona-state">{state}</span>
      </div>
    </div>
  )
}

/** 「贾维斯记住了什么」：长期画像可查、可删、可手动补充；对话说「记住/忘记」也会进出这里 */
export default function MemoryPanel({ onClose, onExpired }) {
  const [items, setItems] = useState(null)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')

  const load = () => getProfile()
    .then(r => setItems(r.items || []))
    .catch(e => { if (e.message === '401') onExpired?.(); else setErr('读取失败，请稍后再试') })

  useEffect(() => { load() }, [])

  async function submit() {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    try { await addProfile(text) } catch (e) { if (e.message === '401') { onExpired?.(); return } }
    load()
  }

  async function forget(id) {
    try { await deleteProfile(id) } catch (e) { if (e.message === '401') { onExpired?.(); return } }
    load()
  }

  return (
    <div className="wx-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="wx-card memory-card">
        <div className="wx-head">
          <span className="wx-title">记忆与人设</span>
          <button className="wx-x" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="wx-body">
          <PersonaSection onExpired={onExpired} />
          <div className="memory-subtitle">贾维斯记住了什么</div>
          <p className="memory-hint">
            这些是关于你的长期画像，每轮对话贾维斯都会带着它们。
            对话里说「<b>记住我…</b>」会自动添加，「<b>忘记…</b>」会删除；这里也可以直接管理。
          </p>
          {err && <div className="wx-err">{err}</div>}
          {items === null && !err && <div className="empty">读取中…</div>}
          {items?.length === 0 && <div className="empty">还没有记住任何长期画像。试试对贾维斯说「记住我喝咖啡只喝美式」。</div>}
          {items?.length > 0 && (
            <ul className="memory-list">
              {items.map(x => (
                <li key={x.id}>
                  <span className="memory-text">{x.content}</span>
                  <button className="memory-del" onClick={() => forget(x.id)} title="忘记这条">忘记</button>
                </li>
              ))}
            </ul>
          )}
          <div className="paddrow memory-add">
            <input value={draft} placeholder="＋ 手动补一条画像，回车确认"
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }} />
          </div>
        </div>
      </div>
    </div>
  )
}
