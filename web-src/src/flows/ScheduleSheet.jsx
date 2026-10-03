import { useEffect, useMemo, useState } from 'react'
import Modal, { ModalHead } from '../Modal.jsx'
import { getFeishuStatus, getFlow, getTrigger, setTrigger } from './api.js'
import { nextRun, REPEATS, scheduleLabel, startFields, validTime, WEEKDAYS, whenLabel } from './flowkit.js'

/* 定时运行弹层（契约 §3.4 trigger）：开关、重复（每天 / 工作日 / 每周几）、时间、预填输入（按开始节点字段）、
 * 通知渠道（飞书没绑定灰显说明）、「下次运行：明天 08:00」。保存调 setTrigger。 */

const todayIso = () => ((new Date().getDay() + 6) % 7) + 1

function initialForm(trigger, fields, feishu) {
  const s = trigger?.schedule || {}
  const inputs = {}
  for (const f of fields) {
    if (f.type === 'file') continue
    const v = trigger?.inputs?.[f.key] ?? f.default ?? (f.type === 'select' ? (f.options?.[0] ?? '') : '')
    inputs[f.key] = v === null || v === undefined ? '' : String(typeof v === 'object' ? (v.value ?? v.label ?? '') : v)
  }
  return {
    enabled: trigger ? trigger.kind === 'schedule' && trigger.enabled !== false : true,
    repeat: REPEATS.some(r => r.id === s.repeat) ? s.repeat : 'daily',
    time: validTime(s.time) ? s.time : '08:00',
    weekday: Number(s.weekday) >= 1 && Number(s.weekday) <= 7 ? Number(s.weekday) : todayIso(),
    inputs,
    notify: {
      feishu: feishu.bound ? (trigger?.notify ? Boolean(trigger.notify.feishu) : true) : false,
      desktop: trigger?.notify ? Boolean(trigger.notify.desktop) : true,
    },
  }
}

const optionList = f => (Array.isArray(f.options) ? f.options : []).map(o => (o && typeof o === 'object')
  ? { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? '') }
  : { value: String(o), label: String(o) })

