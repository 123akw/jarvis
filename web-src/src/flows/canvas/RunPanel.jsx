import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { copyText } from '../../clipboard.js'
import Icon from '../../Icon.jsx'
import { handleCodeCopyClick, renderMarkdown } from '../../markdown.js'
import { approveHref, remainLabel } from '../flowkit.js'
import { fmtMs, handleLabel, nodeById, nodeTitle, START_ID } from '../graph.js'
import { itemOf } from './catalog.js'
import Glyph, { NodeIcon } from './glyphs.jsx'
import { RunBadge } from './NodeCard.jsx'

/* 运行面板（桌面：右侧抽屉；手机：全屏弹层），按「输入 → 过程 → 结果」排：
 *   输入：按开始节点的输入项生成表单 → 运行（有改动先保存）；
 *   过程：按执行顺序逐节点，点开看产出；出错的那行自动展开并给「去改这一步」；点某行画布才居中到那个节点（不自动跟着跑）；
 *   结果：Markdown、链接、结果网页、复制；可停止。 */

const isEmpty = v => v === undefined || v === null || (typeof v === 'string' && !v.trim())

function Markdown({ text }) {
  const html = useMemo(() => renderMarkdown(String(text || '')), [text])
  // renderMarkdown 已经过 DOMPurify 消毒
  return <div className="fc-md jbody" onClick={handleCodeCopyClick} dangerouslySetInnerHTML={{ __html: html }} />
}

function Links({ links: all, page }) {
  const links = page ? all.filter(l => l.url !== page) : all   // 结果网页单独一个按钮，链接里就不再列一遍
  if (!links.length && !page) return null
  return (
    <ul className="fc-links">
      {page ? <li><a className="fc-page-link" href={page} target="_blank" rel="noopener noreferrer"><Glyph name="globe" size={15} />打开结果网页</a></li> : null}
      {links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noopener noreferrer"><Glyph name="link" size={14} />{l.label || '打开链接'}</a></li>)}
    </ul>
  )
}

/** 开始节点上传的原件（存进了文件空间）：[{ name, url, label? }]，只认站内文件链接 */
export function startFiles(state) {
  const files = state?.output?.files
  return Array.isArray(files) ? files.filter(f => f && typeof f.url === 'string' && f.url.startsWith('/api/files/')) : []
}

/** 原件下载链接 */
export function FileLinks({ files }) {
  if (!files.length) return null
  return (
    <ul className="fc-links fc-files" aria-label="上传的原件">
      {files.map((f, i) => (
        <li key={i}><a href={f.url} target="_blank" rel="noopener noreferrer" download><Icon name="clip" size={14} />原件：{f.name || '文件'}</a></li>
      ))}
    </ul>
  )
}

/** 一个节点这次的产出：文字（Markdown）、清单、链接、上传的原件；配置面板「上次结果」也用它 */
export function NodeOutput({ state, files: showFiles = true }) {
  const out = state?.output || {}
  const body = out.text || state?.preview || ''
  const items = Array.isArray(out.items) ? out.items : []
  const links = Array.isArray(out.links) ? out.links.filter(l => l && l.url) : []
  const files = showFiles ? startFiles(state) : []
  if (!body && !items.length && !links.length && !files.length) return <p className="fc-field-hint">这一步没有文字产出。</p>
  return (
    <>
      {body ? <Markdown text={body} /> : null}
      {items.length && !body ? <ul className="fc-rn-items">{items.slice(0, 20).map((it, i) => <li key={i}>{typeof it === 'string' ? it : String(it?.title || it?.text || '')}</li>)}</ul> : null}
      <Links links={links} />
      <FileLinks files={files} />
    </>
  )
}

/** 「去确认」：新标签页打开确认页（画布留着；处理完运行面板自己会更新） */
export function ApproveLink({ approval, className = 'jv-btn jv-btn--sm jv-btn--primary', children = '去确认' }) {
  const href = approveHref(approval)
  if (!href) return null
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" aria-label={`${children}（在新标签页打开）`}>
      <Glyph name="approval" size={14} />{children}
    </a>
  )
}

