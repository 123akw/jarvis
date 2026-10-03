import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { APP_PATH, flowHref, navigate } from '../routes.js'
import { TourButton, useTour } from '../tour/index.jsx'
import { composeFlow, deleteFlow, getFlow, getNodeCatalog, getTemplates, listFlows, saveFlow } from './api.js'
import Compose from './Compose.jsx'
import FlowCard, { triggerText } from './FlowCard.jsx'
import { blankDraft, catalogIndex, copyName, graphPlugins, pluginNeeds, writeDraft } from './flowkit.js'
import Preview from './Preview.jsx'
import RunsDrawer from './RunsDrawer.jsx'
import ScheduleSheet from './ScheduleSheet.jsx'
import Templates from './Templates.jsx'

/* 「我的流程」首页（/flows，契约 docs/proposals/2026-10-round18-flows.md §5.2）：
 *   页头（我的流程 + 新建流程 + 新手引导）→ 一句话生成 → 已保存的流程 → 模板库。
 *   模板 / 一句话生成 / 新建的草稿写进 sessionStorage['jvf-draft'] 再去 /flows/new，由画布读走。 */

const TEMPLATE_FALLBACK = '模板暂时没加载出来'

function openDraft(draft) {
  writeDraft(draft)
  navigate(flowHref('new'))
}

function ListSkeleton() {
  return (
    <ul className="fh-flow-grid" aria-hidden="true">
      {[0, 1, 2].map(i => <li key={i} className="fh-flow fh-skel-card"><div className="fh-flow-thumb" /><i /><i /></li>)}
    </ul>
  )
}

