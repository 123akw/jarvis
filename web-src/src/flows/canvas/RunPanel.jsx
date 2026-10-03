import { useId, useMemo, useState } from 'react'
import { copyText } from '../../clipboard.js'
import Icon from '../../Icon.jsx'
import { handleCodeCopyClick, renderMarkdown } from '../../markdown.js'
import { fmtMs, nodeById, nodeTitle, START_ID } from '../graph.js'
import { itemOf } from './catalog.js'
import Glyph, { NodeIcon } from './glyphs.jsx'
import { RunBadge } from './NodeCard.jsx'

/* 运行面板（桌面：右侧抽屉；手机：全屏弹层）：
 *   按开始节点的输入项生成表单 → 运行（有改动先保存）→ 逐节点实时状态，可展开看产出 → 最终结果（Markdown、链接、结果网页）；可停止。 */

const isEmpty = v => v === undefined || v === null || (typeof v === 'string' && !v.trim())

function Markdown({ text }) {
  const html = useMemo(() => renderMarkdown(String(text || '')), [text])
  // renderMarkdown 已经过 DOMPurify 消毒
  return <div className="fc-md jbody" onClick={handleCodeCopyClick} dangerouslySetInnerHTML={{ __html: html }} />
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
        <span className="fc-file-name">{value?.name || '还没选'}</span>
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

function NodeResult({ id, state, graph, index }) {
  const node = nodeById(graph, id)
  const title = node ? nodeTitle(node) : (state.title || '节点')
  const out = state.output || {}
  const body = out.text || state.preview || ''
  const items = Array.isArray(out.items) ? out.items : []
  const links = Array.isArray(out.links) ? out.links : []
  const has = !!(body || items.length || links.length)
  const head = (
    <>
      <NodeIcon type={node?.type || state.type || 'llm'} emoji={node ? (itemOf(index, node)?.icon || '') : ''} size={14} />
      <span className="fc-rn-title">{title}</span>
      <span className="fc-rn-sum">
        {state.status === 'error' ? state.message : state.status === 'skipped' ? (state.reason || '没走到这条分支') : state.status === 'running' ? '正在运行…' : (state.summary || '')}
      </span>
      <RunBadge run={state} />
    </>
  )
  if (!has) return <li className={`fc-rn is-${state.status}`}><div className="fc-rn-row">{head}</div></li>
  return (
    <li className={`fc-rn is-${state.status}`}>
      <details>
        <summary className="fc-rn-row">{head}<Icon name="chevron" size={14} className="fc-rn-chev" /></summary>
        <div className="fc-rn-body">
          {body ? <Markdown text={body} /> : null}
          {items.length && !body ? <ul className="fc-rn-items">{items.slice(0, 20).map((it, i) => <li key={i}>{typeof it === 'string' ? it : JSON.stringify(it)}</li>)}</ul> : null}
          {links.length ? <ul className="fc-links">{links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noopener noreferrer"><Glyph name="link" size={14} />{l.label || l.url}</a></li>)}</ul> : null}
        </div>
      </details>
    </li>
  )
}

function FinalResult({ run, onLocate, graph }) {
  const [copied, setCopied] = useState('')
  if (!run || run.status === 'running') return null
  if (run.status === 'stopped') return <div className="fc-final is-stopped" role="status"><p>已停止运行。</p></div>
  if (run.status === 'error') {
    const at = run.errorNode ? nodeById(graph, run.errorNode) : null
    return (
      <div className="fc-final is-error" role="alert">
        <p><b>没跑通：</b>{run.error || '流程没跑完'}</p>
        {at ? <button type="button" className="jv-btn jv-btn--sm" onClick={() => onLocate(at.id)}>去看看「{nodeTitle(at)}」</button> : null}
      </div>
    )
  }
  const out = run.output || {}
  const links = Array.isArray(out.links) ? out.links : []
  return (
    <div className="fc-final is-ok" role="status">
      <div className="fc-final-head">
        <span className="fc-final-ok"><Icon name="check" size={14} />运行完成{run.ms ? ` · 用时 ${fmtMs(run.ms)}` : ''}</span>
        {out.text ? (
          <button type="button" className="jv-btn jv-btn--sm" onClick={async () => { setCopied((await copyText(out.text)) ? '已复制' : '复制失败'); setTimeout(() => setCopied(''), 1500) }}>
            <Icon name="copy" size={14} />{copied || '复制结果'}
          </button>
        ) : null}
      </div>
      {out.text ? <Markdown text={out.text} /> : <p className="fc-field-hint">这次没有文字结果。</p>}
      {links.length || out.page_url ? (
        <ul className="fc-links">
          {out.page_url ? <li><a className="fc-page-link" href={out.page_url} target="_blank" rel="noopener noreferrer"><Glyph name="globe" size={15} />打开结果网页</a></li> : null}
          {links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noopener noreferrer"><Glyph name="link" size={14} />{l.label || l.url}</a></li>)}
        </ul>
      ) : null}
    </div>
  )
}

export default function RunPanel({
  graph, index, run, inputs, onInputs, onRun, onStop, onClose, blockers = [], onLocate, busy = '', sheet = false,
}) {
  const start = nodeById(graph, START_ID)
  const fields = Array.isArray(start?.data?.fields) ? start.data.fields : []
  const [tried, setTried] = useState(false)
  const running = run?.status === 'running'
  const missing = fields.filter(f => f.required && isEmpty(inputs[f.key]))
  const progress = run?.order || []
  const doneCount = progress.filter(id => ['ok', 'skipped'].includes(run.nodes[id]?.status)).length
  const say = !run ? '' : running ? `正在运行，已完成 ${doneCount} 步` : run.status === 'ok' ? '运行完成' : run.status === 'stopped' ? '已停止' : `没跑通：${run.error}`

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
        <form className="fc-run-form" onSubmit={submit} noValidate>
          {fields.length ? fields.map(f => (
            <InputField key={f.key} field={f} value={inputs[f.key]} disabled={running}
              invalid={tried && missing.includes(f)} onChange={v => onInputs({ ...inputs, [f.key]: v })} />
          )) : <p className="fc-field-hint">这个流程运行时不用填东西。</p>}
          {tried && missing.length ? <p className="fc-form-err" role="alert">还没填：{missing.map(f => `「${f.label || '没起名的输入项'}」`).join('、')}</p> : null}
          <div className="fc-run-actions">
            {running ? (
              <button type="button" className="jv-btn fc-stop" onClick={onStop}><Icon name="stop" size={14} />停止</button>
            ) : (
              <button type="submit" className="jv-btn jv-btn--primary" disabled={!!busy || blockers.length > 0}>
                <Glyph name="play" size={13} />{busy === 'saving' ? '先保存…' : run ? '再跑一次' : '开始运行'}
              </button>
            )}
          </div>
        </form>
        {progress.length ? (
          <div className="fc-cfg-sec">
            <h3 className="fc-cfg-h">每一步</h3>
            <ol className="fc-rn-list">
              {progress.map(id => <NodeResult key={id} id={id} state={run.nodes[id]} graph={graph} index={index} />)}
            </ol>
          </div>
        ) : running ? <p className="fc-field-hint fc-run-wait"><i className="fc-spin" aria-hidden="true" />正在启动…</p> : null}
        <FinalResult run={run} onLocate={onLocate} graph={graph} />
        <p className="sr-only" aria-live="polite">{say}</p>
      </div>
    </section>
  )
}
