import { useMemo, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { chainLabel, nodeInfo, orderNodes, requirements } from './flowkit.js'
import { IconChain } from './Thumb.jsx'

/* 模板库（参考 Dify 探索页、Langflow 欢迎页的「从模板开始」）：
 *   默认只放 3 张精选（服务端标 featured 的优先，否则取前 3 个）+「全部模板 ›」；展开后是分类页签 + 全部卡片。
 *   卡片：图标、名称、一句话、节点链小图标（最多 5 个，多的写「+2」）、「需要准备」小标签（满足 = 中性，没满足 = 橙色）。 */

export const FEATURED = 3

export function featured(templates) {
  const marked = templates.filter(t => t.featured)
  return (marked.length ? marked : templates).slice(0, FEATURED)
}

function TemplateCard({ tpl, idx, feishu, onPick }) {
  const nodes = useMemo(() => orderNodes(tpl.graph).map(n => ({ id: n.id, ...nodeInfo(n, idx) })), [tpl.graph, idx])
  const reqs = requirements(tpl, idx, feishu)
  return (
    <li>
      <button type="button" className="fh-tpl" onClick={() => onPick(tpl)} aria-haspopup="dialog">
        <span className="fh-tpl-head">
          <span className="fh-tpl-icon" aria-hidden="true">{tpl.icon || '🧩'}</span>
          <span className="fh-tpl-name">{tpl.name}</span>
        </span>
        {tpl.summary ? <span className="fh-tpl-sum">{tpl.summary}</span> : null}
        <IconChain nodes={nodes} label={`步骤：${chainLabel(tpl.graph, idx)}`} />
        {reqs.length ? (
          <span className="fh-tpl-tags">
            {reqs.slice(0, 2).map(r => <span key={r.key} className={`fh-tag${r.ok === false ? ' is-warn' : ''}`}>{r.tag}</span>)}
            {reqs.length > 2 ? <span className="fh-tag">+{reqs.length - 2}</span> : null}
          </span>
        ) : null}
      </button>
    </li>
  )
}

function Skeleton() {
  return (
    <ul className="fh-tpl-grid" aria-hidden="true">
      {[0, 1, 2].map(i => <li key={i}><div className="fh-tpl fh-skel-card"><i /><i /><i /></div></li>)}
    </ul>
  )
}

export default function Templates({ state, idx, feishu, onPick, onRetry }) {
  const [all, setAll] = useState(false)
  const [tab, setTab] = useState('all')
  const tabRefs = useRef({})
  const { categories, templates } = state
  const tabs = useMemo(() => {
    const used = new Set(templates.map(t => t.category))
    return [{ id: 'all', label: '全部' }, ...categories.filter(c => used.has(c.id))]
  }, [categories, templates])
  const current = tabs.some(t => t.id === tab) ? tab : 'all'
  const picks = useMemo(() => featured(templates), [templates])
  const shown = !all ? picks : current === 'all' ? templates : templates.filter(t => t.category === current)
  const hasTabs = all && tabs.length > 2
  const more = templates.length > picks.length

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
        <h2 id="fh-tpl-title" className="fh-h2">
          从模板开始{all && templates.length ? <span className="fh-count">{templates.length}</span> : null}
        </h2>
        {state.status === 'ready' && more ? (
          <button type="button" className="fh-link fh-more-link" aria-expanded={all} aria-controls="fh-tpl-panel"
            onClick={() => setAll(v => !v)}>
            {all ? '收起' : <>全部模板（{templates.length}）<Icon name="chevron" size={14} /></>}
          </button>
        ) : null}
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
          {hasTabs ? (
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
          <div id="fh-tpl-panel" role={hasTabs ? 'tabpanel' : undefined} aria-labelledby={hasTabs ? `fh-tab-${current}` : undefined}>
            <ul className="fh-tpl-grid">
              {shown.map(t => <TemplateCard key={t.id} tpl={t} idx={idx} feishu={feishu} onPick={onPick} />)}
            </ul>
          </div>
        </>
      )}
    </section>
  )
}
