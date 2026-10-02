import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { QrCode } from '../qr.jsx'
import { fileToBase64 } from './api.js'
import { absUrl, fmtMs, inputLabel, relTime, RUN_STATUS } from './model.js'

/* 试运行的三块：输入面板 · 结果卡 · 运行历史 */

export const MAX_FILE = 10 * 1024 * 1024
const FILE_EXTS = ['.pdf', '.docx', '.txt', '.md', '.jpg', '.jpeg', '.png', '.webp', '.bmp']
const FILE_ACCEPT = FILE_EXTS.join(',')

/** 演示用示例资料：一段会议纪要，拆分 / 提炼 / 生成网页都有东西可做 */
export const SAMPLE_TEXT = `10 月 2 日 产品例会纪要
参会：产品组、研发组、市场组

一、方向
做面向不懂技术的人的插件拼接工具，每个人都能拼出自己的智能体：把微信、飞书、文件处理封装成插件，用户按场景拼起来，最后拿到一个链接或二维码。

二、流程
输入 → 工具 → 输出。例：项目资料 → 拆分文件 → 汇总到飞书文档 → 生成网页二维码。

三、待办
1. 周五前做出演示版（研发组）
2. 整理插件清单与定价（产品组）
3. 准备比赛 3 分钟演示剧本（市场组）`

