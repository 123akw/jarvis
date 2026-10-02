import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { navigate } from '../routes.js'
import { applyTheme, currentTheme } from '../theme.js'
import { getCatalog, getMyProfession, listFlows } from './api.js'
import Editor from './Editor.jsx'
import { localId, makeStep, relTime, ROLE_LABEL, roleOf, RUN_STATUS, stepPlugins, templateGroups } from './model.js'
import { NARROW, useMedia } from './useMedia.js'
import './flows.css'

/* 流程拼接（/flows）：输入 → 处理 → 输出 的一条链。
 *   桌面：左列流程列表，右侧编辑器 / 新建；手机：列表与编辑器分屏切换。
 * 契约见 docs/proposals/2026-10-round13-platform.md 4.3。 */

/** 步骤小图标串：图标之间一小段连线，角色色点在下 */
function IconChain({ steps, byId, label }) {
  return (
    <span className="fl-ichain" role="img" aria-label={label}>
      {steps.map((s, i) => {
        const p = byId[s.plugin]
        return (
          <span key={s.id || `${s.plugin}-${i}`} className="fl-ichain-item" data-role={roleOf(p) || 'process'}>
            {i ? <i className="fl-ichain-wire" aria-hidden="true" /> : null}
            <span className="fl-ichain-icon" aria-hidden="true">{p?.icon || '⌁'}</span>
          </span>
        )
      })}
    </span>
  )
}

function chainLabel(steps, byId) {
  return steps.map(s => byId[s.plugin]?.name || '已下架的积木').join(' → ')
}

function FlowItem({ flow, byId, active, onOpen }) {
  const last = flow.last_run
  const status = last ? (RUN_STATUS[last.status] || last.status) : ''
  return (
    <li>
      <button type="button" className={`fl-item${active ? ' is-active' : ''}`} aria-current={active ? 'true' : undefined}
        onClick={() => onOpen(flow)}>
        <span className="fl-item-name">{flow.name || '未命名流程'}</span>
        <IconChain steps={flow.steps || []} byId={byId} label={chainLabel(flow.steps || [], byId)} />
        <span className="fl-item-meta">
          {last ? (
            <>
              <span className={`status-dot ${last.status === 'ok' ? 'online' : last.status === 'error' ? 'error' : ''}`} aria-hidden="true" />
              上次运行{status} · {relTime(last.finished_at) || '刚刚'}
            </>
          ) : <>还没运行过</>}
        </span>
      </button>
    </li>
  )
}

function TemplateCard({ tpl, byId, onPick }) {
  const steps = tpl.steps || []
  return (
    <button type="button" className="fl-tpl" onClick={() => onPick(tpl)}>
      <span className="fl-tpl-name">{tpl.name}</span>
      {tpl.summary ? <span className="fl-tpl-sum">{tpl.summary}</span> : null}
      <IconChain steps={steps} byId={byId} label={chainLabel(steps, byId)} />
      <span className="fl-tpl-roles" aria-hidden="true">
        {steps.map((s, i) => <i key={i} data-role={roleOf(byId[s.plugin]) || 'process'} />)}
      </span>
    </button>
  )
}

/** 新建：从模板（当前职业的排前面）或空白开始 */
function NewFlow({ catalog, byId, profession, onTemplate, onBlank }) {
  const groups = templateGroups(catalog, profession)
  return (
    <div className="fl-new">
      <header className="fl-new-head">
        <h2>新建流程</h2>
        <p>流程就是「{ROLE_LABEL.input} → {ROLE_LABEL.process} → {ROLE_LABEL.output}」：挑个模板改一改最快，也可以从空白拼起。</p>
      </header>
      <button type="button" className="fl-blank" onClick={onBlank}>
        <span className="fl-blank-plus" aria-hidden="true"><Icon name="plus" size={18} /></span>
        <span><b>空白开始</b><span>自己一块一块拼</span></span>
      </button>
      {groups.map(g => (
        <section key={g.id} className={`fl-tpl-group${g.mine ? ' is-mine' : ''}`} aria-label={g.mine ? `为你推荐：${g.name}` : g.name}>
          <h3 className="fl-sub">{g.mine ? <>为你推荐 · {g.icon} {g.name}</> : <>{g.icon} {g.name}</>}</h3>
          <div className="fl-tpl-grid">
            {g.flows.map(t => <TemplateCard key={`${g.id}-${t.id}`} tpl={t} byId={byId} onPick={onTemplate} />)}
          </div>
        </section>
      ))}
      {!groups.length ? <p className="fl-muted">暂时没有模板，从空白开始吧。</p> : null}
    </div>
  )
}