function InputField({ field, value, onChange, disabled }) {
  const id = `fh-in-${field.key}`
  const label = field.label || '要填的内容'
  if (field.type === 'file') {
    return (
      <div className="fh-field is-off">
        <span className="fh-field-label">{label}</span>
        <p className="fh-field-note">这一项要上传文件，定时运行不支持上传文件，到时会空着。想定时跑的话，可以在画布里把它改成文字。</p>
      </div>
    )
  }
  const common = { id, value, disabled, onChange: e => onChange(e.target.value), required: field.required || undefined }
  return (
    <label className="fh-field" htmlFor={id}>
      <span className="fh-field-label">{label}{field.required ? <em aria-hidden="true">必填</em> : null}</span>
      {field.type === 'paragraph' ? (
        <textarea rows={3} maxLength={4000} placeholder={field.placeholder || ''} {...common} />
      ) : field.type === 'select' ? (
        <select {...common}>
          {!field.required ? <option value="">不选</option> : null}
          {optionList(field).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input type={field.type === 'number' ? 'number' : 'text'} inputMode={field.type === 'number' ? 'decimal' : undefined}
          maxLength={field.type === 'number' ? undefined : 500} placeholder={field.placeholder || ''} {...common} />
      )}
    </label>
  )
}

export default function ScheduleSheet({ flow, onClose, onSaved, onExpired }) {
  const [state, setState] = useState({ status: 'loading' })   // loading · ready · error
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [trigger, feishu, graph] = await Promise.all([
          getTrigger(flow.id),
          getFeishuStatus(),
          flow.graph ? flow.graph : getFlow(flow.id).then(f => f?.graph || null),
        ])
        if (!alive) return
        const fields = startFields(graph)
        setForm(initialForm(trigger, fields, feishu))
        setState({ status: 'ready', fields, feishu })
      } catch (e) {
        if (!alive) return
        if (e.message === '401') { onExpired?.(); return }
        setState({ status: 'error', error: e.message || '定时设置没加载出来' })
      }
    })()
    return () => { alive = false }
  }, [flow.id, flow.graph, onExpired])

  const schedule = form ? { repeat: form.repeat, time: form.time, ...(form.repeat === 'weekly' ? { weekday: form.weekday } : {}) } : null
  const next = useMemo(() => (schedule ? nextRun(schedule) : null), [schedule?.repeat, schedule?.time, schedule?.weekday]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = patch => { setErr(''); setForm(f => ({ ...f, ...patch })) }

  async function save(e) {
    e.preventDefault()
    if (!form || saving) return
    if (form.enabled) {
      if (!validTime(form.time)) { setErr('时间没填好，按「08:00」这样填'); return }
      const missing = state.fields.find(f => f.type !== 'file' && f.required && !String(form.inputs[f.key] ?? '').trim())
      if (missing) { setErr(`「${missing.label || '必填项'}」要先填上：定时运行的时候没人来填`); return }
    }
    const inputs = {}
    for (const f of state.fields) {
      if (f.type === 'file') continue
      const v = String(form.inputs[f.key] ?? '').trim()
      if (!v) continue
      inputs[f.key] = f.type === 'number' && Number.isFinite(Number(v)) ? Number(v) : v
    }
    setSaving(true)
    setErr('')
    try {
      const saved = await setTrigger(flow.id, {
        kind: form.enabled ? 'schedule' : 'manual',
        enabled: form.enabled,
        schedule,
        inputs,
        notify: { feishu: state.feishu.bound && form.notify.feishu, desktop: form.notify.desktop },
      })
      onSaved({ ...(saved || {}), kind: saved?.kind || (form.enabled ? 'schedule' : 'manual'), enabled: saved?.enabled ?? form.enabled,
        schedule: saved?.schedule || schedule, label: saved?.label || scheduleLabel(schedule) })
    } catch (e2) {
      if (e2.message === '401') { onExpired?.(); return }
      setErr(e2.message || '没保存成功，请再试一次')
      setSaving(false)
    }
  }

  const feishu = state.feishu || { bound: false, configured: true }
  const feishuWhy = !feishu.configured ? '这台服务器还没接入飞书' : '还没绑定飞书，到「设置 → 飞书」绑定后就能用'
  return (
    <Modal label="定时运行" onClose={onClose} size="md" className="fh-sched" dismissOnBackdrop={false}>
      <ModalHead title="定时运行" subtitle={flow.name || '未命名流程'} onClose={onClose} />
      {state.status === 'loading' ? (
        <div className="jv-modal-body"><p className="fh-muted" role="status">正在读取定时设置…</p></div>
      ) : state.status === 'error' ? (
        <div className="jv-modal-body"><p className="fh-form-err" role="alert">{state.error}</p></div>
      ) : (
        <form className="jv-modal-body fh-sched-form" onSubmit={save} noValidate>
          <div className="fh-switch-row">
            <span id="fh-sched-on" className="fh-switch-label">
              <b>按时自动运行</b>
              <span>到点贾维斯自己跑一遍，不用开着网页</span>
            </span>
            <button type="button" role="switch" aria-checked={form.enabled} aria-labelledby="fh-sched-on" data-autofocus
              className={`fh-switch${form.enabled ? ' is-on' : ''}`} onClick={() => set({ enabled: !form.enabled })}>
              <i aria-hidden="true" />
            </button>
          </div>

          <fieldset className="fh-fieldset" disabled={!form.enabled}>
            <legend className="fh-legend">什么时候</legend>
            <div className="fh-seg" role="radiogroup" aria-label="重复">
              {REPEATS.map(r => (
                <label key={r.id} className={`fh-seg-item${form.repeat === r.id ? ' is-on' : ''}`}>
                  <input type="radio" name="fh-repeat" value={r.id} checked={form.repeat === r.id} onChange={() => set({ repeat: r.id })} />
                  {r.label}
                </label>
              ))}
            </div>
            {form.repeat === 'weekly' ? (
              <div className="fh-days" role="radiogroup" aria-label="每周几">
                {WEEKDAYS.map((d, i) => (
                  <label key={d} className={`fh-day${form.weekday === i + 1 ? ' is-on' : ''}`}>
                    <input type="radio" name="fh-weekday" value={i + 1} checked={form.weekday === i + 1}
                      onChange={() => set({ weekday: i + 1 })} aria-label={`周${d}`} />
                    <span aria-hidden="true">{d}</span>
                  </label>
                ))}
              </div>
            ) : null}
            <label className="fh-field fh-time">
              <span className="fh-field-label">时间</span>
              <input type="time" step={60} value={form.time} onChange={e => set({ time: e.target.value })} required />
            </label>
          </fieldset>

          {state.fields.length ? (
            <fieldset className="fh-fieldset" disabled={!form.enabled}>
              <legend className="fh-legend">每次运行时填好的内容</legend>
              {state.fields.map(f => (
                <InputField key={f.key} field={f} value={form.inputs[f.key] ?? ''}
                  onChange={v => set({ inputs: { ...form.inputs, [f.key]: v } })} />
              ))}
            </fieldset>
          ) : null}

          <fieldset className="fh-fieldset" disabled={!form.enabled}>
            <legend className="fh-legend">跑完通知我</legend>
            <label className={`fh-check${feishu.bound ? '' : ' is-off'}`}>
              <input type="checkbox" checked={feishu.bound && form.notify.feishu} disabled={!feishu.bound}
                onChange={e => set({ notify: { ...form.notify, feishu: e.target.checked } })}
                aria-describedby={feishu.bound ? undefined : 'fh-feishu-why'} />
              <span><b>飞书</b>{feishu.bound ? <span>结果发到你的飞书</span> : <span id="fh-feishu-why">{feishuWhy}</span>}</span>
            </label>
            <label className="fh-check">
              <input type="checkbox" checked={form.notify.desktop}
                onChange={e => set({ notify: { ...form.notify, desktop: e.target.checked } })} />
              <span><b>桌面通知</b><span>装了贾维斯桌面端的电脑会弹出提醒</span></span>
            </label>
            {form.enabled && !form.notify.desktop && !(feishu.bound && form.notify.feishu) ? (
              <p className="fh-field-note">都不选的话，结果只在运行记录里能看到。</p>
            ) : null}
          </fieldset>

          <div className="fh-sheet-foot">
            {err ? <p className="fh-form-err" role="alert">{err}</p> : null}
            <div className="fh-sheet-foot-row">
              <p className="fh-next" aria-live="polite">
                {form.enabled ? (next ? <>下次运行：<b>{whenLabel(next)}</b></> : '时间没填好，按「08:00」这样填') : '关掉后不会自动运行，随时可以打开流程手动运行'}
              </p>
              <div className="fh-sheet-actions">
                <button type="button" className="jv-btn" onClick={onClose}>取消</button>
                <button type="submit" className="jv-btn jv-btn--primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
              </div>
            </div>
          </div>
        </form>
      )}
    </Modal>
  )
}