export function fileProblem(file) {
  if (!file) return ''
  const name = (file.name || '').toLowerCase()
  if (!FILE_EXTS.some(ext => name.endsWith(ext))) return '只支持 PDF、Word（.docx）、TXT、Markdown 和图片'
  if (file.size > MAX_FILE) return '文件超过 10MB 上限，换个小一点的'
  return ''
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 运行前的输入面板：第一步是「资料上传」就选文件，否则贴文字 */
export function RunSheet({ flowName, inputPlugin, inputStep, onCancel, onSubmit }) {
  const wantsFile = inputPlugin?.id === 'input_file'
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const label = String(inputStep?.options?.label || '').trim() || (wantsFile ? '要处理的资料' : '要处理的文字')

  function pick(f) {
    if (!f) return
    const why = fileProblem(f)
    setError(why)
    setFile(why ? null : f)
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (wantsFile) {
      if (!file) { setError('先选一个文件'); return }
      setReading(true)
      try {
        onSubmit({ file: { name: file.name, data_base64: await fileToBase64(file) } })
      } catch (err) {
        setError(err.message || '读取文件失败')
      } finally {
        setReading(false)
      }
      return
    }
    if (!text.trim()) { setError('先写点内容，或者点「填入示例」'); return }
    onSubmit({ text: text.trim() })
  }

  const ready = wantsFile ? !!file : !!text.trim()
  return (
    <Modal label="试运行" onClose={onCancel} size="md" dismissOnBackdrop={false} className="fl-runsheet">
      <ModalHead title="试运行" subtitle={flowName} onClose={onCancel} />
      <form className="jv-modal-body fl-runform" onSubmit={submit}>
        {wantsFile ? (
          <>
            <label className={`fl-drop${dragOver ? ' is-over' : ''}${file ? ' has-file' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer?.files?.[0]) }}>
              <input type="file" className="fl-drop-input" accept={FILE_ACCEPT} data-autofocus
                aria-label={label} onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
              <span className="fl-drop-icon" aria-hidden="true"><Icon name={file ? 'note' : 'clip'} size={22} /></span>
              {file ? (
                <span className="fl-drop-text"><b>{file.name}</b><span>{fmtSize(file.size)} · 点这里换一个</span></span>
              ) : (
                <span className="fl-drop-text"><b>{label}</b><span>点这里选文件，或拖进来 · PDF / Word / TXT / MD / 图片，10MB 以内</span></span>
              )}
            </label>
            <button type="button" className="fl-linkbtn"
              onClick={() => pick(new File([SAMPLE_TEXT], '示例-会议纪要.txt', { type: 'text/plain' }))}>
              手边没资料？用示例会议纪要
            </button>
          </>
        ) : (
          <>
            <label className="fl-field">
              <span>{label}</span>
              <textarea rows={7} value={text} maxLength={20000} data-autofocus placeholder="贴一段文字进来，比如会议记录、客户需求、通知草稿…"
                onChange={e => setText(e.target.value)} />
            </label>
            <button type="button" className="fl-linkbtn" onClick={() => setText(SAMPLE_TEXT)}>填入示例</button>
          </>
        )}
        {error ? <p className="fl-form-err" role="alert">{error}</p> : null}
        <div className="fl-runform-actions">
          <button type="button" className="jv-btn" onClick={onCancel}>取消</button>
          <button type="submit" className="jv-btn jv-btn--primary" disabled={!ready || reading}>
            {reading ? '读取中…' : '开始运行'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function CopyButton({ value }) {
  const [state, setState] = useState('')
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    const ok = await copyText(value)
    setState(ok ? '已复制' : '复制失败，请手动复制')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(''), 1800)
  }
  return (
    <button type="button" className="jv-btn jv-btn--sm" onClick={copy}>
      <Icon name={state === '已复制' ? 'check' : 'copy'} size={15} />{state || '复制链接'}
    </button>
  )
}

/** 运行结束的结果卡：成功给链接 + 二维码；失败说清是哪一步、为什么；取消说明前面结果还在 */
export function ResultCard({ run, steps, byId, onRetry }) {
  if (!run || run.status === 'running') return null
  const secs = run.ms ? `用时 ${(run.ms / 1000).toFixed(1)} 秒` : ''
  if (run.status === 'cancelled') {
    const done = run.order.filter(id => run.nodes[id]?.state === 'done').length
    return (
      <section className="fl-result" data-status="cancelled" aria-label="运行结果">
        <div className="fl-result-main">
          <p className="fl-result-kicker">已取消</p>
          <h3 className="fl-result-title">这次运行停下了</h3>
          <p className="fl-result-note">{done ? `前面完成的 ${done} 步结果还留在节点下面。` : '还没有步骤跑完。'}</p>
          <div className="jv-actions"><button type="button" className="jv-btn jv-btn--sm" onClick={onRetry}>重新运行</button></div>
        </div>
      </section>
    )
  }
  if (run.status === 'error') {
    const i = run.order.findIndex(id => run.nodes[id]?.state === 'error')
    const name = i >= 0 ? byId[steps[i]?.plugin]?.name : ''
    return (
      <section className="fl-result" data-status="error" aria-label="运行结果">
        <div className="fl-result-main">
          <p className="fl-result-kicker">没跑通</p>
          <h3 className="fl-result-title">{i >= 0 ? `卡在第 ${i + 1} 步「${name || '这一步'}」` : '流程没跑完'}</h3>
          <p className="fl-result-note">{run.error}</p>
          <div className="jv-actions"><button type="button" className="jv-btn jv-btn--sm" onClick={onRetry}>再试一次</button></div>
        </div>
      </section>
    )
  }
  const lastDone = [...run.order].reverse().map(id => run.nodes[id]).find(n => n?.state === 'done')
  if (run.output?.kind === 'file' && run.output.url) {   // 「生成 Excel / Word」积木：结果是文件空间里的文件
    return (
      <section className="fl-result" data-status="ok" aria-label="运行结果">
        <div className="fl-result-main">
          <p className="fl-result-kicker"><Icon name="check" size={14} />跑通了{secs ? ` · ${secs}` : ''}</p>
          <h3 className="fl-result-title">{run.output.title || '文件已生成'}</h3>
          <p className="fl-result-note">文件存在你的文件空间里，保留 30 天。</p>
          <div className="jv-actions">
            <a className="jv-btn jv-btn--sm jv-btn--primary" href={run.output.url} download>下载文件</a>
            <button type="button" className="jv-btn jv-btn--sm" onClick={onRetry}>再跑一次</button>
          </div>
        </div>
      </section>
    )
  }
  const url = absUrl(run.output?.url)
  return (
    <section className="fl-result" data-status="ok" aria-label="运行结果">
      <div className="fl-result-main">
        <p className="fl-result-kicker"><Icon name="check" size={14} />跑通了{secs ? ` · ${secs}` : ''}</p>
        <h3 className="fl-result-title">{run.output?.title || '流程已完成'}</h3>
        {url ? (
          <>
            <a className="fl-result-url mono" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
            <div className="jv-actions">
              <CopyButton value={url} />
              <a className="jv-btn jv-btn--sm jv-btn--primary" href={url} target="_blank" rel="noopener noreferrer">打开结果网页</a>
              <button type="button" className="jv-btn jv-btn--sm" onClick={onRetry}>再跑一次</button>
            </div>
          </>
        ) : (
          <>
            <p className="fl-result-note">{lastDone?.summary || '每一步的结果都在节点下面。'}</p>
            <div className="jv-actions"><button type="button" className="jv-btn jv-btn--sm" onClick={onRetry}>再跑一次</button></div>
          </>
        )}
      </div>
      {url ? (
        <figure className="fl-result-qr">
          <QrCode value={url} size={136} label="结果网页二维码，手机扫码查看" />
          <figcaption>手机扫一扫</figcaption>
        </figure>
      ) : null}
    </section>
  )
}

const DOT = { ok: 'online', error: 'error', running: 'busy' }

/** 最近几次运行：状态、时间、结果链接 */
export function RunHistory({ runs }) {
  return (
    <section className="fl-hist" aria-label="最近运行">
      <h3 className="fl-sub">最近运行</h3>
      {runs === null ? <p className="fl-hist-empty">加载中…</p>
        : !runs.length ? <p className="fl-hist-empty">还没运行过，点「运行」试一次。</p>
          : (
            <ol className="fl-hist-list">
              {runs.map((r, i) => {
                const url = r.output?.url || r.url
                const when = relTime(r.finished_at || r.started_at)
                const span = Date.parse(r.finished_at) - Date.parse(r.started_at)
                const took = span > 0 ? fmtMs(span) : ''
                const what = inputLabel(r.input)
                return (
                  <li key={r.id ?? i} className="fl-hist-row">
                    <span className={`status-dot ${DOT[r.status] || ''}`} aria-hidden="true" />
                    <span className="fl-hist-status">{RUN_STATUS[r.status] || r.status || '未知'}</span>
                    <time className="fl-hist-time" dateTime={r.finished_at || r.started_at || undefined}>{when}</time>
                    {what || took ? <span className="fl-hist-meta">{[what, took].filter(Boolean).join(' · ')}</span> : null}
                    {url ? (
                      <a className="fl-hist-link" href={absUrl(url)} target="_blank" rel="noopener noreferrer">
                        打开结果<span className="sr-only">（{when}那次）</span>
                      </a>
                    ) : r.error ? <span className="fl-hist-err" title={r.error}>{r.error}</span> : null}
                  </li>
                )
              })}
            </ol>
          )}
    </section>
  )
}