export default function Flows({ session, onExpired }) {
  const [catalog, setCatalog] = useState(null)
  const [flows, setFlows] = useState(null)
  const [profession, setProfession] = useState(session?.platform?.profession || null)
  const [loadErr, setLoadErr] = useState('')
  const [current, setCurrent] = useState(null)   // {key, id, flow}：正在编辑的流程（新建的草稿 id 为 null）
  const [pane, setPane] = useState('list')       // list · new · editor（手机按它切屏；桌面列表常驻）
  const dirtyRef = useRef(false)
  const narrow = useMedia(NARROW)
  const plugins = useMemo(() => stepPlugins(catalog), [catalog])

  // 流程页不挂 Hud，主题自己套；读不到存储（隐私模式）按暗色
  useEffect(() => {
    let theme = 'dark'
    try { theme = currentTheme() } catch { /* 存储不可用 */ }
    applyTheme(theme)
  }, [])
  useEffect(() => { document.title = '我的流程 · 贾维斯' }, [])

  // App 每次渲染都给新的 onExpired，放进 ref：不让它触发重新加载（会把正在编辑的流程冲掉）
  const expiredRef = useRef(onExpired)
  expiredRef.current = onExpired
  const expired = useCallback(() => expiredRef.current?.(), [])
  const knownProfession = session?.platform?.profession || null

  const load = useCallback(async () => {
    setLoadErr('')
    try {
      const [cat, list, prof] = await Promise.all([getCatalog(), listFlows(), knownProfession ? null : getMyProfession()])
      setCatalog(cat)
      setFlows(list)
      if (prof) setProfession(prof)
      // 桌面上直接打开最近一个流程；没有流程就停在「新建」
      if (!window.matchMedia?.(NARROW).matches) {
        if (list.length) { setCurrent({ key: list[0].id, id: list[0].id, flow: list[0] }); setPane('editor') }
        else setPane('new')
      }
    } catch (err) {
      if (err.message === '401') { expired(); return }
      setLoadErr(err.message || '加载失败')
    }
  }, [knownProfession, expired])
  useEffect(() => { load() }, [load])

  function leaveOk() {
    if (!dirtyRef.current) return true
    return window.confirm('改动还没保存，确定离开吗？')
  }
  function open(flow) {
    if (current?.id === flow.id && pane === 'editor') return
    if (!leaveOk()) return
    dirtyRef.current = false
    setCurrent({ key: flow.id, id: flow.id, flow })
    setPane('editor')
  }
  function startDraft(name, steps) {
    if (!leaveOk()) return
    dirtyRef.current = false
    const key = `draft-${localId()}`
    setCurrent({ key, id: null, flow: { id: null, name, steps } })
    setPane('editor')
  }
  function fromTemplate(tpl) {
    const steps = (tpl.steps || []).map(s => (plugins.byId[s.plugin]
      ? makeStep(plugins.byId[s.plugin], s.options)
      : { id: localId(), plugin: s.plugin, options: { ...(s.options || {}) } }))
    startDraft(tpl.name || '新流程', steps)
  }
  function openNew() {
    if (!leaveOk()) return
    dirtyRef.current = false
    setCurrent(null)
    setPane('new')
  }
  function backToList() {
    if (!leaveOk()) return
    dirtyRef.current = false
    setCurrent(null)
    setPane('list')
  }
  function toChat() {
    if (!leaveOk()) return
    navigate('/')
  }

  const onSaved = useCallback(saved => {
    setFlows(list => {
      const rest = (list || []).filter(f => f.id !== saved.id)
      const prev = (list || []).find(f => f.id === saved.id)
      return [{ ...prev, ...saved, last_run: saved.last_run ?? prev?.last_run ?? null }, ...rest]
    })
    setCurrent(c => (c ? { ...c, id: saved.id } : c))
  }, [])
  const onDeleted = useCallback(id => {
    dirtyRef.current = false
    setFlows(list => (list || []).filter(f => f.id !== id))
    setCurrent(null)
    setPane(window.matchMedia?.(NARROW).matches ? 'list' : 'new')
  }, [])
  const onRunDone = useCallback((id, lastRun) => {
    setFlows(list => (list || []).map(f => (f.id === id ? { ...f, last_run: lastRun } : f)))
  }, [])
  const onDirty = useCallback(d => { dirtyRef.current = d }, [])

  const ready = catalog && flows
  const showNew = pane === 'new' || (!narrow && pane !== 'editor')
  return (
    <div className="fl-page" data-pane={pane}>
      <header className="fl-top">
        <div className="fl-top-l">
          <button type="button" className="fl-back" onClick={toChat} aria-label="返回对话">
            <Icon name="chevron" size={16} className="fl-flip" /><span>对话</span>
          </button>
        </div>
        <h1 className="fl-top-title">我的流程</h1>
        <div className="fl-top-r">
          <button type="button" className="jv-btn jv-btn--sm fl-new-btn" onClick={openNew} disabled={!ready}>
            <Icon name="plus" size={15} />新建流程
          </button>
        </div>
      </header>

      {loadErr ? (
        <div className="fl-error">
          <p>{loadErr}</p>
          <button type="button" className="jv-btn jv-btn--sm" onClick={load}>重新加载</button>
        </div>
      ) : !ready ? (
        <div className="fl-loading" role="status">正在加载积木…</div>
      ) : (
        <div className="fl-body">
          <aside className="fl-side" aria-label="流程列表">
            <h2 className="fl-side-title">流程<span className="mono">{flows.length || ''}</span></h2>
            {flows.length ? (
              <ul className="fl-list">
                {flows.map(f => (
                  <FlowItem key={f.id} flow={f} byId={plugins.byId} active={pane === 'editor' && current?.id === f.id} onOpen={open} />
                ))}
              </ul>
            ) : (
              <div className="fl-empty">
                <p className="fl-empty-title">还没有流程</p>
                <p className="fl-muted">把几个小功能接成一条线：资料进来，结果自动出去。</p>
                <button type="button" className="jv-btn jv-btn--primary fl-empty-cta" onClick={openNew}>
                  <Icon name="plus" size={15} />新建第一个流程
                </button>
              </div>
            )}
          </aside>
          <main className="fl-main">
            {pane === 'editor' && current ? (
              <Editor key={current.key} flow={current.flow} plugins={plugins} narrow={narrow}
                onSaved={onSaved} onDeleted={onDeleted} onRunDone={onRunDone} onExpired={expired} onDirty={onDirty}
                onBack={narrow ? backToList : null} />
            ) : showNew ? (
              <>
                {narrow ? (
                  <button type="button" className="fl-back fl-back--row" onClick={backToList}>
                    <Icon name="chevron" size={16} className="fl-flip" />流程列表
                  </button>
                ) : null}
                <NewFlow catalog={catalog} byId={plugins.byId} profession={profession}
                  onTemplate={fromTemplate} onBlank={() => startDraft('新流程', [])} />
              </>
            ) : null}
          </main>
        </div>
      )}
    </div>
  )
}
