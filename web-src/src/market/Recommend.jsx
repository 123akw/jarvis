import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import Presence, { prefersReducedMotion } from '../Presence.jsx'
import { DESC_MAX, recommendedIds } from './model.js'

const WAIT_LINES = ['正在了解你的行当…', '从插件市场里挑合适的…', '顺手排一条流程…']

function Waiting() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI(x => (x + 1) % WAIT_LINES.length), 1400)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="jvm-rec is-wait" role="status" aria-live="polite">
      <div className="jvm-rec-wait">
        <Presence size={40} state="thinking" decorative />
        <span key={i} className="jvm-rec-wait-text">{WAIT_LINES[i]}</span>
      </div>
      <div className="jvm-skel" aria-hidden="true"><i /><i /><i /></div>
    </div>
  )
}

function FlowChain({ flow, byId }) {
  return (
    <li className="jvm-flow">
      <div className="jvm-flow-head">
        <span className="jvm-flow-name">{flow.name}</span>
        {flow.summary ? <span className="jvm-flow-sum">{flow.summary}</span> : null}
      </div>
      <ol className="jvm-chain" aria-label={`${flow.name}的步骤`}>
        {flow.steps.map((s, i) => {
          const p = byId.get(s.plugin)
          return (
            <li key={`${s.plugin}-${i}`}>
              <span className="jvm-node">{p?.icon || '🧩'}</span>
              <span className="jvm-node-name">{p?.name || s.plugin}</span>
            </li>
          )
        })}
      </ol>
    </li>
  )
}

function Result({ rec, catalog, picked, onToggle, onAddAll }) {
  const byId = new Map(catalog.plugins.map(p => [p.id, p]))
  const plugins = rec.plugins.map(id => byId.get(id)).filter(Boolean)
  const pickedSet = new Set(picked)
  const all = recommendedIds(rec).filter(id => byId.has(id))
  const left = all.filter(id => !pickedSet.has(id)).length
  return (
    <section className="jvm-rec" aria-label="推荐结果">
      <header className="jvm-rec-head">
        <h3>为你推荐</h3>
        <span className="jvm-rec-src">{rec.source === 'model' ? 'AI 推荐' : '按职业推荐'}</span>
      </header>
      {rec.reason ? <p className="jvm-rec-reason">{rec.reason}</p> : null}
      {plugins.length ? (
        <ul className="jvm-rec-list">
          {plugins.map(p => {
            const on = pickedSet.has(p.id)
            return (
              <li key={p.id} className={on ? 'is-on' : ''}>
                <span className="jvm-rec-icon" aria-hidden="true">{p.icon}</span>
                <span className="jvm-rec-name">{p.name}{p.tier === 'pro' ? <span className="jvm-badge is-pro">专业版</span> : null}</span>
                {on ? <span className="jvm-rec-in">已在工具箱</span> : null}
                <button type="button" className={`jvm-add is-mini${on ? ' is-on' : ''}`} aria-pressed={on}
                  aria-label={on ? `移出工具箱：${p.name}` : `加入工具箱：${p.name}`} onClick={() => onToggle(p.id)}>
                  <Icon name={on ? 'check' : 'plus'} size={14} />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      {rec.flows.length ? (
        <>
          <h4 className="jvm-rec-sub">推荐流程 <span>积木会一起放进工具箱</span></h4>
          <ul className="jvm-flows">{rec.flows.map(f => <FlowChain key={f.id} flow={f} byId={byId} />)}</ul>
        </>
      ) : null}
      <button type="button" className="jvm-btn jvm-btn--block" disabled={!left} onClick={() => onAddAll(all)}>
        {left ? `一键全部加入（${left} 个）` : <><Icon name="check" size={16} />都在工具箱里了</>}
      </button>
    </section>
  )
}

/** 「帮我推荐」：选职业，或用一句话描述 → 推荐插件与流程，一键全部加入。市场里的辅助，不是前置步骤 */
export default function Recommend({ catalog, draft, recState, onPickProfession, onDescription, onDescribe, onToggle, onAddAll }) {
  const { profession, description, recommendation } = draft
  const recRef = useRef(null)
  // 手机上结果区可能在一屏外：开始推荐时把它滚进视野，让人看到「正在挑」
  useEffect(() => {
    if (recState.status !== 'loading') return
    recRef.current?.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [recState.status])
  const submit = e => {
    e.preventDefault()
    if (description.trim() && recState.status !== 'loading') onDescribe()
  }
  return (
    <section className="jvm-helper" aria-labelledby="jvm-helper-title">
      <h2 id="jvm-helper-title" className="jvm-helper-title"><Icon name="sparkles" size={16} />帮我推荐</h2>
      <p className="jvm-helper-sub">选个职业，或者用一句话说说你的情况。</p>
      <fieldset className="jvm-prof">
        <legend className="sr-only">你是做什么的</legend>
        {catalog.professions.map(p => (
          <label key={p.id} className={`jvm-prof-chip${profession === p.id ? ' is-on' : ''}`} title={p.summary || undefined}>
            <input type="radio" name="jvm-profession" value={p.id} checked={profession === p.id}
              onChange={() => onPickProfession(p.id)} className="sr-only" />
            <span aria-hidden="true">{p.icon}</span>{p.name}
          </label>
        ))}
      </fieldset>
      <form className="jvm-describe" onSubmit={submit}>
        <label htmlFor="jvm-desc" className="sr-only">用一句话描述你的情况</label>
        <div className="jvm-describe-box">
          <textarea id="jvm-desc" rows={2} maxLength={DESC_MAX} value={description}
            placeholder="比如：我开奶茶店，想管订单和员工排班"
            onChange={e => onDescription(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e) }} />
          <button type="submit" className="jvm-describe-go" disabled={!description.trim() || recState.status === 'loading'}
            aria-label="按描述推荐">
            <Icon name="up" size={17} />
          </button>
        </div>
      </form>
      <div ref={recRef} className="jvm-rec-anchor" />
      {recState.status === 'loading' ? <Waiting /> : null}
      {recState.status === 'error' ? (
        <div className="jvm-alert" role="alert">
          <span>{recState.error}</span>
          <button type="button" className="jvm-link" onClick={recState.retry}>再试一次</button>
        </div>
      ) : null}
      {recState.status !== 'loading' && recommendation ? (
        <Result rec={recommendation} catalog={catalog} picked={draft.picked} onToggle={onToggle} onAddAll={onAddAll} />
      ) : null}
    </section>
  )
}
