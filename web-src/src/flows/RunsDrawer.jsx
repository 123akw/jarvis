import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { renderMarkdown } from '../markdown.js'
import { useDialogFocus, useEscape } from '../Modal.jsx'
import { navigate } from '../routes.js'
import { listRuns, rerunGraph } from './api.js'
import { absTime, absUrl, approveHref, fmtMs, nodeInfo, relTime, remainLabel, RUN_STATUS, safeHref, sourceLabel } from './flowkit.js'
import { runReducer, startRunState } from './graph.js'

/* 运行记录抽屉：桌面从右侧滑出、手机是底部弹层。
 *   列表：状态、来源、时间、用时、输入摘要 →「再跑」/ 点一条看详情：逐节点结果（状态、用时、摘要 / 可展开的产出）
 *   + 最终结果（Markdown 安全渲染）+ 结果网页。
 *   「用这次的输入再跑」（第二十轮，契约 §3.3）：就地显示每一步的进度与结果，跑完回到列表能看到新的一条。 */

const DOT = { ok: 'online', error: 'error', running: 'busy', busy: 'busy', waiting: 'wait' }
const NODE_MARK = { ok: 'check', error: 'close' }
/** 详情标题：「这次运行完成」……；等确认 / 拒绝 / 过期单独说 */
const HEADING = { waiting: '这次运行在等你确认', rejected: '这次你没同意，停下了', expired: '确认过期了，这次停下了', running: '这次运行还在跑' }
const heading = run => HEADING[run.status] || `这次运行${RUN_STATUS[run.status] || '结束'}`
/** 能不能「用这次的输入再跑」：还在跑 / 在等确认的不行 */
const canRerun = run => Boolean(run?.id) && !['running', 'busy', 'waiting'].includes(run.status)

