import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { addProfile, deleteProfile, getMemoryState, getPersona, getProfile, saveMemoryPrefs, savePersona } from './api.js'
import { receiptsOn, setReceipts, subscribeReceipts } from './memoryPrefs.js'
import Modal, { ModalHead } from './Modal.jsx'

/** 「显示记忆回执」总开关：乐观切换，保存失败回滚并说明 */
function ReceiptSwitch({ onExpired }) {
  const on = useSyncExternalStore(subscribeReceipts, receiptsOn)
  const [err, setErr] = useState('')

  useEffect(() => {   // 打开面板时和服务端对一次（别的设备可能改过）
    Promise.resolve().then(() => getMemoryState())
      .then(s => { if (s) setReceipts(s.receipts !== false) })
      .catch(e => { if (e?.message === '401') onExpired?.() })
  }, [])

  async function toggle(next) {
    setErr('')
    setReceipts(next)
    try {
      await saveMemoryPrefs(next)
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setReceipts(!next)
      setErr('没能保存，请稍后再试')
    }
  }

  return (
    <div className="memory-switch">
      <label className="ms-text" htmlFor="jv-receipts-switch">
        <span className="ms-title">显示记忆回执</span>
        <span className="ms-sub">对话里记住或忘记时，在回答下方留一行回执，可一键撤销</span>
        {err ? <span className="ms-err" role="alert">{err}</span> : null}
      </label>
      <input id="jv-receipts-switch" type="checkbox" role="switch" className="jv-switch"
        checked={on} aria-checked={on} onChange={e => void toggle(e.target.checked)} />
    </div>
  )
}

/** 人设工坊：称呼 / 语气口头禅（人格只有 J.A.R.V.I.S. 一种，不再显示切换） */
function PersonaSection({ onExpired }) {
  const [address, setAddress] = useState('')
  const [flavor, setFlavor] = useState('')
  const [state, setState] = useState('')

  useEffect(() => {
    getPersona()
      .then(p => { setAddress(p.address); setFlavor(p.flavor) })
      .catch(e => { if (e.message === '401') onExpired?.() })
  }, [])

  async function save() {
    setState('保存中…')
    try {
      await savePersona('jarvis', address.trim(), flavor.trim())
      setState('已保存；新对话立即生效。')
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setState(e.message || '保存失败')
    }
  }

  return (
    <div className="persona-box">
      <label>怎么称呼你
        <input aria-label="称呼" value={address} maxLength={12} placeholder="默认「领导」"
          onChange={e => setAddress(e.target.value)} />
      </label>
      <label className="persona-flavor">语气 / 口头禅（可选）
        <input aria-label="语气" value={flavor} maxLength={120}
          placeholder="例如：回答末尾偶尔加一句冷幽默"
          onChange={e => setFlavor(e.target.value)} />
      </label>
      <div className="persona-foot">
        <button className="jv-btn jv-btn--primary" onClick={save}>保存人设</button>
        <span className="persona-state">{state}</span>
      </div>
    </div>
  )
}

/** 「贾维斯记住了什么」：长期画像可查、可删、可手动补充；对话说「记住/忘记」也会进出这里。
 *  highlight：从「今日」板「昨晚为你整理了 N 条记忆 · 查看」进来时要标出的条目编号。 */
export default function MemoryPanel({ onClose, onExpired, highlight = [] }) {
  const [items, setItems] = useState(null)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')

  const load = () => getProfile()
    .then(r => setItems(r.items || []))
    .catch(e => { if (e.message === '401') onExpired?.(); else setErr('读取失败，请稍后再试') })

  useEffect(() => { load() }, [])
  const scrolled = useRef(false)
  useEffect(() => {   // 从「查看」进来：第一次读到列表时把新条目滚进视野（只滚一次，不跟着增删乱跳）
    if (scrolled.current || !items?.length || !highlight.length) return
    scrolled.current = true
    document.querySelector('.memory-list li.fresh')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [items])

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
    <Modal label="记忆与人设" onClose={onClose}>
      <ModalHead title="记忆与人设" subtitle="贾维斯怎么称呼你、怎么说话，以及长期记住的事" onClose={onClose} />
      <div className="jv-modal-body">
        <PersonaSection onExpired={onExpired} />
        <h3 className="jv-section-title">贾维斯记住了什么</h3>
        <p className="memory-hint">
          这些是关于你的长期画像，每轮对话贾维斯都会带着它们。
          对话里说「<b>记住我…</b>」会自动添加，「<b>忘记…</b>」会删除；这里也可以直接管理。
        </p>
        <ReceiptSwitch onExpired={onExpired} />
        {err && <div className="wx-err">{err}</div>}
        {items === null && !err && <div className="empty">读取中…</div>}
        {items?.length === 0 && <div className="empty">还没有记住任何长期画像。试试对贾维斯说「记住我喝咖啡只喝美式」。</div>}
        {items?.length > 0 && (
          <ul className="memory-list">
            {items.map(x => (
              <li key={x.id} className={highlight.includes(x.id) ? 'fresh' : undefined}>
                <span className="memory-text">
                  {highlight.includes(x.id) ? <span className="memory-new" title="昨晚从对话里整理出来的">新</span> : null}
                  {x.content}
                </span>
                <button className="memory-del" onClick={() => forget(x.id)} title="忘记这条">忘记</button>
              </li>
            ))}
          </ul>
        )}
        <div className="jv-add-row memory-add">
          <input value={draft} placeholder="＋ 手动补一条画像，回车确认"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        </div>
      </div>
    </Modal>
  )
}
