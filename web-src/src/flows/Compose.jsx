import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon.jsx'

/* 一句话生成（参考 Langflow 欢迎页、ChatGPT 输入框、Dify「试试这些」）：
 *   新用户：标题「你想自动化什么？」+ 大输入框 + 「试试这些」4 个建议（固定列表，按账号能用的插件过滤，可「换一批」）；
 *   已有流程的老用户：收成单行输入框，建议不展示，让「我的流程」上移。
 *   等待时不做假进度：节点清单形状的骨架 +「一般要 5–15 秒」，可取消。 */

/** 「试试这些」：固定列表；plugins 是要用到的插件，当前账号用不了就不推荐 */
export const SUGGESTIONS = [
  { text: '每天早上把天气和今天的日程发到飞书', plugins: ['weather', 'schedule'] },
  { text: '把会议记录整理成待办，加到我的待办里', plugins: ['to_todo'] },
  { text: '顾客差评先分类，再写一段客气的回复', plugins: [] },
  { text: '把长文章拆成学习卡片，做成网页', plugins: ['split_file', 'web_page'] },
  { text: '每周五下午把这周的工作写成周报', plugins: ['work_report'] },
  { text: '上传合同，有高风险的条款就提醒我', plugins: ['contract_check'] },
  { text: '给个主题，写小红书文案和短视频口播稿', plugins: ['social_post', 'video_script'] },
  { text: '查快递到哪了，签收了就告诉我', plugins: ['kuaidi100'] },
]
export const MIN_DESC = 6
export const MAX_DESC = 300
const PAGE = 4

/** 当前账号能用的建议：目录里明确说用不了（available: false）的插件不推荐；目录没加载出来就全给 */
export function usableSuggestions(idx) {
  return SUGGESTIONS.filter(s => s.plugins.every(id => idx?.plugin?.[id]?.available !== false))
}

function Generating({ onCancel }) {
  return (
    <div className="fh-gen" role="status" aria-live="polite">
      <ul className="fh-gen-list" aria-hidden="true">
        {[0, 1, 2].map(i => <li key={i} style={{ '--i': i }}><i /><b /></li>)}
      </ul>
      <div className="fh-gen-row">
        <span className="fh-spark" aria-hidden="true" />
        <span className="fh-gen-text">正在规划流程……一般要 5–15 秒</span>
        <button type="button" className="fh-link" onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}

export default function Compose({ value, onChange, onSubmit, onCancel, busy, error, inputRef, compact = false, idx }) {
  const local = useRef(null)
  const ref = inputRef || local
  const [page, setPage] = useState(0)
  const [short, setShort] = useState(false)
  const text = value.trim()
  const ready = text.length >= MIN_DESC
  const pool = useMemo(() => usableSuggestions(idx), [idx])
  const pages = Math.max(1, Math.ceil(pool.length / PAGE))
  const shown = pool.slice((page % pages) * PAGE, (page % pages) * PAGE + PAGE)

  // 随内容长高：最多六行
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [value, ref, compact])
  useEffect(() => { if (ready) setShort(false) }, [ready])

  function submit(e) {
    e?.preventDefault()
    if (busy || !text) return
    if (!ready) { setShort(true); return }
    onSubmit(text)
  }
  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      submit()
    }
  }

  const send = (
    <button type="submit" className={`fh-send${ready ? ' is-ready' : ''}`} disabled={!ready || busy} aria-label="生成流程">
      <Icon name="up" size={18} />
    </button>
  )
  return (
    <section className={`fh-compose-wrap${compact ? ' is-compact' : ''}`} aria-labelledby="fh-compose-title" data-tour="flows-compose">
      <h2 id="fh-compose-title" className={compact ? 'sr-only' : 'fh-compose-title'}>你想自动化什么？</h2>
      <form className={`fh-compose${busy ? ' is-busy' : ''}`} onSubmit={submit}>
        <div className="fh-compose-main">
          <textarea ref={ref} className="fh-compose-input" rows={compact ? 1 : 2} value={value} maxLength={MAX_DESC} readOnly={busy}
            aria-label="说说你想自动化什么" enterKeyHint="send" aria-describedby={short ? 'fh-compose-short' : undefined}
            placeholder={compact ? '说说还想自动化什么，贾维斯帮你搭' : '说说你想自动化什么，比如：每天早上把天气和今天的日程发到飞书'}
            onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown} />
          {compact && !busy ? send : null}
        </div>
        {busy ? <Generating onCancel={onCancel} /> : !compact ? (
          <div className="fh-compose-bar">
            <span className="fh-compose-hint"><Icon name="sparkles" size={15} />AI 先搭好草稿，你看过再打开编辑</span>
            {send}
          </div>
        ) : null}
      </form>
      {short && !ready ? <p id="fh-compose-short" className="fh-compose-note">再多说几个字，比如「每天早上把天气发到飞书」</p> : null}
      {error ? (
        <p className="fh-compose-err" role="alert">
          {error}
          <button type="button" className="fh-link" onClick={() => submit()}>再试一次</button>
        </p>
      ) : null}
      {!compact && shown.length ? (
        <div className="fh-examples" role="group" aria-label="试试这些">
          <span className="fh-examples-label" aria-hidden="true">试试这些</span>
          {shown.map(s => (
            <button key={s.text} type="button" className="fh-example" disabled={busy}
              onClick={() => { onChange(s.text); onSubmit(s.text) }}>{s.text}</button>
          ))}
          {pages > 1 ? (
            <button type="button" className="fh-link fh-examples-more" disabled={busy} onClick={() => setPage(p => p + 1)}>换一批</button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