/** 抽屉外壳：遮罩 + 面板，Esc / 点遮罩关闭，焦点圈在里面 */
export function Drawer({ label, onClose, className = '', children }) {
  const ref = useRef(null)
  useEscape(onClose)
  useDialogFocus(ref)
  return (
    <div className="fh-drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className={`fh-drawer${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}

/** 来源小标签（输入摘要里已经说了的就不重复） */
function SourceTag({ run }) {
  const label = sourceLabel(run.source)
  if (!label || String(run.input_summary || '').includes(label)) return null
  return <span className="fh-run-src">{label}</span>
}

function RunRow({ run, onOpen, onRerun }) {
  const status = RUN_STATUS[run.status] || '结束'
  const when = relTime(run.started_at)
  const bits = [fmtMs(run.ms) ? `用时 ${fmtMs(run.ms)}` : '', run.input_summary || ''].filter(Boolean)
  return (
    <li className="fh-run-li">
      <button type="button" className="fh-run" onClick={() => onOpen(run)}>
        <span className={`status-dot ${DOT[run.status] || ''}`} aria-hidden="true" />
        <span className="fh-run-main">
          <span className="fh-run-top">
            <b>{status}</b>
            <SourceTag run={run} />
            <time dateTime={run.started_at || undefined} title={absTime(run.started_at)}>{when || absTime(run.started_at)}</time>
          </span>
          {bits.length ? <span className="fh-run-meta">{bits.join(' · ')}</span> : null}
        </span>
        <Icon name="chevron" size={16} className="fh-run-go" />
      </button>
      {canRerun(run) && onRerun ? (
        <button type="button" className="fh-rerun-btn" onClick={() => onRerun(run)}
          aria-label={`用这次的输入再跑（${absTime(run.started_at) || '这一次'}）`} title="用这次的输入再跑">
          <Icon name="undo" size={14} className="fh-flip" /><span>再跑</span>
        </button>
      ) : null}
    </li>
  )
}

function NodeResult({ node }) {
  const [open, setOpen] = useState(false)
  const state = node.status || 'ok'
  const ms = fmtMs(node.ms)
  // 开始节点上传的原件（存进了文件空间，30 天内能下载）
  const files = (Array.isArray(node.files) ? node.files : []).map(f => ({ name: f?.name, href: safeHref(f?.url) }))
    .filter(f => f.href.startsWith('/api/files/'))
  return (
    <li className="fh-nres" data-state={state}>
      <span className="fh-nres-mark" aria-hidden="true">
        {NODE_MARK[state] ? <Icon name={NODE_MARK[state]} size={13} /> : state === 'running' ? <span className="fh-nres-spin" /> : <i />}
      </span>
      <div className="fh-nres-body">
        <p className="fh-nres-head">
          <b>{node.title || '一个节点'}</b>
          <span className="sr-only">：{RUN_STATUS[state] || state}</span>
          {ms ? <span className="fh-nres-ms">{ms}</span> : null}
        </p>
        {node.summary ? <p className="fh-nres-sum">{node.summary}</p>
          : state === 'skipped' ? <p className="fh-nres-sum">条件没走到这一步</p>
            : state === 'waiting' ? <p className="fh-nres-sum">在等你确认</p>
              : state === 'running' ? <p className="fh-nres-sum">正在跑…</p> : null}
        {files.length ? (
          <p className="fh-nres-files">
            {files.map((f, i) => <a key={i} href={f.href} target="_blank" rel="noopener noreferrer" download><Icon name="clip" size={13} />原件：{f.name || '文件'}</a>)}
          </p>
        ) : null}
        {node.preview ? (
          <>
            <button type="button" className="fh-link" aria-expanded={open} onClick={() => setOpen(o => !o)}>
              {open ? '收起产出' : '看看产出'}
            </button>
            {open ? <pre className="fh-nres-pre">{node.preview}</pre> : null}
          </>
        ) : null}
      </div>
    </li>
  )
}

/** 最终结果：Markdown + 结果网页 + 链接（详情与重跑共用） */
function FinalOutput({ text, page: rawPage, links: rawLinks }) {
  const html = useMemo(() => (text ? renderMarkdown(String(text)) : ''), [text])
  const page = safeHref(rawPage)
  const links = (Array.isArray(rawLinks) ? rawLinks : [])
    .map(l => ({ label: String(l?.label || '打开链接'), href: safeHref(l?.url) }))
    .filter(l => l.href && l.href !== page)
  if (!html && !page && !links.length) return null
  return (
    <section aria-label="最终结果">
      <h4 className="fh-h4">最终结果</h4>
      {html ? <div className="fh-result jbody" dangerouslySetInnerHTML={{ __html: html }} /> : null}
      {page || links.length ? (
        <div className="fh-result-links">
          {page ? (
            <a className="jv-btn jv-btn--sm" href={absUrl(page)} target="_blank" rel="noopener noreferrer">
              <Icon name="share" size={15} />打开结果网页
            </a>
          ) : null}
          {links.map(l => (
            <a key={l.href} className="jv-btn jv-btn--sm" href={absUrl(l.href)} target="_blank" rel="noopener noreferrer">{l.label}</a>
          ))}
        </div>
      ) : null}
    </section>
  )
}

/** 等确认时的「去确认」：同一个网页里打开确认页 */
function GoApprove({ approval }) {
  const href = approveHref(approval)
  const remain = remainLabel(approval?.expires_at)
  return (
    <div className="fh-wait-box" role="note">
      <p><b>已发给你确认</b>同意了接着往下跑，拒绝就停在这里。{remain && remain !== '已过期' ? `${remain}。` : ''}</p>
      {href ? (
        <a className="jv-btn jv-btn--sm jv-btn--primary" href={href}
          onClick={e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(href) }}>去确认</a>
      ) : <p className="fh-muted">到「我的流程」顶部的「等你确认」里处理。</p>}
    </div>
  )
}

function RunDetail({ run, onBack, onRerun }) {
  const nodes = Array.isArray(run.nodes) ? run.nodes : []
  const head = useRef(null)
  const source = sourceLabel(run.source)
  useEffect(() => { head.current?.focus({ preventScroll: true }) }, [])
  return (
    <div className="fh-rdetail">
      <button type="button" className="fh-back-row" onClick={onBack}>
        <Icon name="chevron" size={16} className="fh-flip" />全部记录
      </button>
      <div className="fh-rdetail-head" data-status={run.status}>
        <h3 ref={head} tabIndex={-1}>
          <span className={`status-dot ${DOT[run.status] || ''}`} aria-hidden="true" />{heading(run)}
        </h3>
        <p>{[absTime(run.started_at), source, fmtMs(run.ms) ? `用时 ${fmtMs(run.ms)}` : ''].filter(Boolean).join(' · ')}</p>
        {run.input_summary ? <p className="fh-rdetail-input">输入：{run.input_summary}</p> : null}
        {canRerun(run) && onRerun ? (
          <button type="button" className="jv-btn jv-btn--sm fh-rerun-full" onClick={() => onRerun(run)}>
            <Icon name="undo" size={14} className="fh-flip" />用这次的输入再跑
          </button>
        ) : null}
      </div>
      {run.status === 'waiting' ? <GoApprove approval={run.approval} /> : null}
      {run.error ? <p className="fh-rdetail-err" role="note">{run.error}</p> : null}
      {nodes.length ? (
        <section aria-label="每一步的结果">
          <h4 className="fh-h4">每一步</h4>
          <ol className="fh-nres-list">{nodes.map((n, i) => <NodeResult key={`${n.node_id || i}`} node={n} />)}</ol>
        </section>
      ) : null}
      <FinalOutput text={run.output_text} page={run.page_url} links={run.links} />
    </div>
  )
}

/** 「用这次的输入再跑」：SSE 事件驱动每一步的进度，就地显示结果；跑完可以回列表看新的那条 */
function RerunView({ flow, from, onBack, onExpired }) {
  const [state, setState] = useState(() => startRunState())
  const [failed, setFailed] = useState('')
  const ctrlRef = useRef(null)
  const head = useRef(null)
  // 事件没带节点名字时：先用那次记录里的，再按流程图推（「查实时天气」「写成早报」……）
  const titles = useMemo(() => ({
    ...Object.fromEntries((flow.graph?.nodes || []).filter(n => n?.id).map(n => [n.id, nodeInfo(n).name])),
    ...Object.fromEntries((Array.isArray(from.nodes) ? from.nodes : []).filter(n => n?.title).map(n => [n.node_id, n.title])),
  }), [from.nodes, flow.graph])

  useEffect(() => {
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    let s = startRunState()
    ;(async () => {
      try {
        for await (const ev of rerunGraph(flow.id, from.id, ctrl.signal)) {
          if (ctrl.signal.aborted) break
          s = runReducer(s, ev)
          setState(s)
          if (ev.type === 'run_done') break
        }
        if (ctrl.signal.aborted) s = runReducer(s, { type: 'stopped' })
        else if (s.status === 'running') s = runReducer(s, { type: 'failed', message: '连接断了，这次结果会保存在运行记录里' })
      } catch (err) {
        if (err.message === '401') { onExpired?.(); return }
        if (ctrl.signal.aborted || err.name === 'AbortError') s = runReducer(s, { type: 'stopped' })
        else if (!s.order.length && !s.runId) { setFailed(err.message || '没能再跑一次，请稍后再试'); return }
        else s = runReducer(s, { type: 'failed', message: err.message || '流程没跑完' })
      }
      setState({ ...s, ms: s.ms || Date.now() - s.startedAt })
    })()
    return () => ctrl.abort()
  }, [flow.id, from.id, onExpired])
  useEffect(() => { head.current?.focus({ preventScroll: true }) }, [])

  const running = !failed && state.status === 'running'
  const steps = state.order.map(id => {
    const n = state.nodes[id] || {}
    return { node_id: id, title: n.title || titles[id] || '', status: n.status, ms: n.ms, summary: n.status === 'error' ? n.message : n.status === 'skipped' ? n.reason : n.summary, preview: n.preview }
  })
  const out = state.output || {}
  const say = failed ? `没能再跑：${failed}` : running ? `正在重跑，已完成 ${steps.filter(x => x.status === 'ok').length} 步`
    : state.status === 'ok' ? '重跑完成' : state.status === 'waiting' ? '已发给你确认' : state.status === 'stopped' ? '已停止' : `没跑通：${state.error}`
  return (
    <div className="fh-rdetail fh-rerun">
      <button type="button" className="fh-back-row" onClick={() => { ctrlRef.current?.abort(); onBack() }}>
        <Icon name="chevron" size={16} className="fh-flip" />{running ? '停止并回到全部记录' : '全部记录'}
      </button>
      <div className="fh-rdetail-head" data-status={state.status}>
        <h3 ref={head} tabIndex={-1}>
          {running ? <span className="fh-spark" aria-hidden="true" /> : <span className={`status-dot ${DOT[failed ? 'error' : state.status] || ''}`} aria-hidden="true" />}
          {failed ? '没能再跑' : running ? '用这次的输入再跑…' : heading(state)}
        </h3>
        <p>{[`用的是 ${absTime(from.started_at) || '那次'} 的输入`, !running && state.ms ? `用时 ${fmtMs(state.ms)}` : ''].filter(Boolean).join(' · ')}</p>
        {from.input_summary ? <p className="fh-rdetail-input">输入：{from.input_summary}</p> : null}
        {running ? (
          <button type="button" className="jv-btn jv-btn--sm fh-rerun-stop" onClick={() => ctrlRef.current?.abort()}>
            <Icon name="stop" size={13} />停止
          </button>
        ) : null}
      </div>
      {failed ? <p className="fh-rdetail-err" role="alert">{failed}</p> : null}
      {state.status === 'waiting' ? <GoApprove approval={state.approval} /> : null}
      {!failed && state.error && state.status !== 'running' ? <p className="fh-rdetail-err" role="note">{state.error}</p> : null}
      {steps.length || running ? (
        <section aria-label="每一步的进度">
          <h4 className="fh-h4">每一步</h4>
          {steps.length ? <ol className="fh-nres-list">{steps.map(n => <NodeResult key={n.node_id} node={n} />)}</ol>
            : <p className="fh-muted">正在启动…</p>}
        </section>
      ) : null}
      {state.status === 'ok' ? <FinalOutput text={out.text} page={out.page_url} links={out.links} /> : null}
      {!running && !failed && state.status !== 'stopped' ? (
        <p className="fh-muted fh-rerun-foot">这次也记进了运行记录，回到全部记录就能看到。</p>
      ) : null}
      <p className="sr-only" aria-live="polite">{say}</p>
    </div>
  )
}

export default function RunsDrawer({ flow, onClose, onOpenFlow, onExpired }) {
  const [runs, setRuns] = useState(null)
  const [err, setErr] = useState('')
  const [picked, setPicked] = useState(null)
  const [rerun, setRerun] = useState(null)
  const listTop = useRef(null)
  const load = useCallback(async () => {
    setErr('')
    setRuns(null)
    try {
      setRuns(await listRuns(flow.id, 20))
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setErr(e.message || '运行记录没加载出来')
    }
  }, [flow.id, onExpired])
  useEffect(() => { load() }, [load])

  function back() {
    setPicked(null)
    requestAnimationFrame(() => listTop.current?.focus({ preventScroll: true }))
  }
  function startRerun(run) {
    setPicked(null)
    setRerun({ from: run, key: Date.now() })
  }
  function leaveRerun() {
    setRerun(null)
    load()   // 新的一条（来源「重跑」）出现在最上面
    requestAnimationFrame(() => listTop.current?.focus({ preventScroll: true }))
  }

  return (
    <Drawer label={`运行记录：${flow.name || '未命名流程'}`} onClose={onClose} className="fh-runs">
      <div className="fh-drawer-head">
        <div>
          <h2 className="fh-drawer-title" ref={listTop} tabIndex={-1}>运行记录</h2>
          <p className="fh-drawer-sub">{flow.name || '未命名流程'}</p>
        </div>
        <button type="button" className="jv-modal-close" onClick={onClose} aria-label="关闭"><Icon name="close" size={16} /></button>
      </div>
      <div className="fh-drawer-body">
        {rerun ? <RerunView key={rerun.key} flow={flow} from={rerun.from} onBack={leaveRerun} onExpired={onExpired} />
          : picked ? <RunDetail key={picked.id} run={picked} onBack={back} onRerun={startRerun} /> : err ? (
            <div className="fh-inline-err" role="alert">
              <p>{err}</p>
              <button type="button" className="jv-btn jv-btn--sm" onClick={load}>重新加载</button>
            </div>
          ) : runs === null ? (
            <p className="fh-muted" role="status">正在加载运行记录…</p>
          ) : !runs.length ? (
            <div className="fh-empty-runs">
              <p>还没运行过。</p>
              <p className="fh-muted">打开流程点「运行」试一次，或者设个定时让它按时跑。</p>
              <button type="button" className="jv-btn jv-btn--sm" onClick={() => onOpenFlow(flow)}>打开流程</button>
            </div>
          ) : (
            <ul className="fh-run-list" aria-label="最近的运行">
              {runs.map((r, i) => <RunRow key={r.id ?? i} run={r} onOpen={setPicked} onRerun={startRerun} />)}
            </ul>
          )}
      </div>
    </Drawer>
  )
}
