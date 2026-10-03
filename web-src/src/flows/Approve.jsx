import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { renderMarkdown } from '../markdown.js'
import { flowHref, navigate } from '../routes.js'
import { applyTheme, currentTheme } from '../theme.js'
import { decideApproval, getApproval, getRun } from './api.js'
import { absTime, absUrl, remainLabel, safeHref, sourceLabel, TYPE_META } from './flowkit.js'
import './flows.css'
import './approve.css'

/* 「发送前确认」页（第二十轮，契约 docs/proposals/2026-10-round20-flows-ops.md §3.1、§6.1；类名前缀 fa-）。
 * /approve/<id>：通知里的链接点开就是这里，手机优先。
 *   待确认：流程名、哪一步、从哪来的、要发出去的内容（允许修改时是大文本框）、同意后接下来会做什么 → 同意 / 拒绝（可填原因）；
 *   同意后：「接着在跑」，轮询这次运行直到跑完，给结果与结果网页；
 *   已处理 / 已过期 / 找不到：说清楚现在是什么情况、可以怎么办。顶部随时回「我的流程」。 */

/** 同意后多久问一次运行到哪了：前 30 秒每 2 秒，之后每 5 秒；最多问 10 分钟 */
export const POLL = { fast: 2000, slow: 5000, fastFor: 30_000, giveUp: 600_000 }
const DONE = new Set(['ok', 'error', 'rejected', 'expired', 'cancelled'])
const STATUS_TEXT = { approved: '你已经同意了', rejected: '你已经拒绝了', expired: '已经过期了' }

function Markdown({ text }) {
  const html = useMemo(() => renderMarkdown(String(text || '')), [text])
  // renderMarkdown 已经过 DOMPurify 消毒
  return <div className="fa-md jbody" dangerouslySetInnerHTML={{ __html: html }} />
}

/** 打开站内地址：普通点击在当前页里跳（不整页刷新），⌘ / Ctrl 点照常新开 */
function go(e, href) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  navigate(href)
}

function TopBar() {
  return (
    <header className="fh-top fa-top">
      <a className="fh-back" href={flowHref()} onClick={e => go(e, flowHref())}>
        <Icon name="chevron" size={16} className="fh-flip" /><span>我的流程</span>
      </a>
      <span className="fa-brand" aria-hidden="true"><span className="fa-brand-dot" />发送前确认</span>
    </header>
  )
}

