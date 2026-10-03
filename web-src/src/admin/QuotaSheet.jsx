import { useRef, useState } from 'react'
import Modal, { ModalHead } from '../Modal.jsx'
import { QUOTA_FIELDS, saveQuota } from './api.js'
import { fmtInt, QUOTA_LABELS, quotaMode, quotaValue } from './model.js'

/* 改配额弹层：模型调用、流程运行各一项，三选一——
 *   不限（默认只有管理员不限）/ 用默认（跟着全站默认值走）/ 自定义（1–100000 的整数）。
 * 保存调 PUT /api/admin/quotas/{user_id}，成功后把新的 quota 交回页面。 */

const RANGE_HINT = '填 1 到 100000 之间的整数'

function Field({ field, choice, onChange, used, fallback, error, inputRef }) {
  const { title, unit } = QUOTA_LABELS[field]
  const name = `ad-q-${field}`
  const opt = (mode, label, hint) => (
    <label className={`ad-q-opt${choice.mode === mode ? ' on' : ''}`}>
      <input type="radio" name={name} value={mode} checked={choice.mode === mode} onChange={() => onChange({ mode })} />
      <span className="ad-q-opt-text"><b>{label}</b><small>{hint}</small></span>
    </label>
  )
  return (
    <fieldset className="ad-q-field">
      <legend className="ad-q-legend">
        <span>{title}</span>
        <span className="ad-q-used">今天已用 {fmtInt(used)} {unit}</span>
      </legend>
      <div className="ad-q-opts">
        {opt('unlimited', '不限', '不设上限（默认只有管理员不限）')}
        {opt('default', '用默认', fallback === null ? '跟着全站的默认值走' : `每天 ${fmtInt(fallback)} ${unit}，跟着全站默认走`)}
        <label className={`ad-q-opt is-custom${choice.mode === 'custom' ? ' on' : ''}`}>
          <input type="radio" name={name} value="custom" checked={choice.mode === 'custom'}
            onChange={() => { onChange({ mode: 'custom' }); setTimeout(() => inputRef.current?.focus(), 0) }} />
          <span className="ad-q-opt-text"><b>自定义</b><small>每天最多</small></span>
          <span className="ad-q-num">
            <input ref={inputRef} type="number" inputMode="numeric" min={1} max={100000} step={1}
              value={choice.value} placeholder={fallback === null ? '' : String(fallback)}
              aria-label={`${title}的自定义上限`} aria-invalid={error ? true : undefined}
              onFocus={() => { if (choice.mode !== 'custom') onChange({ mode: 'custom' }) }}
              onChange={e => onChange({ mode: 'custom', value: e.target.value })} />
            <span>{unit}</span>
          </span>
        </label>
      </div>
      {error ? <p className="ad-q-err" role="alert">{error}</p> : null}
    </fieldset>
  )
}

export default function QuotaSheet({ account, defaults = {}, onClose, onSaved, onExpired }) {
  const init = f => {
    const mode = quotaMode(account.quota, f, account)
    return { mode, value: mode === 'custom' ? String(account.quota[f]) : '' }
  }
  const [choice, setChoice] = useState(() => Object.fromEntries(QUOTA_FIELDS.map(f => [f, init(f)])))
  const [errors, setErrors] = useState({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const refs = { daily_model_calls: useRef(null), daily_flow_runs: useRef(null) }
  const used = { daily_model_calls: account.today?.calls || 0, daily_flow_runs: account.today?.flow_runs || 0 }

  const change = (f, patch) => {
    setChoice(c => ({ ...c, [f]: { ...c[f], ...patch } }))
    setErrors(e => (e[f] ? { ...e, [f]: '' } : e))
  }

  async function save(e) {
    e.preventDefault()
    if (busy) return
    const body = {}
    const bad = {}
    for (const f of QUOTA_FIELDS) {
      const v = quotaValue(choice[f])
      if (v === undefined) bad[f] = RANGE_HINT
      else body[f] = v
    }
    const first = QUOTA_FIELDS.find(f => bad[f])
    if (first) {
      setErrors(bad)
      refs[first].current?.focus()
      return
    }
    setBusy(true)
    setErr('')
    try {
      const quota = await saveQuota(account.user_id, body)
      onSaved(account, quota)
    } catch (ex) {
      if (ex.message === '401') { onExpired?.(); return }
      setErr(ex.message || '没保存上，请再试一次')
      setBusy(false)
    }
  }

  return (
    <Modal label="调整每日配额" onClose={onClose} size="sm" className="ad-quota" dismissOnBackdrop={!busy}>
      <ModalHead title="调整每日配额" subtitle={`${account.username}${account.platform ? ` · ${account.platform.name}` : ''}`} onClose={onClose} />
      <form className="jv-modal-body ad-q-body" onSubmit={save} noValidate>
        <p className="ad-q-lead">每天零点重新计数；用完了，这个账号当天的对话或流程会收到「明天再来，或请管理员调高」的提示。</p>
        {QUOTA_FIELDS.map(f => (
          <Field key={f} field={f} choice={choice[f]} onChange={patch => change(f, patch)} used={used[f]}
            fallback={Number.isFinite(defaults[f]) ? defaults[f] : null} error={errors[f]} inputRef={refs[f]} />
        ))}
        {err ? <p className="ad-q-err" role="alert">{err}</p> : null}
        <div className="ad-q-actions">
          <button type="button" className="jv-btn" onClick={onClose}>取消</button>
          <button type="submit" className="jv-btn jv-btn--primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</button>
        </div>
      </form>
    </Modal>
  )
}
