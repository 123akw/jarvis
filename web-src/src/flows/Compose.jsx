import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'

/* 一句话生成：大输入框（参考 ChatGPT 的输入框）+ 示例胶囊；生成中显示骨架与进度文案，出错就地说清楚。 */

export const EXAMPLES = [
  '每天早上把天气和今天的日程发到飞书',
  '把会议记录整理成待办，加到我的待办里',
  '上传一份资料，提炼要点做成网页分享给同事',
  '每周五下午把这周的工作写成周报',
]
export const MAX_DESC = 300
const PHASES = ['正在理解你的需求…', '正在挑合适的节点…', '正在把节点连起来…', '快好了，正在检查能不能跑通…']

/** 生成中：节点骨架依次亮起 + 进度文案轮换 */
function Generating({ onCancel }) {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setPhase(p => Math.min(p + 1, PHASES.length - 1)), 1800)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="fh-gen" role="status" aria-live="polite">
      <div className="fh-gen-chain" aria-hidden="true">
        {[0, 1, 2, 3, 4].map(i => (
          <span key={i} className="fh-gen-item" style={{ '--i': i }}>
            {i ? <i className="fh-gen-wire" /> : null}<b />
          </span>
        ))}
      </div>
      <span className="fh-gen-text">{PHASES[phase]}</span>
      <button type="button" className="fh-link" onClick={onCancel}>取消</button>
    </div>
  )
}

export default function Compose({ value, onChange, onSubmit, onCancel, busy, error, inputRef }) {
  const local = useRef(null)
  const ref = inputRef || local
  const text = value.trim()

  // 随内容长高：两行起，最多六行
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [value, ref])

  function submit(e) {
    e?.preventDefault()
    if (!text || busy) return
    onSubmit(text)
  }
  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <section className="fh-compose-wrap" aria-labelledby="fh-compose-title" data-tour="flows-compose">
      <h2 id="fh-compose-title" className="sr-only">一句话生成流程</h2>
      <form className={`fh-compose${busy ? ' is-busy' : ''}`} onSubmit={submit}>
        <textarea ref={ref} className="fh-compose-input" rows={2} value={value} maxLength={MAX_DESC} readOnly={busy}
          aria-label="说说你想自动化什么" enterKeyHint="send" aria-describedby="fh-compose-hint"
          placeholder="说说你想自动化什么，比如：每天早上把天气和今天的日程发到飞书"
          onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown} />
        {busy ? <Generating onCancel={onCancel} /> : (
          <div className="fh-compose-bar">
            <span id="fh-compose-hint" className="fh-compose-hint">
              <Icon name="sparkles" size={15} />AI 帮你搭好节点，先预览，满意再打开编辑
            </span>
            <button type="submit" className={`fh-send${text ? ' is-ready' : ''}`} disabled={!text} aria-label="生成流程">
              <Icon name="up" size={18} />
            </button>
          </div>
        )}
      </form>
      {error ? (
        <p className="fh-compose-err" role="alert">
          {error}
          <button type="button" className="fh-link" onClick={() => submit()}>再试一次</button>
        </p>
      ) : null}
      <div className="fh-examples" role="group" aria-label="试试这些说法">
        {EXAMPLES.map(ex => (
          <button key={ex} type="button" className="fh-example" disabled={busy}
            onClick={() => { onChange(ex); onSubmit(ex) }}>{ex}</button>
        ))}
      </div>
    </section>
  )
}
