import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { renderMarkdown } from '../markdown.js'
import { useDialogFocus, useEscape } from '../Modal.jsx'
import { listRuns } from './api.js'
import { absTime, absUrl, fmtMs, relTime, RUN_STATUS, safeHref } from './flowkit.js'

/* 运行记录抽屉：桌面从右侧滑出、手机是底部弹层。
 *   列表：状态、时间、用时、输入摘要 → 点一条看详情：逐节点结果（状态、用时、摘要 / 可展开的产出）+ 最终结果（Markdown 安全渲染）+ 结果网页。 */

const DOT = { ok: 'online', error: 'error', running: 'busy', busy: 'busy' }
const NODE_MARK = { ok: 'check', error: 'close' }

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

function RunRow({ run, onOpen }) {
  const status = RUN_STATUS[run.status] || '结束'
  const when = relTime(run.started_at)
  const bits = [fmtMs(run.ms) ? `用时 ${fmtMs(run.ms)}` : '', run.input_summary || ''].filter(Boolean)
  return (
    <li>
      <button type="button" className="fh-run" onClick={() => onOpen(run)}>
        <span className={`status-dot ${DOT[run.status] || ''}`} aria-hidden="true" />
        <span className="fh-run-main">
          <span className="fh-run-top">
            <b>{status}</b>
            <time dateTime={run.started_at || undefined} title={absTime(run.started_at)}>{when || absTime(run.started_at)}</time>
          </span>
          {bits.length ? <span className="fh-run-meta">{bits.join(' · ')}</span> : null}
        </span>
        <Icon name="chevron" size={16} className="fh-run-go" />
      </button>
    </li>
  )
}

function NodeResult({ node }) {
  const [open, setOpen] = useState(false)
  const state = node.status || 'ok'
  const ms = fmtMs(node.ms)
  return (
    <li className="fh-nres" data-state={state}>
      <span className="fh-nres-mark" aria-hidden="true">
        {NODE_MARK[state] ? <Icon name={NODE_MARK[state]} size={13} /> : <i />}
      </span>
      <div className="fh-nres-body">
        <p className="fh-nres-head">
          <b>{node.title || '一个节点'}</b>
          <span className="sr-only">：{RUN_STATUS[state] || state}</span>
          {ms ? <span className="fh-nres-ms">{ms}</span> : null}
        </p>
        {node.summary ? <p className="fh-nres-sum">{node.summary}</p> : state === 'skipped' ? <p className="fh-nres-sum">条件没走到这一步</p> : null}
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

function RunDetail({ run, onBack }) {
  const html = useMemo(() => (run.output_text ? renderMarkdown(String(run.output_text)) : ''), [run.output_text])
  const page = safeHref(run.page_url)
  const links = (Array.isArray(run.links) ? run.links : [])
    .map(l => ({ label: String(l?.label || '打开链接'), href: safeHref(l?.url) }))
    .filter(l => l.href && l.href !== page)
  const status = RUN_STATUS[run.status] || '结束'
  const nodes = Array.isArray(run.nodes) ? run.nodes : []
  const head = useRef(null)
  useEffect(() => { head.current?.focus({ preventScroll: true }) }, [])
  return (
    <div className="fh-rdetail">
      <button type="button" className="fh-back-row" onClick={onBack}>
        <Icon name="chevron" size={16} className="fh-flip" />全部记录
      </button>
      <div className="fh-rdetail-head" data-status={run.status}>
        <h3 ref={head} tabIndex={-1}>
          <span className={`status-dot ${DOT[run.status] || ''}`} aria-hidden="true" />这次运行{status}
        </h3>
        <p>{[absTime(run.started_at), fmtMs(run.ms) ? `用时 ${fmtMs(run.ms)}` : ''].filter(Boolean).join(' · ')}</p>
        {run.input_summary ? <p className="fh-rdetail-input">输入：{run.input_summary}</p> : null}
      </div>
      {run.error ? <p className="fh-rdetail-err" role="note">{run.error}</p> : null}
      {nodes.length ? (
        <section aria-label="每一步的结果">
          <h4 className="fh-h4">每一步</h4>
          <ol className="fh-nres-list">{nodes.map((n, i) => <NodeResult key={`${n.node_id || i}`} node={n} />)}</ol>
        </section>
      ) : null}
      {html || page || links.length ? (
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
      ) : null}
    </div>
  )
}

export default function RunsDrawer({ flow, onClose, onOpenFlow, onExpired }) {
  const [runs, setRuns] = useState(null)
  const [err, setErr] = useState('')
  const [picked, setPicked] = useState(null)
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
        {picked ? <RunDetail key={picked.id} run={picked} onBack={back} /> : err ? (
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
            {runs.map((r, i) => <RunRow key={r.id ?? i} run={r} onOpen={setPicked} />)}
          </ul>
        )}
      </div>
    </Drawer>
  )
}
