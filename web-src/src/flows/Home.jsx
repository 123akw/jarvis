import { useCallback, useEffect, useRef, useState } from 'react'
import FeishuConnect from '../FeishuConnect.jsx'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { APP_PATH, flowHref, navigate } from '../routes.js'
import { TourButton, useTour } from '../tour/index.jsx'
import { composeFlow, deleteFlow, getFeishuStatus, getFlow, getNodeCatalog, getTemplates, listFlows, saveFlow } from './api.js'
import Compose from './Compose.jsx'
import FlowCard, { triggerText } from './FlowCard.jsx'
import { blankDraft, catalogIndex, copyName, requirements, writeDraft } from './flowkit.js'
import Preview from './Preview.jsx'
import RunsDrawer from './RunsDrawer.jsx'
import ScheduleSheet from './ScheduleSheet.jsx'
import Templates from './Templates.jsx'

/* 「我的流程」首页（/flows，契约 docs/proposals/2026-10-round18-flows.md §5.2；版式参考 Langflow 欢迎页）：
 *   新用户：页头 →「你想自动化什么？」大输入框 +「试试这些」→ 从模板开始（3 张精选 + 全部模板）→ 已保存的流程（空）。
 *   已有流程：页头 → 单行输入框 → 已保存的流程 → 从模板开始。
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

function EmptyList() {
  return (
    <div className="fh-empty">
      <div className="fh-empty-art" aria-hidden="true"><i /><b /><i /><b /><i /></div>
      <div className="fh-empty-text">
        <p className="fh-empty-title">还没有流程</p>
        <p className="fh-muted">做好的流程会放在这里：能直接运行、看每次的运行记录，也能设成每天自动跑。</p>
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
  const [feishu, setFeishu] = useState(null)
  const [text, setText] = useState('')
  const [composeBusy, setComposeBusy] = useState(false)
  const [composeErr, setComposeErr] = useState('')
  const [preview, setPreview] = useState(null)
  const [runsFor, setRunsFor] = useState(null)
  const [schedFor, setSchedFor] = useState(null)
  const [delFor, setDelFor] = useState(null)
  const [bindOpen, setBindOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const abortRef = useRef(null)
  const toastTimer = useRef(0)
  const composeInput = useRef(null)

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
    // 节点目录与飞书绑定只用来补图标、插件名、「需要准备」满没满足；拿不到不影响页面
    getNodeCatalog().then(c => setIdx(catalogIndex(c))).catch(() => {})
    getFeishuStatus().then(setFeishu).catch(() => {})
  }, [loadFlows, loadTemplates])

  useTour('flows-home', { ready: (flows !== null || Boolean(listErr)) && tpl.status !== 'loading' })

  /* ---- 一句话生成 ---- */
  async function generate(desc) {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setComposeErr('')
    setComposeBusy(true)
    try {
      const res = await composeFlow(desc, ctrl.signal)
      if (ctrl.signal.aborted) return
      const draft = res?.draft
      if (!draft || !Array.isArray(draft.graph?.nodes) || !draft.graph.nodes.length) throw new Error('这次没搭出能用的流程')
      const notes = (Array.isArray(res.notes) ? res.notes : []).filter(Boolean).slice(0, 3)
      if (res.source === 'template') notes.unshift('没完全理解你的意思，先按最接近的模板给你，打开后可以再改')
      setPreview({ kind: 'compose', draft, notes, description: desc })
    } catch (err) {
      if (err?.name === 'AbortError' || ctrl.signal.aborted) return
      if (err.message === '401') { expired(); return }
      const reason = String(err.message || '服务暂时不可用').replace(/[。.！!]+$/, '')
      setComposeErr(`这次没想明白：${reason}。换个说法试试，或者从模板开始。`)
    } finally {
      // 只有「这一次」还是当前请求时才收尾：被新一次生成或「取消」顶掉的，不去动别人的状态
      if (abortRef.current === ctrl) {
        abortRef.current = null
        setComposeBusy(false)
      }
    }
  }
  function cancelCompose() {
    abortRef.current?.abort()
    abortRef.current = null
    setComposeBusy(false)
  }
  /** 「换个说法」：关掉预览，回到输入框，原文还在并选中，直接改 */
  function rephrase() {
    setPreview(null)
    requestAnimationFrame(() => {
      const el = composeInput.current
      if (!el) return
      el.focus()
      el.select?.()
      el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    })
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
  function onReqAction(action) {
    if (action === 'feishu') setBindOpen(true)
  }

  const returning = Array.isArray(flows) && flows.length > 0
  const compose = (
    <Compose value={text} onChange={v => { setText(v); if (composeErr) setComposeErr('') }}
      onSubmit={desc => generate(desc)} onCancel={cancelCompose} compact={returning} idx={idx}
      busy={composeBusy} error={composeErr} inputRef={composeInput} />
  )
  const list = (
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
      ) : flows === null ? <ListSkeleton /> : !flows.length ? <EmptyList /> : (
        <ul className="fh-flow-grid">
          {flows.map(f => <FlowCard key={f.id} flow={f} idx={idx} onAction={onAction} />)}
        </ul>
      )}
    </section>
  )
  const templates = (
    <Templates state={tpl} idx={idx} feishu={feishu} onRetry={loadTemplates}
      onPick={t => setPreview({ kind: 'template', tpl: t })} />
  )

  return (
    <div className="fh-page">
      <header className="fh-top">
        <button type="button" className="fh-back" onClick={() => navigate(APP_PATH)} aria-label="返回对话">
          <Icon name="chevron" size={16} className="fh-flip" /><span>对话</span>
        </button>
        <TourButton tour="flows-home" className="fh-tour" />
      </header>

      <main className="fh-scroll">
        <div className={`fh-wrap${returning ? ' is-returning' : ''}`}>
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
          {compose}
          {returning ? <>{list}{templates}</> : <>{templates}{list}</>}
        </div>
      </main>

      {toast ? <div key={toast.key} className="fh-toast" role="status" aria-live="polite">{toast.msg}</div> : null}

      {preview?.kind === 'compose' ? (
        <Preview label="生成的流程" title={preview.draft.name || '新流程'} subtitle={preview.draft.summary}
          graph={preview.draft.graph} idx={idx} quote={preview.description} notes={preview.notes}
          reqs={requirements({ graph: preview.draft.graph }, idx, feishu)} onAction={onReqAction}
          primary="打开编辑" onPrimary={() => openDraft(preview.draft)}
          secondary="换个说法" onSecondary={rephrase} onClose={() => setPreview(null)} />
      ) : preview?.kind === 'template' ? (
        <Preview label="模板预览" title={preview.tpl.name} subtitle={preview.tpl.summary} icon={preview.tpl.icon}
          graph={preview.tpl.graph} idx={idx} reqs={requirements(preview.tpl, idx, feishu)} onAction={onReqAction}
          primary="用这个模板" onPrimary={() => openDraft({ name: preview.tpl.name, summary: preview.tpl.summary, graph: preview.tpl.graph })}
          secondary="关闭" onSecondary={() => setPreview(null)} onClose={() => setPreview(null)} />
      ) : null}
      {runsFor ? <RunsDrawer flow={runsFor} onClose={() => setRunsFor(null)} onOpenFlow={f => navigate(flowHref(f.id))} onExpired={expired} /> : null}
      {schedFor ? (
        <ScheduleSheet flow={schedFor} feishu={feishu} onBindFeishu={() => setBindOpen(true)}
          onOpenRuns={f => { setSchedFor(null); setRunsFor(f) }}
          onClose={() => setSchedFor(null)} onSaved={onScheduled} onExpired={expired} />
      ) : null}
      {delFor ? <ConfirmDelete flow={delFor} onCancel={() => setDelFor(null)} onDone={onDeleted} onExpired={expired} /> : null}
      {bindOpen ? (
        <FeishuConnect onClose={() => setBindOpen(false)} onExpired={expired}
          onChange={s => setFeishu({ configured: s?.configured !== false, bound: Boolean(s?.bound) })} />
      ) : null}
    </div>
  )
}
