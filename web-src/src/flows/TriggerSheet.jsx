import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { createWebhook, deleteWebhook, getFlow, getHooks, setMessageHook } from './api.js'
import { absTime, absUrl, relTime, startFields } from './flowkit.js'
import ScheduleForm from './ScheduleForm.jsx'

/* 「触发方式」弹层（第二十轮，契约 §4.2 / §4.3）：流程卡片菜单打开，三个页签——
 *   定时：原来的定时运行设置（ScheduleForm）；
 *   收到消息时：飞书 / 微信收到的消息（全部，或含关键词）就跑这个流程，消息文字填进开始的某一项；渠道没绑好的灰显说明；
 *   通过链接：生成 / 重置 / 关掉一个专属地址；完整地址只在生成那一刻显示一次（醒目提示 + 复制 + 调用示例）。
 * 界面不出现 cron / 令牌这类说法。 */

export const TRIGGER_TABS = [
  { id: 'schedule', label: '定时', emoji: '⏰' },
  { id: 'message', label: '收到消息时', emoji: '💬' },
  { id: 'webhook', label: '通过链接', emoji: '🔗' },
]
export const MAX_KEYWORDS = 10
export const MAX_KEYWORD_LEN = 20
const CHANNELS = [
  { id: 'feishu', label: '飞书', hint: '在飞书里发给贾维斯的消息' },
  { id: 'wechat', label: '微信', hint: '在微信里发给贾维斯的消息' },
]

/** 卡片上的触发标记：{ message, webhook } 是否开着（接口给的 hooks 设置 → 两个布尔） */
export function hookFlags(hooks) {
  return { message: Boolean(hooks?.message?.enabled), webhook: Boolean(hooks?.webhook?.enabled) }
}

/** 消息能填进去的输入项：文字 / 长文（文件字段由消息里的附件填） */
const textFields = fields => fields.filter(f => f.type === 'text' || f.type === 'paragraph' || !f.type)