function EmptyList({ onCompose, onTemplates }) {
  return (
    <div className="fh-empty">
      <div className="fh-empty-art" aria-hidden="true"><i /><b /><i /><b /><i /></div>
      <div className="fh-empty-text">
        <p className="fh-empty-title">还没有流程</p>
        <p className="fh-muted">流程就是把几件事按顺序接起来自动跑：资料进来，结果自动送到你手上。用一句话说说想做什么，或者挑个模板改一改。</p>
        <div className="fh-empty-actions">
          <button type="button" className="jv-btn jv-btn--sm" onClick={onCompose}><Icon name="sparkles" size={15} />一句话生成</button>
          <button type="button" className="jv-btn jv-btn--sm" onClick={onTemplates}>看看模板</button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDelete({ flow, onCancel, onDone, onExpired }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function go() {
    setBusy(true)
    setErr('')
    try {
      await deleteFlow(flow.id)
      onDone(flow)
    } catch (e) {
      if (e.message === '401') { onExpired(); return }
      setErr(e.message || '没删掉，请再试一次')
      setBusy(false)
    }
  }
  const timer = triggerText(flow.trigger)
  return (
    <Modal label="删除流程" onClose={onCancel} size="sm" className="fh-confirm">
      <ModalHead title="删除这个流程？" subtitle={flow.name || '未命名流程'} onClose={onCancel} />
      <div className="jv-modal-body">
        <p className="fh-confirm-text">
          删除后流程和它的运行记录都看不到了{timer ? `，「${timer}」的定时运行也会一起取消` : ''}。删了就找不回来。
        </p>
        {err ? <p className="fh-form-err" role="alert">{err}</p> : null}
        <div className="fh-sheet-actions">
          <button type="button" className="jv-btn" onClick={onCancel} data-autofocus>取消</button>
          <button type="button" className="jv-btn jv-btn--danger" onClick={go} disabled={busy}>{busy ? '正在删除…' : '删除'}</button>
        </div>
      </div>
    </Modal>
  )
}

export default function Home({ onExpired }) {
  const [flows, setFlows] = useState(null)
  const [listErr, setListErr] = useState('')
  const [tpl, setTpl] = useState({ status: 'loading', categories: [], templates: [], error: '' })
  const [idx, setIdx] = useState(undefined)
  const [text, setText] = useState('')
  const [composeBusy, setComposeBusy] = useState(false)
  const [composeErr, setComposeErr] = useState('')
  const [preview, setPreview] = useState(null)
  const [runsFor, setRunsFor] = useState(null)
  const [schedFor, setSchedFor] = useState(null)
  const [delFor, setDelFor] = useState(null)
  const [toast, setToast] = useState(null)
  const abortRef = useRef(null)
  const toastTimer = useRef(0)
  const composeInput = useRef(null)
  const tplRef = useRef(null)

  // App 每次渲染都给新的 onExpired：放进 ref，避免把它当依赖反复加载
  const expiredRef = useRef(onExpired)
  expiredRef.current = onExpired
  const expired = useCallback(() => expiredRef.current?.(), [])

  useEffect(() => { document.title = '我的流程 · 贾维斯' }, [])
  useEffect(() => () => { abortRef.current?.abort(); clearTimeout(toastTimer.current) }, [])

  const say = useCallback(msg => {
    clearTimeout(toastTimer.current)
    setToast({ msg, key: Date.now() })
    toastTimer.current = setTimeout(() => setToast(null), 2800)
  }, [])

  const loadFlows = useCallback(async () => {
    setListErr('')
    try {
      setFlows(await listFlows())
    } catch (err) {
      if (err.message === '401') { expired(); return }
      setListErr(err.message || '流程没加载出来')
    }
  }, [expired])

  const loadTemplates = useCallback(async () => {
    setTpl(t => ({ ...t, status: 'loading', error: '' }))
    try {
      const data = await getTemplates()
      setTpl({
        status: 'ready', error: '',
        categories: Array.isArray(data?.categories) ? data.categories.filter(c => c && c.id) : [],
        templates: Array.isArray(data?.templates) ? data.templates.filter(t => t && t.id && t.graph) : [],
      })
    } catch (err) {
      if (err.message === '401') { expired(); return }
      setTpl({ status: 'error', categories: [], templates: [], error: err.message || TEMPLATE_FALLBACK })
    }
  }, [expired])

  useEffect(() => {
    loadFlows()
    loadTemplates()
    // 节点目录只用来补图标、插件名与「能不能用」，拿不到不影响页面
    getNodeCatalog().then(c => setIdx(catalogIndex(c))).catch(() => {})
  }, [loadFlows, loadTemplates])

  useTour('flows-home', { ready: (flows !== null || Boolean(listErr)) && tpl.status !== 'loading' })

  /* ---- 一句话生成 ---- */
  async function generate(desc, again = false) {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    if (again) setPreview(p => (p ? { ...p, busy: true, error: '' } : p))
    else { setComposeErr(''); setComposeBusy(true) }
    try {
      const res = await composeFlow(desc, ctrl.signal)
      if (ctrl.signal.aborted) return
      const draft = res?.draft
      if (!draft || !Array.isArray(draft.graph?.nodes) || !draft.graph.nodes.length) throw new Error('这次没搭出能用的流程')
      const notes = (Array.isArray(res.notes) ? res.notes : []).filter(Boolean)
      if (res.source === 'template') notes.unshift('没完全听懂你的意思，先找了最接近的模板，打开后可以再改')
      setPreview({ kind: 'compose', draft, notes, description: desc, busy: false, error: '' })
    } catch (err) {
      if (err?.name === 'AbortError' || ctrl.signal.aborted) return
      if (err.message === '401') { expired(); return }
      const reason = String(err.message || '服务暂时不可用').replace(/[。.！!]+$/, '')
      const msg = `没生成出来：${reason}。换个说法再试试，或者从下面的模板挑一个。`
      if (again) setPreview(p => (p ? { ...p, busy: false, error: msg } : p))
      else setComposeErr(msg)
    } finally {
      // 只有「这一次」还是当前请求时才收尾：被新一次生成或「取消」顶掉的，不去动别人的状态
      if (abortRef.current === ctrl) {
        abortRef.current = null
        if (!again) setComposeBusy(false)
      }
    }
  }
  function cancelCompose() {
    abortRef.current?.abort()
    abortRef.current = null
    setComposeBusy(false)
  }
  function closePreview() {
    if (preview?.busy) abortRef.current?.abort()
    setPreview(null)
  }

  /* ---- 列表操作 ---- */
  async function copy(flow) {
    say('正在复制…')
    try {
      const full = flow.graph ? flow : await getFlow(flow.id)
      const saved = await saveFlow({ name: copyName(flow.name), summary: full.summary || '', graph: full.graph })
      setFlows(list => [{ ...flow, ...saved, trigger: null, last_run: null, graph: saved?.graph || full.graph }, ...(list || [])])
      say(`已复制为「${saved?.name || copyName(flow.name)}」`)
    } catch (err) {
      if (err.message === '401') { expired(); return }
      say(err.message || '没复制成功，请再试一次')
    }
  }
  function onAction(id, flow) {
    if (id === 'runs') setRunsFor(flow)
    else if (id === 'schedule') setSchedFor(flow)
    else if (id === 'copy') copy(flow)
    else if (id === 'delete') setDelFor(flow)
  }
  function onScheduled(trigger) {
    const flow = schedFor
    setSchedFor(null)
    setFlows(list => (list || []).map(f => (f.id === flow.id ? { ...f, trigger } : f)))
    const label = triggerText(trigger)
    say(label ? `定时运行已保存：${label}` : '已关掉定时运行')
  }
  function onDeleted(flow) {
    setDelFor(null)
    setFlows(list => (list || []).filter(f => f.id !== flow.id))
    say(`已删除「${flow.name || '未命名流程'}」`)
  }

  function focusCompose() {
    composeInput.current?.focus()
    composeInput.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }
  function focusTemplates() {
    const el = tplRef.current
    el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    el?.querySelector('[role=tab][aria-selected=true], .fh-tpl')?.focus({ preventScroll: true })
  }

  const previewBlocked = graph => pluginNeeds(graphPlugins(graph), idx).filter(p => !p.available)

  return (
    <div className="fh-page">
      <header className="fh-top">
        <button type="button" className="fh-back" onClick={() => navigate(APP_PATH)} aria-label="返回对话">
          <Icon name="chevron" size={16} className="fh-flip" /><span>对话</span>
        </button>
        <TourButton tour="flows-home" className="fh-tour" />
      </header>

      <main className="fh-scroll">
        <div className="fh-wrap">
          <div className="fh-hero">
            <div className="fh-hero-text">
              <h1 className="fh-h1">我的流程</h1>
              <p className="fh-lead">把常做的事交给贾维斯：说一句话、挑个模板，或者自己拼节点。</p>
            </div>
            <button type="button" className="jv-btn jv-btn--primary fh-new" data-tour="flows-new"
              onClick={() => openDraft(blankDraft())}>
              <Icon name="plus" size={16} />新建流程
            </button>
          </div>

          <Compose value={text} onChange={v => { setText(v); if (composeErr) setComposeErr('') }}
            onSubmit={desc => generate(desc)} onCancel={cancelCompose}
            busy={composeBusy} error={composeErr} inputRef={composeInput} />

          <section className="fh-section" aria-labelledby="fh-list-title" data-tour="flows-list">
            <div className="fh-section-head">
              <h2 id="fh-list-title" className="fh-h2">
                已保存的流程{flows?.length ? <span className="fh-count">{flows.length}</span> : null}
              </h2>
            </div>
            {listErr ? (
              <div className="fh-inline-err" role="alert">
                <p>{listErr}</p>
                <button type="button" className="jv-btn jv-btn--sm" onClick={loadFlows}>重新加载</button>
              </div>
            ) : flows === null ? <ListSkeleton /> : !flows.length ? (
              <EmptyList onCompose={focusCompose} onTemplates={focusTemplates} />
            ) : (
              <ul className="fh-flow-grid">
                {flows.map(f => <FlowCard key={f.id} flow={f} idx={idx} onAction={onAction} />)}
              </ul>
            )}
          </section>

          <div ref={tplRef}>
            <Templates state={tpl} idx={idx} onRetry={loadTemplates}
              onPick={t => setPreview({ kind: 'template', tpl: t })} />
          </div>
        </div>
      </main>

      {toast ? <div key={toast.key} className="fh-toast" role="status" aria-live="polite">{toast.msg}</div> : null}

      {preview?.kind === 'compose' ? (
        <Preview label="生成的流程" title={preview.draft.name || '新流程'} subtitle={preview.draft.summary}
          graph={preview.draft.graph} idx={idx} quote={preview.description} notes={preview.notes}
          blocked={previewBlocked(preview.draft.graph)} busy={preview.busy} busyText="正在重新生成…" error={preview.error}
          primary="打开编辑" onPrimary={() => openDraft(preview.draft)}
          secondary="重新生成" onSecondary={() => generate(preview.description, true)} onClose={closePreview} />
      ) : preview?.kind === 'template' ? (
        <Preview label="模板预览" title={preview.tpl.name} subtitle={preview.tpl.summary} icon={preview.tpl.icon}
          graph={preview.tpl.graph} idx={idx} needs={(preview.tpl.needs || []).filter(Boolean)}
          blocked={pluginNeeds(preview.tpl.plugins?.length ? preview.tpl.plugins : graphPlugins(preview.tpl.graph), idx).filter(p => !p.available)}
          primary="用这个模板" onPrimary={() => openDraft({ name: preview.tpl.name, summary: preview.tpl.summary, graph: preview.tpl.graph })}
          onClose={closePreview} />
      ) : null}
      {runsFor ? <RunsDrawer flow={runsFor} onClose={() => setRunsFor(null)} onOpenFlow={f => navigate(flowHref(f.id))} onExpired={expired} /> : null}
      {schedFor ? <ScheduleSheet flow={schedFor} onClose={() => setSchedFor(null)} onSaved={onScheduled} onExpired={expired} /> : null}
      {delFor ? <ConfirmDelete flow={delFor} onCancel={() => setDelFor(null)} onDone={onDeleted} onExpired={expired} /> : null}
    </div>
  )
}
