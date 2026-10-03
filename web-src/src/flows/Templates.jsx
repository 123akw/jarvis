import { useMemo, useRef, useState } from 'react'
import { chainLabel, nodeInfo, orderNodes, pluginNeeds } from './flowkit.js'
import { IconChain } from './Thumb.jsx'

/* 模板库（参考 Dify 的探索页）：分类页签 + 卡片（图标、名称、一句话、节点链小图标、用之前需要什么）。点卡片出预览。 */

function TemplateCard({ tpl, idx, onPick }) {
  const nodes = useMemo(() => orderNodes(tpl.graph).map(n => ({ id: n.id, ...nodeInfo(n, idx) })), [tpl.graph, idx])
  const blocked = pluginNeeds(tpl.plugins, idx).filter(p => !p.available)
  const needs = Array.isArray(tpl.needs) ? tpl.needs.filter(Boolean) : []
  return (
    <li>
      <button type="button" className="fh-tpl" onClick={() => onPick(tpl)} aria-haspopup="dialog">
        <span className="fh-tpl-head">
          <span className="fh-tpl-icon" aria-hidden="true">{tpl.icon || '🧩'}</span>
          <span className="fh-tpl-name">{tpl.name}</span>
        </span>
        {tpl.summary ? <span className="fh-tpl-sum">{tpl.summary}</span> : null}
        <IconChain nodes={nodes} label={`步骤：${chainLabel(tpl.graph, idx)}`} />
        {blocked.length ? (
          <span className="fh-tpl-need is-warn">需要先加「{blocked.map(p => p.name).join('」「')}」</span>
        ) : needs.length ? (
          <span className="fh-tpl-need">{needs.join(' · ')}</span>
        ) : null}
      </button>
    </li>
  )
}

function Skeleton() {
  return (
    <ul className="fh-tpl-grid" aria-hidden="true">
      {[0, 1, 2, 3].map(i => <li key={i}><div className="fh-tpl fh-skel-card"><i /><i /><i /></div></li>)}
    </ul>
  )
}

export default function Templates({ state, idx, onPick, onRetry }) {
  const [tab, setTab] = useState('all')
  const tabRefs = useRef({})
  const { categories, templates } = state
  const tabs = useMemo(() => {
    const used = new Set(templates.map(t => t.category))
    return [{ id: 'all', label: '全部' }, ...categories.filter(c => used.has(c.id))]
  }, [categories, templates])
  const current = tabs.some(t => t.id === tab) ? tab : 'all'
  const shown = current === 'all' ? templates : templates.filter(t => t.category === current)

  function onTabKey(e, i) {
    const keys = { ArrowRight: 1, ArrowLeft: -1 }
    let next = -1
    if (keys[e.key]) next = (i + keys[e.key] + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    setTab(tabs[next].id)
    tabRefs.current[tabs[next].id]?.focus()
  }

  return (
    <section className="fh-section" aria-labelledby="fh-tpl-title" data-tour="flows-templates">
      <div className="fh-section-head">
        <h2 id="fh-tpl-title" className="fh-h2">从模板开始</h2>
        <p className="fh-section-note">挑一个改一改，最快上手</p>
      </div>
      {state.status === 'loading' ? <Skeleton /> : state.status === 'error' ? (
        <div className="fh-inline-err" role="alert">
          <p>{state.error || '模板暂时没加载出来'}</p>
          <button type="button" className="jv-btn jv-btn--sm" onClick={onRetry}>重新加载</button>
        </div>
      ) : !templates.length ? (
        <p className="fh-muted">暂时还没有模板，可以用上面的一句话生成，或者新建一个空白流程。</p>
      ) : (
        <>
          {tabs.length > 2 ? (
            <div className="fh-tabs" role="tablist" aria-label="模板分类">
              {tabs.map((t, i) => (
                <button key={t.id} ref={el => { tabRefs.current[t.id] = el }} type="button" role="tab"
                  id={`fh-tab-${t.id}`} aria-selected={current === t.id} aria-controls="fh-tpl-panel"
                  tabIndex={current === t.id ? 0 : -1} className={`fh-tab${current === t.id ? ' is-on' : ''}`}
                  onClick={() => setTab(t.id)} onKeyDown={e => onTabKey(e, i)}>
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
          <div id="fh-tpl-panel" role={tabs.length > 2 ? 'tabpanel' : undefined}
            aria-labelledby={tabs.length > 2 ? `fh-tab-${current}` : undefined}>
            <ul className="fh-tpl-grid">
              {shown.map(t => <TemplateCard key={t.id} tpl={t} idx={idx} onPick={onPick} />)}
            </ul>
          </div>
        </>
      )}
    </section>
  )
}