/** 这一步一句话：出错原因、没走到、条件走了哪条、或引擎给的 summary */
export function stepLine(state, node) {
  if (!state) return ''
  if (state.status === 'error') return state.message || '这一步没走通'
  if (state.status === 'skipped') return state.reason || '没走到这里'
  if (state.status === 'running') return '运行中…'
  if (state.status === 'stopped') return '停了'
  if (state.status === 'waiting') return '等你确认'
  const branch = state.output?.branch
  if (node?.type === 'condition' && branch !== undefined && branch !== null) return `走了「${handleLabel(node, branch) || '否则'}」`
  return state.summary || ''
}

function InputField({ field, value, onChange, disabled, invalid }) {
  const id = useId()
  const label = String(field.label || '').trim() || '没起名的输入项'
  const common = { id, disabled, 'aria-invalid': invalid || undefined, 'aria-required': field.required || undefined }
  let control
  if (field.type === 'paragraph') {
    control = <textarea {...common} className="fc-input fc-textarea" rows={5} value={value ?? ''} placeholder={field.placeholder || ''} onChange={e => onChange(e.target.value)} />
  } else if (field.type === 'number') {
    control = <input {...common} className="fc-input" type="number" inputMode="decimal" value={value ?? ''} placeholder={field.placeholder || ''} onChange={e => onChange(e.target.value)} />
  } else if (field.type === 'select') {
    control = (
      <select {...common} className="fc-select" value={value ?? ''} onChange={e => onChange(e.target.value)}>
        <option value="">请选择…</option>
        {(field.options || []).filter(o => String(o).trim()).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  } else if (field.type === 'file') {
    control = (
      <div className="fc-file">
        <input {...common} type="file" className="fc-file-input" onChange={e => onChange(e.target.files?.[0] || null)} />
        <label htmlFor={id} className="jv-btn jv-btn--sm"><Icon name="clip" size={14} />{value?.name ? '换一个文件' : '选择文件'}</label>
        <span className="fc-file-name">{value?.name || '还没选（10MB 以内）'}</span>
      </div>
    )
  } else {
    control = <input {...common} className="fc-input" value={value ?? ''} placeholder={field.placeholder || ''} onChange={e => onChange(e.target.value)} />
  }
  return (
    <div className="fc-field">
      <label className="fc-field-label" htmlFor={id}>{label}{field.required ? <em>必填</em> : null}</label>
      {control}
    </div>
  )
}

function NodeRow({ id, state, graph, index, onFocusNode, onLocate }) {
  const node = nodeById(graph, id)
  const title = node ? nodeTitle(node) : (state.title || '节点')
  const out = state.output || {}
  const has = !!(out.text || state.preview || (out.items || []).length || (out.links || []).length)
  const err = state.status === 'error'
  const files = startFiles(state)   // 开始节点：上传的原件常显在这一行下面，不用点开
  const head = (
    <>
      <NodeIcon type={node?.type || state.type || 'llm'} emoji={node ? (itemOf(index, node)?.icon || '') : ''} size={14} />
      <span className="fc-rn-title">{title}</span>
      <span className="fc-rn-sum">{stepLine(state, node)}</span>
      <RunBadge run={state} />
    </>
  )
  const focus = () => { if (node) onFocusNode?.(id) }
  if (!has && !err) {
    return (
      <li className={`fc-rn is-${state.status}`}>
        <button type="button" className="fc-rn-row" onClick={focus} aria-label={`${title}：${stepLine(state, node) || ''}，在画布上找到它`}>{head}</button>
        <FileLinks files={files} />
        {state.status === 'waiting' ? (
          <p className="fc-rn-wait"><span>已发给你确认</span><ApproveLink approval={state.approval} className="fc-link" /></p>
        ) : null}
      </li>
    )
  }
  return (
    <li className={`fc-rn is-${state.status}`}>
      <details open={err || undefined}>
        <summary className="fc-rn-row" onClick={focus}>{head}<Icon name="chevron" size={14} className="fc-rn-chev" /></summary>
        <div className="fc-rn-body">
          {has ? <NodeOutput state={state} files={false} /> : null}
          {err && node ? <button type="button" className="jv-btn jv-btn--sm" onClick={() => onLocate(id)}>去改这一步</button> : null}
        </div>
      </details>
      <FileLinks files={files} />
    </li>
  )
}

function FinalResult({ run, onLocate, graph }) {
  const [copied, setCopied] = useState('')
  const ref = useRef(null)
  const done = !!run && run.status !== 'running'
  // 跑完把结果卡滚到眼前（顺序仍是 输入 → 过程 → 结果）
  useEffect(() => {
    if (!done || !ref.current?.scrollIntoView) return
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ref.current.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }, [done, run?.runId])
  if (!done) return null
  if (run.status === 'stopped') return <div className="fc-final is-stopped" role="status" ref={ref}><p>已停止运行。</p></div>
  if (run.status === 'waiting') {
    const at = run.order.map(id => nodeById(graph, id)).find(n => n && run.nodes[n.id]?.status === 'waiting')
    const remain = remainLabel(run.approval?.expires_at)
    return (
      <div className="fc-final is-waiting" role="status" ref={ref}>
        <p className="fc-final-title"><Glyph name="wait" size={15} />已发给你确认</p>
        <p>{at ? `「${nodeTitle(at)}」` : '这一步'}在等你看一眼：同意了接着往下跑，拒绝就停在这里。{remain && remain !== '已过期' ? `${remain}。` : ''}</p>
        <div className="fc-final-acts"><ApproveLink approval={run.approval} /></div>
        <p className="fc-field-hint">通知里的链接也能打开确认页。处理完，这里会自己更新。</p>
      </div>
    )
  }
  if (run.status === 'resuming') {
    return <div className="fc-final is-resuming" role="status" ref={ref}><p><i className="fc-spin" aria-hidden="true" />你同意了，正在接着往下跑…</p></div>
  }
  if (run.status === 'rejected' || run.status === 'expired') {
    return (
      <div className="fc-final is-stopped" role="status" ref={ref}>
        <p className="fc-final-title">{run.status === 'rejected' ? '你没同意，后面的步骤没跑' : '确认过期了，后面的步骤没跑'}</p>
        {run.error ? <p>{run.error}</p> : null}
        <p>{run.status === 'rejected' ? '想改了再发，可以调整后再跑一次。' : '想发的话，再跑一次就行。'}</p>
      </div>
    )
  }
  if (run.status === 'error') {
    const at = run.errorNode ? nodeById(graph, run.errorNode) : null
    const step = at ? run.order.indexOf(at.id) + 1 : 0
    return (
      <div className="fc-final is-error" role="alert" ref={ref}>
        <p className="fc-final-title">{at ? `第 ${step} 步出错了` : '没跑通'}</p>
        <p>{run.error || '流程没跑完'}</p>
        {at ? <button type="button" className="jv-btn jv-btn--sm" onClick={() => onLocate(at.id)}>去改这一步</button> : null}
      </div>
    )
  }
  const out = run.output || {}
  const links = Array.isArray(out.links) ? out.links.filter(l => l && l.url) : []
  const steps = run.order.filter(id => run.nodes[id]?.status === 'ok').length
  return (
    <div className="fc-final is-ok" role="status" ref={ref}>
      <div className="fc-final-head">
        <span className="fc-final-ok"><Icon name="check" size={14} />完成{run.ms ? ` · 用时 ${fmtMs(run.ms)}` : ''}{steps ? ` · ${steps} 步` : ''}</span>
        {out.text ? (
          <button type="button" className="jv-btn jv-btn--sm" onClick={async () => { setCopied((await copyText(out.text)) ? '已复制' : '复制失败'); setTimeout(() => setCopied(''), 1500) }}>
            <Icon name="copy" size={14} />{copied || '复制结果'}
          </button>
        ) : null}
      </div>
      {out.text ? <Markdown text={out.text} /> : <p className="fc-field-hint">这次没有文字结果。</p>}
      <Links links={links} page={out.page_url} />
    </div>
  )
}

export default function RunPanel({
  graph, index, run, inputs, onInputs, onRun, onStop, onClose, blockers = [], onLocate, onFocusNode, busy = '', sheet = false,
}) {
  const start = nodeById(graph, START_ID)
  const fields = Array.isArray(start?.data?.fields) ? start.data.fields : []
  const [tried, setTried] = useState(false)
  const running = run?.status === 'running'
  // 没动过的字段显示它的默认值（服务端运行时也用默认值），必填检查同样算上默认值
  const valueOf = f => (inputs[f.key] === undefined && f.default !== undefined && f.default !== null ? f.default : inputs[f.key])
  const missing = fields.filter(f => f.required && isEmpty(valueOf(f)))
  const progress = run?.order || []
  const doneCount = progress.filter(id => ['ok', 'skipped'].includes(run.nodes[id]?.status)).length
  const say = !run ? '' : running ? `运行中，已完成 ${doneCount} 步` : run.status === 'ok' ? '完成' : run.status === 'stopped' ? '已停止'
    : run.status === 'waiting' ? '已发给你确认，去确认页处理' : run.status === 'resuming' ? '你同意了，正在接着跑'
      : run.status === 'rejected' ? '你没同意，后面的步骤没跑' : run.status === 'expired' ? '确认过期了' : `没跑通：${run.error}`

  function submit(e) {
    e.preventDefault()
    setTried(true)
    if (missing.length || blockers.length || running || busy) return
    onRun()
  }

  return (
    <section className={`fc-run${sheet ? ' is-sheet' : ''}`} aria-label="运行流程" data-tour="flow-run-panel">
      {!sheet ? (
        <header className="fc-config-head">
          <span className="fc-icon" data-type="start" aria-hidden="true"><Glyph name="play" size={14} /></span>
          <div className="fc-config-titles"><h2 className="fc-run-h">运行</h2><small>填好内容，看每一步怎么走</small></div>
          <button type="button" className="jv-modal-close" onClick={onClose} aria-label="收起运行面板"><Icon name="close" size={15} /></button>
        </header>
      ) : null}
      <div className="fc-config-body">
        {blockers.length ? (
          <div className="fc-blockers" role="alert">
            <p><b>还差这些才能运行：</b></p>
            <ul>
              {blockers.slice(0, 6).map(b => (
                <li key={b.key}>
                  {b.nodeId ? <button type="button" className="fc-link" onClick={() => onLocate(b.nodeId)}>「{nodeTitle(nodeById(graph, b.nodeId))}」</button> : null}
                  {b.message}
                </li>
              ))}
              {blockers.length > 6 ? <li>……还有 {blockers.length - 6} 处</li> : null}
            </ul>
          </div>
        ) : null}
        <h3 className="fc-cfg-h fc-run-sec">输入</h3>
        <form className="fc-run-form" onSubmit={submit} noValidate>
          {fields.length ? fields.map(f => (
            <InputField key={f.key} field={f} value={valueOf(f)} disabled={running}
              invalid={tried && missing.includes(f)} onChange={v => onInputs({ ...inputs, [f.key]: v })} />
          )) : <p className="fc-field-hint">这个流程运行时不用填东西。</p>}
          {tried && missing.length ? <p className="fc-form-err" role="alert">还没填：{missing.map(f => `「${f.label || '没起名的输入项'}」`).join('、')}</p> : null}
          <div className="fc-run-actions">
            {running ? (
              <button type="button" className="jv-btn fc-stop" onClick={onStop}><Icon name="stop" size={14} />停止</button>
            ) : (
              <button type="submit" className="jv-btn jv-btn--primary" disabled={!!busy || blockers.length > 0}>
                <Glyph name="play" size={13} />{busy === 'saving' ? '保存中…' : run ? '再跑一次' : '开始运行'}
              </button>
            )}
          </div>
        </form>
        {progress.length || running ? (
          <div className="fc-cfg-sec fc-run-steps">
            <h3 className="fc-cfg-h">过程</h3>
            {progress.length ? (
              <ol className="fc-rn-list">
                {progress.map(id => <NodeRow key={id} id={id} state={run.nodes[id]} graph={graph} index={index} onFocusNode={onFocusNode} onLocate={onLocate} />)}
              </ol>
            ) : <p className="fc-field-hint fc-run-wait"><i className="fc-spin" aria-hidden="true" />正在启动…</p>}
          </div>
        ) : null}
        {run && run.status !== 'running' ? <h3 className="fc-cfg-h fc-run-sec">结果</h3> : null}
        <FinalResult run={run} onLocate={onLocate} graph={graph} />
        <p className="sr-only" aria-live="polite">{say}</p>
      </div>
    </section>
  )
}
