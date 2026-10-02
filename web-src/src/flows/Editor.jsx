import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { createFlow, deleteFlow, listRuns, runFlow, updateFlow } from './api.js'
import Chain from './Chain.jsx'
import {
  abortRun, applyEvent, cancelRun, choiceList, groupByRole, insertIndex, insertStep, localId, makeStep, MAX_STEPS,
  moveStep, patchOptions, pickBlocker, removeStep, ROLE_LABEL, roleOf, runBlockers, startRun, unavailableReason, validate,
} from './model.js'
import { ResultCard, RunHistory, RunSheet } from './RunParts.jsx'
import { REDUCED, useMedia } from './useMedia.js'

const ROLE_HINT = { input: '资料从哪来', process: '怎么加工', output: '结果送到哪' }

/* ---------- 积木选择面板：按 输入 / 处理 / 输出 分组，加不了的灰显并说明原因 ---------- */
function Palette({ at, count, groups, blocker, onPick, onClose }) {
  const where = count === 0 ? '流程从「输入」开始：先选资料从哪来'
    : at === 0 ? '放在最前面' : at >= count ? '接在最后' : `插在第 ${at} 步和第 ${at + 1} 步之间`
  let first = true
  return (
    <Modal label="加一个积木" onClose={onClose} size="lg" className="fl-palette">
      <ModalHead title="加一个积木" subtitle={where} onClose={onClose} />
      <div className="jv-modal-body">
        {groups.map(g => (
          <section key={g.role} className="fl-pal-group" data-role={g.role} aria-labelledby={`fl-pal-${g.role}`}>
            <h3 className="fl-pal-title" id={`fl-pal-${g.role}`}>
              <i className="fl-role-dot" aria-hidden="true" />{g.label}<small>{ROLE_HINT[g.role]}</small>
            </h3>
            <ul className="fl-pal-list">
              {g.items.map(p => {
                const why = blocker(p)
                const off = !!why
                const auto = first && !off
                if (auto) first = false
                return (
                  <li key={p.id}>
                    <button type="button" className="fl-pal-item" aria-disabled={off || undefined}
                      aria-describedby={off ? `fl-why-${p.id}` : undefined} data-autofocus={auto || undefined}
                      onClick={() => { if (!off) onPick(p) }}>
                      <span className="fl-pal-icon" aria-hidden="true">{p.icon}</span>
                      <span className="fl-pal-text">
                        <b>{p.name}{p.tier === 'pro' ? <em className="fl-pro">专业版</em> : null}</b>
                        <span>{p.summary}</span>
                        {off ? <span className="fl-pal-why" id={`fl-why-${p.id}`}>{why}</span> : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  )
}

/* ---------- 单步配置：按 step.options 渲染 select / text / number ---------- */
function OptionField({ opt, value, disabled, onChange }) {
  const label = opt.label || opt.key
  if (opt.type === 'select') {
    return (
      <label className="fl-field">
        <span>{label}</span>
        <select value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
          {choiceList(opt).map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
    )
  }
  if (opt.type === 'number') {
    return (
      <label className="fl-field">
        <span>{label}</span>
        <input type="number" inputMode="numeric" value={value ?? ''} min={opt.min} max={opt.max} disabled={disabled}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      </label>
    )
  }
  const long = opt.key === 'instruction' || opt.multiline
  const max = opt.max_length || (long ? 200 : 40)
  return (
    <label className="fl-field">
      <span>{label}</span>
      {long
        ? <textarea rows={3} value={value ?? ''} maxLength={max} disabled={disabled} placeholder={opt.placeholder || ''}
          onChange={e => onChange(e.target.value)} />
        : <input type="text" value={value ?? ''} maxLength={max} disabled={disabled} placeholder={opt.placeholder || ''}
          onChange={e => onChange(e.target.value)} />}
    </label>
  )
}

function StepPanelBody({ step, plugin, index, count, locked, onChange, onMove, onRemove }) {
  const opts = plugin?.step?.options || []
  return (
    <>
      {plugin?.available === false ? <p className="fl-warn">现在用不了：{unavailableReason(plugin)}</p> : null}
      {!plugin ? <p className="fl-warn">这个积木已经下架了，删掉它再保存。</p> : null}
      {opts.length ? (
        <div className="fl-form">
          {opts.map(opt => (
            <OptionField key={opt.key} opt={opt} value={step.options?.[opt.key]} disabled={locked}
              onChange={v => onChange({ [opt.key]: v })} />
          ))}
        </div>
      ) : plugin ? <p className="fl-muted">这一步不用设置，直接用就行。</p> : null}
      <div className="fl-panel-actions">
        <button type="button" className="jv-btn jv-btn--sm" disabled={locked || index === 0} onClick={() => onMove(-1)}>
          <Icon name="chevron" size={14} className="fl-flip" />往前挪
        </button>
        <button type="button" className="jv-btn jv-btn--sm" disabled={locked || index >= count - 1} onClick={() => onMove(1)}>
          往后挪<Icon name="chevron" size={14} />
        </button>
        <button type="button" className="jv-btn jv-btn--sm jv-btn--danger" disabled={locked} onClick={onRemove}>
          <Icon name="trash" size={14} />删除这一步
        </button>
      </div>
    </>
  )
}

function StepPanel({ narrow, step, plugin, index, onClose, ...rest }) {
  const role = roleOf(plugin) || 'process'
  const title = plugin ? plugin.name : '已下架的积木'
  const sub = `第 ${index + 1} 步 · ${ROLE_LABEL[role]}${plugin?.summary ? ` · ${plugin.summary}` : ''}`
  if (narrow) {
    return (
      <Modal label={`第 ${index + 1} 步：${title}`} onClose={onClose} className="fl-sheet" >
        <ModalHead title={`${plugin?.icon || ''} ${title}`.trim()} subtitle={sub} onClose={onClose} />
        <div className="jv-modal-body fl-panel-body" data-role={role}>
          <StepPanelBody step={step} plugin={plugin} index={index} {...rest} />
        </div>
      </Modal>
    )
  }
  return (
    <section className="fl-panel" data-role={role} aria-label={`第 ${index + 1} 步设置：${title}`}>
      <header className="fl-panel-head">
        <span className="fl-panel-icon" aria-hidden="true">{plugin?.icon || '⌁'}</span>
        <div className="fl-panel-titles">
          <h3>{title}</h3>
          <p>{sub}</p>
        </div>
        <button type="button" className="jv-modal-close" onClick={onClose} aria-label="收起设置">
          <Icon name="close" size={15} />
        </button>
      </header>
      <StepPanelBody step={step} plugin={plugin} index={index} {...rest} />
    </section>
  )
}

/** 运行进度一句话（读屏播报 + 运行条） */
function progressText(run, steps, byId) {
  if (!run) return ''
  const i = run.cursor
  const name = i >= 0 ? byId[steps[i]?.plugin]?.name || '' : ''
  if (run.status === 'running') return i < 0 ? '准备中…' : `第 ${i + 1} / ${steps.length} 步「${name}」`
  if (run.status === 'ok') {
    if (run.output?.kind === 'file') return '运行完成，文件已生成'
    return run.output?.url ? '运行完成，结果网页已生成' : '运行完成'
  }
  if (run.status === 'cancelled') return '已取消运行'
  return `运行没跑通：${run.error}`
}

function announceFor(ev, run, steps, byId) {
  const i = run.order.indexOf(ev.step_id)
  const k = i >= 0 ? i : run.cursor
  const name = byId[steps[k]?.plugin]?.name || ''
  if (ev.type === 'step_start') return `第 ${k + 1} 步「${name}」开始`
  if (ev.type === 'step_done') return `第 ${k + 1} 步完成${ev.summary ? `：${ev.summary}` : ''}`
  if (ev.type === 'step_error') return `第 ${k + 1} 步没走通：${ev.message || ''}`
  return ''
}

/* ---------- 编辑器：名称、节点链、配置、保存、试运行、结果、历史 ---------- */
export default function Editor({ flow, plugins, narrow, onSaved, onDeleted, onRunDone, onExpired, onDirty, onBack }) {
  const { byId, list } = plugins
  const [name, setName] = useState(flow.name || '')
  const [steps, setSteps] = useState(() => (flow.steps || []).map(s => ({ id: s.id || localId(), plugin: s.plugin, options: { ...(s.options || {}) } })))
  const [flowId, setFlowId] = useState(flow.id || null)
  const [dirty, setDirty] = useState(!flow.id)
  const [selectedId, setSelectedId] = useState(null)
  const [paletteAt, setPaletteAt] = useState(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null)
  const [tried, setTried] = useState(false)
  const [run, setRun] = useState(null)
  const [sheet, setSheet] = useState(false)
  const [history, setHistory] = useState(null)
  const [announce, setAnnounce] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const abortRef = useRef(null)
  const noticeTimer = useRef(0)
  const reduced = useMedia(REDUCED)

  const problems = validate(name, steps, byId)
  const blockers = runBlockers(steps, byId)
  const running = run?.status === 'running'

  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])
  useEffect(() => () => { abortRef.current?.abort(); clearTimeout(noticeTimer.current) }, [])

  const fail = useCallback(err => {
    if (err?.message === '401') { onExpired?.(); return }
    setNotice({ kind: 'error', text: err?.message || '出了点问题，请再试一次' })
  }, [onExpired])

  function flash(text) {
    setNotice({ kind: 'ok', text })
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(n => (n?.kind === 'ok' ? null : n)), 2200)
  }

  const loadHistory = useCallback(async id => {
    try { setHistory(await listRuns(id, 5)) } catch (err) {
      if (err.message === '401') onExpired?.()
      else setHistory([])
    }
  }, [onExpired])
  useEffect(() => { if (flowId) loadHistory(flowId) }, [flowId, loadHistory])

  /** 改步骤：旧的运行状态作废（节点对不上了） */
  function edit(fn) {
    setSteps(fn)
    setDirty(true)
    setRun(null)
    setConfirmDel(false)
  }

  function insertAt(index) {
    if (running) return
    if (steps.length >= MAX_STEPS) { setNotice({ kind: 'error', text: `最多 ${MAX_STEPS} 步，先删掉一步再加` }); return }
    setPaletteAt(index)
  }

  function pick(plugin) {
    const step = makeStep(plugin)
    const at = insertIndex(plugin, paletteAt)
    edit(s => insertStep(s, at, step))
    setPaletteAt(null)
    setSelectedId(step.id)
    setAnnounce(at === 0 && paletteAt !== 0 ? `「${plugin.name}」是输入，放到了第一步` : `已加入「${plugin.name}」`)
  }

  async function save() {
    setTried(true)
    if (problems.length) { setNotice(null); return null }
    setSaving(true)
    setNotice(null)
    try {
      const saved = flowId ? await updateFlow(flowId, name.trim(), steps) : await createFlow(name.trim(), steps)
      if (!saved?.id) throw new Error('保存没成功，请再试一次')
      // 服务端回来的步骤带正式 id（运行事件按它对节点）；条数对不上就沿用本地的
      const next = Array.isArray(saved.steps) && saved.steps.length === steps.length
        ? saved.steps.map((s, i) => ({ id: s.id || steps[i].id, plugin: s.plugin, options: { ...(s.options || {}) } }))
        : steps
      const sel = steps.findIndex(s => s.id === selectedId)
      setSteps(next)
      if (sel >= 0) setSelectedId(next[sel].id)
      setFlowId(saved.id)
      if (saved.name) setName(saved.name)   // 空名字服务端会叫「未命名流程」
      setDirty(false)
      flash('已保存')
      onSaved?.({ ...saved, steps: next })
      return { ...saved, steps: next }
    } catch (err) {
      fail(err)
      return null
    } finally {
      setSaving(false)
    }
  }

  async function openRun() {
    setTried(true)
    if (problems.length || running) return
    if (blockers.length) { setNotice({ kind: 'error', text: `${blockers[0]}，先换掉它再运行` }); return }
    if (dirty || !flowId) { if (!(await save())) return }
    setSheet(true)
  }

  async function start(input) {
    setSheet(false)
    setNotice(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const startedAt = Date.now()
    let state = { ...startRun(steps), startedAt }
    setRun(state)
    setAnnounce('开始运行')
    try {
      for await (const ev of runFlow(flowId, input, ctrl.signal)) {
        if (ctrl.signal.aborted) break
        state = applyEvent(state, ev)
        setRun(state)
        const say = announceFor(ev, state, steps, byId)
        if (say) setAnnounce(say)
        if (ev.type === 'run_done') break
      }
      if (ctrl.signal.aborted) state = cancelRun(state)
      else if (state.status === 'running') state = abortRun(state, '连接断了，流程没跑完')
    } catch (err) {
      if (err.message === '401') { abortRef.current = null; onExpired?.(); return }
      state = ctrl.signal.aborted || err.name === 'AbortError' ? cancelRun(state) : abortRun(state, err.message || '流程没跑完')
    }
    if (abortRef.current === ctrl) abortRef.current = null
    state = { ...state, ms: Date.now() - startedAt }
    setRun(state)
    setAnnounce(progressText(state, steps, byId))
    onRunDone?.(flowId, {
      id: state.runId, status: state.status, finished_at: new Date().toISOString(), url: state.output?.url || null,
    })
    loadHistory(flowId)
  }

  function cancel() {
    abortRef.current?.abort()
    setRun(r => cancelRun(r))
  }

  async function remove() {
    if (!confirmDel) { setConfirmDel(true); return }
    if (!flowId) { onDeleted?.(null); return }
    try {
      await deleteFlow(flowId)
      onDeleted?.(flowId)
    } catch (err) { fail(err) }
  }

  const selIndex = steps.findIndex(s => s.id === selectedId)
  const sel = selIndex >= 0 ? steps[selIndex] : null
  const groups = groupByRole(list)
  const first = steps[0] ? byId[steps[0].plugin] : null
  const panelProps = sel ? {
    narrow, step: sel, plugin: byId[sel.plugin], index: selIndex, count: steps.length, locked: running,
    onChange: patch => { edit(s => patchOptions(s, sel.id, patch)) },
    onMove: d => { edit(s => moveStep(s, sel.id, d)); setAnnounce(d < 0 ? '已往前挪一步' : '已往后挪一步') },
    onRemove: () => { edit(s => removeStep(s, sel.id)); setSelectedId(null); setAnnounce('已删除这一步') },
    onClose: () => setSelectedId(null),
  } : null

  return (
    <div className="fl-editor" aria-busy={running || undefined}>
      <div className="fl-head">
        {onBack ? (
          <button type="button" className="fl-back fl-back--inline" onClick={onBack} aria-label="回到流程列表">
            <Icon name="chevron" size={16} className="fl-flip" />
          </button>
        ) : null}
        <input className="fl-name" value={name} maxLength={30} placeholder="给流程起个名字" aria-label="流程名称"
          disabled={running} onChange={e => { setName(e.target.value); setDirty(true) }} />
        {dirty ? <span className="fl-dirty">未保存</span> : null}
        <div className="fl-head-actions">
          <button type="button" className={`jv-btn jv-btn--sm${confirmDel ? ' jv-btn--danger' : ''} fl-del`}
            disabled={running} onClick={remove} onBlur={() => setConfirmDel(false)}
            aria-label={confirmDel ? '确认删除这个流程' : '删除流程'}>
            <Icon name="trash" size={15} />{confirmDel ? <span>确认删除</span> : null}
          </button>
          <button type="button" className="jv-btn jv-btn--sm" disabled={saving || running || (!dirty && !!flowId)} onClick={save}>
            {saving ? '保存中…' : dirty || !flowId ? '保存' : '已保存'}
          </button>
          {running ? (
            <button type="button" className="jv-btn jv-btn--sm fl-run-btn is-stop" onClick={cancel}>
              <Icon name="stop" size={14} />取消运行
            </button>
          ) : (
            <button type="button" className="jv-btn jv-btn--sm jv-btn--primary fl-run-btn" disabled={saving} onClick={openRun}>
              <span className="fl-run-tri" aria-hidden="true" />运行
            </button>
          )}
        </div>
      </div>

      {problems.length || blockers.length ? (
        <ul className={`fl-hints${tried ? ' is-loud' : ''}`} aria-label="还差这些">
          {[...problems, ...blockers].map(p => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
      {notice ? <p className={`fl-notice fl-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}

      <div className={`fl-stage${run ? ` is-${run.status}` : ''}`}>
        {run?.status === 'running' ? (
          <div className="fl-runbar" aria-hidden="true">
            <span className="fl-runbar-dot" />正在运行 · {progressText(run, steps, byId)}
          </div>
        ) : null}
        <div className="fl-canvas">
          <Chain steps={steps} byId={byId} run={run} selectedId={selectedId} editable={!running} reduced={reduced}
            onSelect={id => setSelectedId(cur => (cur === id ? null : id))} onInsert={insertAt} />
        </div>
      </div>

      <ResultCard run={run} steps={steps} byId={byId} onRetry={openRun} />
      {sel && !narrow ? <StepPanel {...panelProps} /> : null}
      {flowId ? <RunHistory runs={history} /> : null}

      {sel && narrow ? <StepPanel {...panelProps} /> : null}
      {paletteAt !== null ? (
        <Palette at={paletteAt} count={steps.length} groups={groups} blocker={p => pickBlocker(p, steps, byId)}
          onPick={pick} onClose={() => setPaletteAt(null)} />
      ) : null}
      {sheet ? (
        <RunSheet flowName={name} inputPlugin={first} inputStep={steps[0]} onCancel={() => setSheet(false)} onSubmit={start} />
      ) : null}
      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  )
}