/** 同意后「接下来会做什么」 */
function NextSteps({ next }) {
  const list = (Array.isArray(next) ? next : []).filter(n => n && (n.title || n.node_type))
  if (!list.length) return null
  return (
    <section className="fa-sec" aria-labelledby="fa-next-h">
      <h2 className="fa-h2" id="fa-next-h">同意后接下来会</h2>
      <ol className="fa-next">
        {list.map((n, i) => {
          const meta = TYPE_META[n.node_type] || TYPE_META.step
          return (
            <li key={i} data-tone={meta.tone}>
              <span className="fa-next-icon" aria-hidden="true">{n.icon || meta.icon}</span>
              <span className="fa-next-text">{n.title || meta.label}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/** 同意之后：轮询这次运行，跑完给结果 */
function AfterApprove({ approval, initialRun, onExpired }) {
  const flowId = approval?.flow?.id
  const runId = initialRun?.id || approval?.run_id
  const [run, setRun] = useState(initialRun?.status ? initialRun : { status: 'running' })
  const [gaveUp, setGaveUp] = useState(false)
  const head = useRef(null)
  const started = useRef(Date.now())
  const done = DONE.has(run.status) || run.status === 'waiting'

  useEffect(() => {
    if (!flowId || !runId || done || gaveUp) return undefined
    const elapsed = Date.now() - started.current
    if (elapsed > POLL.giveUp) { setGaveUp(true); return undefined }
    const t = setTimeout(async () => {
      try {
        const detail = await getRun(flowId, runId)
        setRun(detail && detail.status ? detail : r => ({ ...r }))
      } catch (err) {
        if (err.message === '401') { onExpired?.(); return }
        setRun(r => ({ ...r }))   // 网络抖一下：过一会儿再问
      }
    }, elapsed < POLL.fastFor ? POLL.fast : POLL.slow)
    return () => clearTimeout(t)
  }, [flowId, runId, run, done, gaveUp, onExpired])
  useEffect(() => { if (done) head.current?.focus({ preventScroll: true }) }, [done])

  const page = safeHref(run.page_url)
  const links = (Array.isArray(run.links) ? run.links : [])
    .map(l => ({ label: String(l?.label || '打开链接'), href: safeHref(l?.url) })).filter(l => l.href && l.href !== page)
  const step = (Array.isArray(run.nodes) ? run.nodes : []).find(n => n?.status === 'running')
  return (
    <section className={`fa-card fa-after is-${done ? run.status : 'running'}`} aria-labelledby="fa-after-h">
      {!done ? (
        <>
          <h2 className="fa-after-h" id="fa-after-h" ref={head} tabIndex={-1}><span className="fh-spark" aria-hidden="true" />你同意了，接着在跑</h2>
          <p className="fa-muted" role="status">{gaveUp ? '还在跑，比平时久一些。跑完会通知你，也可以稍后到运行记录里看。' : step?.title ? `正在：${step.title}` : '后面的步骤正在跑，一般几秒到一分钟。可以留在这里看结果，也可以先离开，跑完会通知你。'}</p>
        </>
      ) : run.status === 'ok' ? (
        <>
          <h2 className="fa-after-h" id="fa-after-h" ref={head} tabIndex={-1}><span className="fa-ok" aria-hidden="true"><Icon name="check" size={14} /></span>跑完了</h2>
          {run.output_text ? <Markdown text={run.output_text} /> : <p className="fa-muted">这次没有文字结果。</p>}
          {page || links.length ? (
            <div className="fa-links">
              {page ? <a className="jv-btn jv-btn--primary" href={absUrl(page)} target="_blank" rel="noopener noreferrer"><Icon name="share" size={15} />打开结果网页</a> : null}
              {links.map(l => <a key={l.href} className="jv-btn" href={absUrl(l.href)} target="_blank" rel="noopener noreferrer">{l.label}</a>)}
            </div>
          ) : null}
        </>
      ) : run.status === 'waiting' ? (
        <>
          <h2 className="fa-after-h" id="fa-after-h" ref={head} tabIndex={-1}>后面又有一步等你确认</h2>
          <p className="fa-muted">回到「我的流程」，顶部的「等你确认」里能找到它。</p>
        </>
      ) : (
        <>
          <h2 className="fa-after-h is-bad" id="fa-after-h" ref={head} tabIndex={-1}>没跑通</h2>
          <p className="fa-err">{run.error || '后面的步骤没跑完。到运行记录里看看是哪一步出的问题。'}</p>
        </>
      )}
      <div className="fa-links fa-links--quiet">
        <a className="jv-btn" href={flowHref()} onClick={e => go(e, flowHref())}>回到我的流程</a>
        {flowId ? <a className="jv-btn" href={flowHref(flowId)} onClick={e => go(e, flowHref(flowId))}>打开这个流程</a> : null}
      </div>
    </section>
  )
}

/** 已处理 / 已过期 / 找不到 */
function Settled({ approval, title, children }) {
  const flowId = approval?.flow?.id
  return (
    <section className="fa-card fa-settled" aria-labelledby="fa-settled-h">
      <h2 className="fa-after-h" id="fa-settled-h" tabIndex={-1}>{title}</h2>
      {children}
      <div className="fa-links fa-links--quiet">
        <a className="jv-btn jv-btn--primary" href={flowHref()} onClick={e => go(e, flowHref())}>回到我的流程</a>
        {flowId ? <a className="jv-btn" href={flowHref(flowId)} onClick={e => go(e, flowHref(flowId))}>打开这个流程</a> : null}
      </div>
    </section>
  )
}

export default function Approve({ id, onExpired }) {
  const [state, setState] = useState({ status: 'loading' })   // loading · ready · missing · error
  const [content, setContent] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [after, setAfter] = useState(null)     // 同意后：{ run }
  const [, tick] = useState(0)
  const textRef = useRef(null)
  const noteRef = useRef(null)
  const headRef = useRef(null)
  const expiredRef = useRef(onExpired)
  expiredRef.current = onExpired
  const expired = useCallback(() => expiredRef.current?.(), [])

  // 确认页不挂 Hud，主题自己套
  useEffect(() => {
    let theme = 'dark'
    try { theme = currentTheme() } catch { /* 存储不可用 */ }
    applyTheme(theme)
  }, [])

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    setErr('')
    try {
      const a = await getApproval(id)
      if (!a) { setState({ status: 'missing' }); return }
      setState({ status: 'ready', approval: a })
      setContent(String(a.content ?? a.preview ?? ''))
    } catch (e) {
      if (e.message === '401') { expired(); return }
      setState(e.status === 404 ? { status: 'missing' } : { status: 'error', error: e.message || '确认页没打开，请再试一次' })
    }
  }, [id, expired])
  useEffect(() => { setAfter(null); setRejecting(false); setNote(''); load() }, [load])

  const a = state.approval
  useEffect(() => {
    document.title = a?.flow?.name ? `确认：${a.flow.name} · 贾维斯` : '等你确认 · 贾维斯'
  }, [a?.flow?.name])
  // 剩余时间每分钟刷新一下
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  // 文本框随内容长高
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight + 2, 180), 640)}px`
  }, [content, state.status])
  useEffect(() => { if (rejecting) noteRef.current?.focus() }, [rejecting])

  const remain = a ? remainLabel(a.expires_at) : ''
  const lapsed = a?.status === 'pending' && remain === '已过期'
  const status = lapsed ? 'expired' : a?.status
  const original = String(a?.content ?? a?.preview ?? '')
  const changed = Boolean(a?.editable) && content !== original

  async function decide(decision) {
    if (busy) return
    if (decision === 'approve' && a.editable && !content.trim()) { setErr('内容是空的：写点什么再同意，或者点「恢复原文」'); return }
    setBusy(decision)
    setErr('')
    try {
      const res = await decideApproval(id, decision === 'approve'
        ? { decision, ...(a.editable ? { content } : {}) }
        : { decision, note })
      const next = { ...a, ...(res?.approval || {}), status: res?.approval?.status || (decision === 'approve' ? 'approved' : 'rejected') }
      setState({ status: 'ready', approval: next })
      if (decision === 'approve') setAfter({ run: res?.run || { id: a.run_id, status: 'running' } })
      setRejecting(false)
    } catch (e) {
      if (e.message === '401') { expired(); return }
      if (e.status === 409) {   // 别处已经处理过 / 刚好过期：读一下现在是什么情况
        await load()
        setErr(e.message)
      } else setErr(e.message || '没提交成功，请再试一次')
    } finally {
      setBusy('')
    }
  }

  let body
  if (state.status === 'loading') {
    body = (
      <div className="fa-card fa-skel" role="status" aria-label="正在打开确认页">
        <i /><i /><b /><i />
      </div>
    )
  } else if (state.status === 'missing') {
    body = (
      <Settled title="找不到这条确认">
        <p className="fa-muted">可能链接不完整、已经处理过并清掉了，或者它不是发给这个账号的。换回收到通知的那个账号再点一次链接试试。</p>
      </Settled>
    )
  } else if (state.status === 'error') {
    body = (
      <div className="fa-card fh-inline-err" role="alert">
        <p>{state.error}</p>
        <button type="button" className="jv-btn jv-btn--sm" onClick={load}>重新加载</button>
      </div>
    )
  } else if (after) {
    body = <AfterApprove approval={a} initialRun={after.run} onExpired={expired} />
  } else if (status !== 'pending') {
    body = (
      <Settled approval={a} title={status === 'approved' ? '这一步你已经同意了' : status === 'rejected' ? '这一步你已经拒绝了' : '这条确认已经过期了'}>
        {err ? <p className="fa-err" role="alert">{err}</p> : null}
        <p className="fa-muted">
          {status === 'approved' ? '流程已经接着往下跑了，结果到运行记录里看。'
            : status === 'rejected' ? `后面的步骤没跑。${a.note ? `你写的原因：${a.note}` : ''}`
              : '过了时间没处理，后面的步骤没跑。想发的话，回到流程再跑一次。'}
        </p>
        {status === 'approved' && a.run_id && a.flow?.id ? (
          <button type="button" className="fh-link" onClick={() => setAfter({ run: { id: a.run_id, status: 'running' } })}>看看跑得怎么样了</button>
        ) : null}
      </Settled>
    )
  } else {
    body = (
      <>
        <section className="fa-card fa-main" aria-labelledby="fa-content-h">
          <h2 className="fa-h2" id="fa-content-h">要发出去的内容</h2>
          {a.editable ? (
            <>
              <textarea ref={textRef} className="fa-text" value={content} onChange={e => { setContent(e.target.value); if (err) setErr('') }}
                aria-labelledby="fa-content-h" aria-describedby="fa-content-note" maxLength={20000} spellCheck={false} />
              <p className="fa-note" id="fa-content-note">
                {changed ? <>改过了，同意后按改好的发。<button type="button" className="fh-link" onClick={() => setContent(original)}>恢复原文</button></>
                  : '可以直接改，改完点同意就按改好的发。'}
              </p>
            </>
          ) : (
            <>
              <div className="fa-readonly" tabIndex={0} aria-labelledby="fa-content-h"><Markdown text={original} /></div>
              <p className="fa-note">这一步设成了不能改：只能同意或拒绝。</p>
            </>
          )}
        </section>
        <NextSteps next={a.next} />
        <div className="fa-actions" role="group" aria-label="确认">
          {err ? <p className="fa-err" role="alert">{err}</p> : null}
          {rejecting ? (
            <div className="fa-reject">
              <label className="fa-reject-label" htmlFor="fa-note">为什么不发？<span>可不填，会记在运行记录里</span></label>
              <textarea id="fa-note" ref={noteRef} className="fa-note-input" rows={2} maxLength={200} value={note}
                placeholder="比如：数据不对，我改完再跑" onChange={e => setNote(e.target.value)} />
              <div className="fa-btns">
                <button type="button" className="jv-btn" onClick={() => setRejecting(false)} disabled={!!busy}>算了</button>
                <button type="button" className="jv-btn jv-btn--danger" onClick={() => decide('reject')} disabled={!!busy}>
                  {busy === 'reject' ? '正在提交…' : '确认拒绝'}
                </button>
              </div>
            </div>
          ) : (
            <div className="fa-btns">
              <button type="button" className="jv-btn fa-no" onClick={() => setRejecting(true)} disabled={!!busy}>拒绝</button>
              <button type="button" className="jv-btn jv-btn--primary fa-yes" onClick={() => decide('approve')} disabled={!!busy}>
                <Icon name="check" size={16} />{busy === 'approve' ? '正在提交…' : changed ? '按改好的同意' : '同意，接着跑'}
              </button>
            </div>
          )}
          {!rejecting ? <p className="fa-hint">{remain ? `${remain}，过期后自动作废` : '过期后自动作废'}</p> : null}
        </div>
      </>
    )
  }

  const pending = state.status === 'ready' && status === 'pending' && !after
  return (
    <div className="fh-page fa-page">
      <TopBar />
      <main className="fh-scroll fa-scroll">
        <div className="fa-wrap">
          {state.status === 'ready' ? (
            <header className="fa-head">
              <p className={`fa-eyebrow is-${after ? 'approved' : status}`}>
                <span className="fa-eyebrow-dot" aria-hidden="true" />
                {after ? '你同意了' : pending ? `等你确认${remain && remain !== '已过期' ? ` · ${remain}` : ''}` : STATUS_TEXT[status] || ''}
              </p>
              <h1 className="fa-h1" ref={headRef} tabIndex={-1}>{a.flow?.name || '一个流程'}</h1>
              <p className="fa-sub">
                {a.title ? <>停在「<b>{a.title}</b>」这一步</> : '停在发送前确认这一步'}
                {sourceLabel(a.source) ? <> · {sourceLabel(a.source)}</> : null}
                {a.created_at ? <> · {absTime(a.created_at)}</> : null}
              </p>
            </header>
          ) : null}
          {body}
        </div>
      </main>
    </div>
  )
}
