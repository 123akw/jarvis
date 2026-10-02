import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import Presence, { prefersReducedMotion } from '../Presence.jsx'
import { flyToDock } from './dnd/index.jsx'
import { recommendedIds } from './model.js'
import { detailHref, linkClick } from './PluginCard.jsx'

/* 「帮我推荐」不再是常驻的大面板：
 *  - 入口一：首屏搜索框里打一句话 →「AI 推荐」；
 *  - 入口二：搜索框下面一行职业小标签；
 *  - 结果按需在首屏下方展开一块轻量面板，可收起；搜索时让位给搜索结果。 */

const WAIT_LINES = ['正在了解你的行当…', '从插件市场里挑合适的…', '顺手排一条流程…']

/** 搜索框下的一行文字建议「试试：个体店主 · 老师 …」（单选，不加边框，横滑）：点一下就按这个职业推荐；
 *  有上次的推荐且面板收着时，末尾给「看推荐结果」 */
export function ProfessionTags({ professions, value, onPick, onReopen }) {
  return (
    <fieldset className="jvm-prof">
      <legend className="sr-only">按职业推荐</legend>
      <span className="jvm-prof-label" aria-hidden="true">试试</span>
      {professions.map(p => (
        <label key={p.id} className={`jvm-prof-chip${value === p.id ? ' is-on' : ''}`} title={p.summary || undefined}>
          <input type="radio" name="jvm-profession" value={p.id} checked={value === p.id} onChange={() => onPick(p.id)}
            onClick={() => { if (value === p.id) onPick(p.id) }} className="sr-only" />
          {p.name}
        </label>
      ))}
      {onReopen ? <button type="button" className="jvm-prof-again" onClick={onReopen}>看推荐结果<Icon name="chevron" size={13} /></button> : null}
    </fieldset>
  )
}

function Waiting() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI(x => (x + 1) % WAIT_LINES.length), 1400)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="jvm-rec-wait" role="status" aria-live="polite">
      <Presence size={36} state="thinking" decorative />
      <span key={i} className="jvm-rec-wait-text">{WAIT_LINES[i]}</span>
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

function Result({ rec, catalog, picked, onToggle, onAddAll, onOpen }) {
  const byId = new Map(catalog.plugins.map(p => [p.id, p]))
  const plugins = rec.plugins.map(id => byId.get(id)).filter(Boolean)
  const pickedSet = new Set(picked)
  const all = recommendedIds(rec).filter(id => byId.has(id))
  const left = all.filter(id => !pickedSet.has(id)).length
  const add = (p, e) => {
    if (!pickedSet.has(p.id)) flyToDock(e.currentTarget.closest('li') || e.currentTarget, { icon: p.icon })
    onToggle(p.id)
  }
  return (
    <section className="jvm-rec-body" aria-label="推荐结果">
      {rec.reason ? <p className="jvm-rec-reason">{rec.reason}</p> : null}
      {plugins.length ? (
        <ul className="jvm-rec-list">
          {plugins.map(p => {
            const on = pickedSet.has(p.id)
            return (
              <li key={p.id} className={on ? 'is-on' : ''}>
                <span className="jvm-rec-icon" aria-hidden="true">{p.icon}</span>
                <span className="jvm-rec-name">
                  {onOpen ? <a href={detailHref(p.id)} onClick={e => linkClick(e, () => onOpen(p.id))}>{p.name}</a> : p.name}
                  {p.tier === 'pro' ? <span className="jvm-badge is-pro">专业版</span> : null}
                </span>
                <button type="button" className={`jvm-plus${on ? ' is-on' : ''}`} aria-pressed={on}
                  aria-label={on ? `移出工具箱：${p.name}` : `加入工具箱：${p.name}`} onClick={e => add(p, e)}>
                  <Icon name={on ? 'check' : 'plus'} size={15} />
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
      <button type="button" className="jvm-btn jvm-btn--tint jvm-rec-all" disabled={!left}
        onClick={e => { flyToDock(e.currentTarget, { icon: plugins[0]?.icon || '✨' }); onAddAll(all) }}>
        {left ? `一键全部加入（${left} 个）` : <><Icon name="check" size={16} />都在工具箱里了</>}
      </button>
    </section>
  )
}

/** 推荐结果面板：只在推荐中 / 有结果 / 出错时出现；右上角收起 */
export default function RecommendPanel({ catalog, recommendation, picked, recState, basis, onToggle, onAddAll, onOpen, onClose }) {
  const ref = useRef(null)
  // 结果区可能在一屏外：开始推荐时把它滚进视野，让人看到「正在挑」
  useEffect(() => {
    if (recState.status !== 'loading') return
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [recState.status])
  const loading = recState.status === 'loading'
  return (
    <section className="jvm-rec" id="jvm-helper" ref={ref} aria-labelledby="jvm-rec-title">
      <header className="jvm-rec-head">
        <h2 id="jvm-rec-title" className="jvm-rec-title"><Icon name="sparkles" size={16} />为你推荐</h2>
        {!loading && recommendation ? (
          <span className="jvm-rec-src">{recommendation.source === 'model' ? 'AI 推荐' : '按职业推荐'}</span>
        ) : null}
        <button type="button" className="jvm-rec-close" onClick={onClose} aria-label="收起推荐"><Icon name="close" size={15} /></button>
      </header>
      {basis ? <p className="jvm-rec-basis">{basis}</p> : null}
      {loading ? <Waiting /> : null}
      {recState.status === 'error' ? (
        <div className="jvm-alert" role="alert">
          <span>{recState.error}</span>
          <button type="button" className="jvm-link" onClick={recState.retry}>再试一次</button>
        </div>
      ) : null}
      {!loading && recommendation ? (
        <Result rec={recommendation} catalog={catalog} picked={picked} onToggle={onToggle} onAddAll={onAddAll} onOpen={onOpen} />
      ) : null}
    </section>
  )
}