/** 关键词胶囊输入：回车 / 逗号添加，退格删最后一个，每个 ≤20 字、最多 10 个 */
export function KeywordInput({ value, onChange, disabled, labelledBy, describedBy }) {
  const [draft, setDraft] = useState('')
  const [warn, setWarn] = useState('')
  const inputRef = useRef(null)
  const full = value.length >= MAX_KEYWORDS
  function add(raw) {
    const parts = String(raw).split(/[,，、\n]/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) return
    const next = [...value]
    let note = ''
    for (const p of parts) {
      if (p.length > MAX_KEYWORD_LEN) { note = `每个关键词不超过 ${MAX_KEYWORD_LEN} 个字`; continue }
      if (next.includes(p)) continue
      if (next.length >= MAX_KEYWORDS) { note = `最多 ${MAX_KEYWORDS} 个关键词`; break }
      next.push(p)
    }
    setWarn(note)
    if (next.length !== value.length) onChange(next)
    setDraft('')
  }
  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); add(draft); return }
    if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
  }
  return (
    <div className={`fh-kw${disabled ? ' is-off' : ''}`} onClick={() => inputRef.current?.focus()}>
      <ul className="fh-kw-list" aria-label="已加的关键词">
        {value.map(k => (
          <li key={k} className="fh-kw-chip">
            <span>{k}</span>
            <button type="button" disabled={disabled} aria-label={`删掉关键词「${k}」`}
              onClick={e => { e.stopPropagation(); onChange(value.filter(x => x !== k)); setWarn('') }}>
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
        <li className="fh-kw-input">
          <input ref={inputRef} value={draft} disabled={disabled || full} maxLength={MAX_KEYWORD_LEN + 10}
            placeholder={full ? `已经 ${MAX_KEYWORDS} 个了` : value.length ? '再加一个，回车确认' : '比如：早报，回车确认'}
            aria-labelledby={labelledBy} aria-describedby={describedBy}
            onChange={e => { setDraft(e.target.value); if (warn) setWarn('') }} onKeyDown={onKeyDown}
            onBlur={() => { if (draft.trim()) add(draft) }}
            onPaste={e => {
              const text = e.clipboardData?.getData('text') || ''
              if (/[,，、\n]/.test(text)) { e.preventDefault(); add(draft + text) }
            }} />
        </li>
      </ul>
      {warn ? <p className="fh-kw-warn" role="status">{warn}</p> : null}
    </div>
  )
}

function initialMessage(message, fields) {
  const texts = textFields(fields)
  return {
    enabled: Boolean(message?.enabled) || !message,
    channels: Array.isArray(message?.channels) ? message.channels : null,
    match: message?.match === 'all' ? 'all' : 'keywords',
    keywords: Array.isArray(message?.keywords) ? message.keywords.map(String).slice(0, MAX_KEYWORDS) : [],
    input_field: message ? (message.input_field || '') : (texts[0]?.key || ''),
  }
}

/** 「收到消息时」 */
function MessageForm({ flow, hooks, fields, onBindFeishu, onClose, onSaved, onExpired }) {
  const channels = hooks.channels || {}
  const ready = id => Boolean(channels[id]?.ready)
  const [form, setForm] = useState(() => {
    const f = initialMessage(hooks.message, fields)
    // 没设过：默认勾上已经绑好的渠道
    return { ...f, channels: f.channels ?? CHANNELS.map(c => c.id).filter(ready) }
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const uid = useId()
  const set = patch => { setErr(''); setForm(f => ({ ...f, ...patch })) }
  const texts = textFields(fields)
  const files = fields.filter(f => f.type === 'file')
  const target = fields.find(f => f.key === form.input_field)
  // 必填、没有默认值、消息又填不进去的输入项：收到消息时没人填，流程跑不起来
  const unfillable = fields.filter(f => f.required && f.type !== 'file' && f.key !== form.input_field
    && (f.default === undefined || f.default === null || f.default === ''))
  const lastHit = hooks.message?.last_hit_at

  async function save(e) {
    e.preventDefault()
    if (saving) return
    const chosen = form.channels.filter(ready)
    if (form.enabled) {
      if (!chosen.length) { setErr('至少选一个能用的渠道'); return }
      if (form.match === 'keywords' && !form.keywords.length) { setErr('加至少一个关键词，或者改成「所有消息」'); return }
      if (unfillable.length) {
        setErr(`「${unfillable[0].label || '必填项'}」必须填，收到消息时没人填它：把消息填进这一项，或者在画布里把它改成选填`)
        return
      }
    }
    setSaving(true)
    try {
      const saved = await setMessageHook(flow.id, {
        enabled: form.enabled, channels: chosen, match: form.match,
        keywords: form.match === 'keywords' ? form.keywords : [], input_field: form.input_field || '',
      })
      onSaved({ ...hooks, message: saved })
    } catch (e2) {
      if (e2.message === '401') { onExpired?.(); return }
      setErr(e2.message || '没保存成功，请再试一次')
      setSaving(false)
    }
  }

  return (
    <form className="fh-sched-form fh-msg-form" onSubmit={save} noValidate>
      <div className="fh-switch-row">
        <span id={`${uid}-on`} className="fh-switch-label">
          <b>收到消息时自动运行</b>
          <span>飞书 / 微信里收到符合条件的消息，贾维斯就跑这个流程，把结果回给你</span>
        </span>
        <button type="button" role="switch" aria-checked={form.enabled} aria-labelledby={`${uid}-on`}
          className={`fh-switch${form.enabled ? ' is-on' : ''}`} onClick={() => set({ enabled: !form.enabled })}>
          <i aria-hidden="true" />
        </button>
      </div>

      <fieldset className="fh-fieldset" disabled={!form.enabled}>
        <legend className="fh-legend">哪里收到的消息</legend>
        {CHANNELS.map(c => {
          const ok = ready(c.id)
          const why = channels[c.id]?.reason || (c.id === 'feishu' ? '还没绑定飞书' : '微信还没接好')
          return (
            <div key={c.id} className={`fh-check${ok ? '' : ' is-off'}`}>
              <label className="fh-check-label">
                <input type="checkbox" checked={ok && form.channels.includes(c.id)} disabled={!ok}
                  aria-describedby={`${uid}-${c.id}`}
                  onChange={e => set({ channels: e.target.checked ? [...form.channels, c.id] : form.channels.filter(x => x !== c.id) })} />
                <span><b>{c.label}</b><span id={`${uid}-${c.id}`}>{ok ? c.hint : why}</span></span>
              </label>
              {!ok && c.id === 'feishu' && onBindFeishu ? (
                <button type="button" className="fh-link fh-check-go" onClick={onBindFeishu}>去绑定飞书<Icon name="chevron" size={13} /></button>
              ) : null}
            </div>
          )
        })}
        <p className="fh-field-note">群聊里只有 @贾维斯 的消息才算。</p>
      </fieldset>

      <fieldset className="fh-fieldset" disabled={!form.enabled}>
        <legend className="fh-legend" id={`${uid}-match`}>什么样的消息</legend>
        <div className="fh-seg" role="radiogroup" aria-labelledby={`${uid}-match`}>
          {[['keywords', '含关键词的'], ['all', '所有消息']].map(([v, l]) => (
            <label key={v} className={`fh-seg-item${form.match === v ? ' is-on' : ''}`}>
              <input type="radio" name={`${uid}-match`} value={v} checked={form.match === v} onChange={() => set({ match: v })} />
              {l}
            </label>
          ))}
        </div>
        {form.match === 'keywords' ? (
          <div className="fh-field">
            <span className="fh-field-label" id={`${uid}-kw`}>关键词</span>
            <KeywordInput value={form.keywords} onChange={keywords => set({ keywords })} disabled={!form.enabled}
              labelledBy={`${uid}-kw`} describedBy={`${uid}-kw-note`} />
            <p className="fh-field-note" id={`${uid}-kw-note`}>
              消息里含任意一个就跑（不分大小写）。最多 {MAX_KEYWORDS} 个，每个不超过 {MAX_KEYWORD_LEN} 字。
            </p>
          </div>
        ) : (
          <p className="fh-field-note">每条发给贾维斯的消息都会交给这个流程，不再当成聊天。每个渠道只能有一个流程收「所有消息」。</p>
        )}
      </fieldset>

      <fieldset className="fh-fieldset" disabled={!form.enabled}>
        <legend className="fh-legend">消息的文字填进哪一项</legend>
        {texts.length ? (
          <label className="fh-field" htmlFor={`${uid}-field`}>
            <span className="sr-only">消息的文字填进哪一项</span>
            <select id={`${uid}-field`} value={form.input_field} onChange={e => set({ input_field: e.target.value })}>
              <option value="">不填，消息只用来叫它跑</option>
              {texts.map(f => <option key={f.key} value={f.key}>{f.label || '没起名的输入项'}</option>)}
            </select>
          </label>
        ) : <p className="fh-field-note">开始节点没有文字输入项，消息内容不会传进流程。想用的话，在画布里给「开始」加一个文字输入。</p>}
        {target ? <p className="fh-field-note">比如收到「早报 北京」，「{target.label || '这一项'}」里就是这句话。</p> : null}
        {files.length ? <p className="fh-field-note">消息里带的文件会填进「{files[0].label || '文件'}」。</p> : null}
      </fieldset>

      <div className="fh-sheet-foot">
        {err ? <p className="fh-form-err" role="alert">{err}</p> : null}
        <div className="fh-sheet-foot-row">
          <div className="fh-next">
            <p>{lastHit ? <>上次触发：<b title={absTime(lastHit)}>{relTime(lastHit)}</b></> : form.enabled ? '保存后，下一条符合条件的消息就会触发' : '关掉后收到消息照常聊天'}</p>
          </div>
          <div className="fh-sheet-actions">
            <button type="button" className="jv-btn" onClick={onClose}>取消</button>
            <button type="submit" className="jv-btn jv-btn--primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
      </div>
    </form>
  )
}

/** 调用示例：每个文字输入项用它的名字；没有输入项发空内容 */
export function curlExample(url, fields) {
  const inputs = {}
  for (const f of fields) {
    if (f.type === 'file') continue
    inputs[f.key] = f.type === 'number' ? 1 : String(f.label || '内容')
  }
  const body = Object.keys(inputs).length ? JSON.stringify({ inputs }) : '{}'
  return `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${body.replace(/'/g, "'\\''")}'`
}

function CopyButton({ text, label = '复制', className = 'jv-btn jv-btn--sm' }) {
  const [done, setDone] = useState('')
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button type="button" className={className} onClick={async () => {
      setDone((await copyText(text)) ? '已复制' : '复制失败，请手动选中复制')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setDone(''), 2000)
    }}>
      <Icon name={done === '已复制' ? 'check' : 'copy'} size={14} />{done || label}
    </button>
  )
}

/** 「通过链接」：生成 / 重置 / 关掉；完整地址只在生成那一刻显示一次 */
function WebhookPanel({ flow, hooks, fields, onChange, onExpired }) {
  const [fresh, setFresh] = useState('')          // 刚生成的完整地址（只这一次）
  const [busy, setBusy] = useState('')            // create · delete
  const [confirm, setConfirm] = useState('')      // reset · off
  const [err, setErr] = useState('')
  const uid = useId()
  const hook = hooks.webhook
  const on = Boolean(hook?.enabled)
  const urlRef = useRef(null)
  // 刚生成：焦点落到地址上（读屏会念出来），地址开头留在眼前
  useEffect(() => {
    const el = urlRef.current
    if (!fresh || !el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange?.(0, 0)
    el.scrollLeft = 0
  }, [fresh])

  async function generate() {
    setBusy('create')
    setErr('')
    try {
      const res = await createWebhook(flow.id)
      const url = absUrl(res?.url || '')
      if (!url) throw new Error('地址没生成出来，请再试一次')
      setFresh(url)
      setConfirm('')
      onChange({ ...hooks, webhook: { ...(res?.webhook || {}), enabled: true } })
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setErr(e.message || '地址没生成出来，请再试一次')
    } finally {
      setBusy('')
    }
  }
  async function turnOff() {
    setBusy('delete')
    setErr('')
    try {
      await deleteWebhook(flow.id)
      setFresh('')
      setConfirm('')
      onChange({ ...hooks, webhook: hook ? { ...hook, enabled: false } : null })
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setErr(e.message || '没关掉，请再试一次')
    } finally {
      setBusy('')
    }
  }

  const keyed = fields.filter(f => f.type !== 'file')
  return (
    <div className="fh-hook">
      {!on && !fresh ? (
        <div className="fh-hook-intro">
          <p className="fh-hook-lead">给这个流程生成一个专属地址：表单、快捷指令、别的自动化工具往这个地址发一下，流程就会跑。</p>
          <button type="button" className="jv-btn jv-btn--primary" onClick={generate} disabled={!!busy}>
            <Icon name="plus" size={15} />{busy === 'create' ? '正在生成…' : '生成链接'}
          </button>
        </div>
      ) : null}

      {fresh ? (
        <section className="fh-hook-fresh" aria-labelledby={`${uid}-fresh`}>
          <p className="fh-hook-once" id={`${uid}-fresh`} role="alert">
            <span className="fh-hook-bang" aria-hidden="true">!</span><b>只显示这一次，请复制保存</b>
          </p>
          <p className="fh-field-note">关掉这个窗口就再也看不到完整地址了；忘了的话只能重置，换一个新的。</p>
          <div className="fh-hook-url">
            <input ref={urlRef} readOnly value={fresh} aria-label="链接触发的地址" onClick={e => e.currentTarget.select()} />
            <CopyButton text={fresh} label="复制地址" className="jv-btn jv-btn--sm jv-btn--primary" />
          </div>
        </section>
      ) : null}

      {on ? (
        <div className="fh-hook-status">
          <p><span className="status-dot online" aria-hidden="true" /><b>链接触发已开启</b></p>
          <p className="fh-field-note">
            {[hook?.created_at ? `生成于 ${absTime(hook.created_at)}` : '', hook?.last_hit_at ? `上次触发 ${relTime(hook.last_hit_at)}` : '还没被触发过'].filter(Boolean).join(' · ')}
          </p>
          {!fresh && hook?.url_hint ? <p className="fh-field-note">地址末尾是「{hook.url_hint}」，完整地址只在生成时显示过一次。</p> : null}
          {confirm ? (
            <div className="fh-hook-confirm" role="alertdialog" aria-labelledby={`${uid}-cf`}>
              <p id={`${uid}-cf`}>{confirm === 'reset' ? '重置后旧地址马上失效，用到它的地方都要换成新地址。' : '关掉后这个地址马上失效，再打开会是一个新地址。'}</p>
              <div className="fh-sheet-actions">
                <button type="button" className="jv-btn jv-btn--sm" onClick={() => setConfirm('')}>取消</button>
                {confirm === 'reset' ? (
                  <button type="button" className="jv-btn jv-btn--sm jv-btn--primary" onClick={generate} disabled={!!busy}>{busy ? '正在重置…' : '确认重置'}</button>
                ) : (
                  <button type="button" className="jv-btn jv-btn--sm jv-btn--danger" onClick={turnOff} disabled={!!busy}>{busy ? '正在关掉…' : '确认关掉'}</button>
                )}
              </div>
            </div>
          ) : (
            <div className="fh-hook-acts">
              <button type="button" className="jv-btn jv-btn--sm" onClick={() => setConfirm('reset')}>重置链接</button>
              <button type="button" className="jv-btn jv-btn--sm jv-btn--danger" onClick={() => setConfirm('off')}>关掉</button>
            </div>
          )}
        </div>
      ) : null}
      {err ? <p className="fh-form-err" role="alert">{err}</p> : null}

      {on || fresh ? (
        <section className="fh-hook-how" aria-labelledby={`${uid}-how`}>
          <h3 className="fh-legend" id={`${uid}-how`}>怎么用</h3>
          <p className="fh-field-note">用 POST 方式发到这个地址。要填的内容按下面的样子写，每一项用它的名字：</p>
          {keyed.length ? (
            <ul className="fh-hook-keys">
              {keyed.map(f => <li key={f.key}><span>「{f.label || '没起名的输入项'}」</span><code>{f.key}</code></li>)}
            </ul>
          ) : <p className="fh-field-note">这个流程运行时不用填东西，发空内容就行。</p>}
          <div className="fh-hook-code">
            <pre aria-label="调用示例">{curlExample(fresh || '这里换成你的地址', fields)}</pre>
            {fresh ? <CopyButton text={curlExample(fresh, fields)} label="复制示例" /> : null}
          </div>
          <ul className="fh-hook-rules">
            <li>最多等 30 秒：跑完了直接回结果；没跑完会先回「还在跑」（状态码 202），结果到运行记录里看。</li>
            <li>每个地址每分钟最多触发 30 次，超过会被拒绝（状态码 429），稍等再发。</li>
            <li>谁拿到地址都能触发这个流程，别贴到公开的地方；万一泄露了，点「重置链接」换一个。</li>
          </ul>
        </section>
      ) : null}
    </div>
  )
}

export default function TriggerSheet({
  flow, tab: initialTab = 'schedule', feishu = null, onBindFeishu, onOpenRuns, onClose, onScheduleSaved, onMessageSaved, onHooksChange, onExpired,
}) {
  const [tab, setTab] = useState(TRIGGER_TABS.some(t => t.id === initialTab) ? initialTab : 'schedule')
  const [hooks, setHooks] = useState({ status: 'loading' })
  const [graph, setGraph] = useState(flow.graph || null)
  const tabRefs = useRef({})
  const uid = useId()

  const loadHooks = useCallback(async () => {
    setHooks({ status: 'loading' })
    try {
      const [h, g] = await Promise.all([getHooks(flow.id), flow.graph ? flow.graph : getFlow(flow.id).then(f => f?.graph || null)])
      setGraph(g)
      setHooks({ status: 'ready', ...h })
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setHooks({ status: 'error', error: e.message || '触发设置没加载出来' })
    }
  }, [flow.id, flow.graph, onExpired])
  useEffect(() => { loadHooks() }, [loadHooks])

  const fields = startFields(graph)
  const flags = hooks.status === 'ready' ? hookFlags(hooks) : { message: false, webhook: false }
  const on = { schedule: Boolean(flow.trigger && flow.trigger.kind === 'schedule' && flow.trigger.enabled !== false), ...flags }
  function changeHooks(next) {
    setHooks(h => ({ ...h, ...next, status: 'ready' }))
    onHooksChange?.(next)
  }

  function onTabKey(e, i) {
    const keys = { ArrowRight: 1, ArrowLeft: -1 }
    let next = -1
    if (keys[e.key]) next = (i + keys[e.key] + TRIGGER_TABS.length) % TRIGGER_TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TRIGGER_TABS.length - 1
    if (next < 0) return
    e.preventDefault()
    setTab(TRIGGER_TABS[next].id)
    tabRefs.current[TRIGGER_TABS[next].id]?.focus()
  }

  const hooksBody = render => (hooks.status === 'loading' ? <p className="fh-muted" role="status">正在读取触发设置…</p>
    : hooks.status === 'error' ? (
      <div className="fh-inline-err" role="alert">
        <p>{hooks.error}</p>
        <button type="button" className="jv-btn jv-btn--sm" onClick={loadHooks}>重新加载</button>
      </div>
    ) : render())

  return (
    <Modal label="触发方式" onClose={onClose} size="md" className="fh-sched fh-trig" dismissOnBackdrop={false}>
      <ModalHead title="触发方式" subtitle={flow.name || '未命名流程'} onClose={onClose} />
      <div className="jv-modal-body">
        <div className="fh-tabs fh-trig-tabs" role="tablist" aria-label="触发方式">
          {TRIGGER_TABS.map((t, i) => (
            <button key={t.id} ref={el => { tabRefs.current[t.id] = el }} type="button" role="tab" id={`${uid}-${t.id}`}
              aria-selected={tab === t.id} aria-controls={`${uid}-panel`} tabIndex={tab === t.id ? 0 : -1}
              className={`fh-tab${tab === t.id ? ' is-on' : ''}`} onClick={() => setTab(t.id)} onKeyDown={e => onTabKey(e, i)}>
              <span aria-hidden="true">{t.emoji}</span>{t.label}
              {on[t.id] ? <i className="fh-trig-on" aria-label="（已开启）" role="img" /> : null}
            </button>
          ))}
        </div>
        <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-${tab}`} className="fh-trig-panel">
          {tab === 'schedule' ? (
            <ScheduleForm flow={flow} feishu={feishu} onBindFeishu={onBindFeishu} onOpenRuns={onOpenRuns}
              onClose={onClose} onSaved={onScheduleSaved} onExpired={onExpired} />
          ) : tab === 'message' ? hooksBody(() => (
            <MessageForm flow={flow} hooks={hooks} fields={fields} onBindFeishu={onBindFeishu} onClose={onClose}
              onSaved={next => { changeHooks(next); onMessageSaved?.(next) }} onExpired={onExpired} />
          )) : hooksBody(() => (
            <WebhookPanel flow={flow} hooks={hooks} fields={fields} onChange={changeHooks} onExpired={onExpired} />
          ))}
        </div>
      </div>
    </Modal>
  )
}
