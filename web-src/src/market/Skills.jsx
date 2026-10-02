import { useState } from 'react'
import Icon from '../Icon.jsx'
import { requireText } from './model.js'

const KIND_TAG = { channel: '通道', step: '流程积木' }

/** 一张插件卡：图标、名称、一句话、专业版 / 需绑定提示，右侧「加入」开关 */
export function PluginCard({ plugin, picked, onToggle, showAvailability = false }) {
  const p = plugin
  const example = p.kind === 'tool' && p.examples[0]
  return (
    <article className={`jvm-card${picked ? ' is-picked' : ''}`} aria-label={p.name}>
      <span className="jvm-card-icon" aria-hidden="true">{p.icon}</span>
      <div className="jvm-card-body">
        <h4 className="jvm-card-name">
          {p.name}
          {p.tier === 'pro' ? <span className="jvm-badge is-pro">专业版</span> : null}
          {KIND_TAG[p.kind] ? <span className="jvm-badge">{KIND_TAG[p.kind]}</span> : null}
        </h4>
        {p.summary ? <p className="jvm-card-summary">{p.summary}</p> : null}
        {example ? <p className="jvm-card-example">“{example}”</p> : null}
        {p.requires.length || (showAvailability && !p.available) ? (
          <p className="jvm-card-req">
            {p.requires.map(requireText).join(' · ')}
            {showAvailability && !p.available ? `${p.requires.length ? ' · ' : ''}当前账号暂不可用` : ''}
          </p>
        ) : null}
      </div>
      <button type="button" className={`jvm-add${picked ? ' is-on' : ''}`} aria-pressed={picked}
        aria-label={picked ? `移出工具箱：${p.name}` : `加入工具箱：${p.name}`} onClick={() => onToggle(p.id)}>
        {picked ? <><Icon name="check" size={15} /><span>已加入</span></> : <><Icon name="plus" size={15} /><span>加入</span></>}
      </button>
    </article>
  )
}

/** 插件市场：分类筛选 + 按分类分组的插件卡 */
export default function Skills({ catalog, picked, onToggle, authed }) {
  const [cat, setCat] = useState('all')
  const groups = catalog.categories
    .filter(c => cat === 'all' || c.id === cat)
    .map(c => ({ ...c, plugins: catalog.plugins.filter(p => p.category === c.id) }))
  const pickedSet = new Set(picked)

  return (
    <section className="jvm-catalog" aria-labelledby="jvm-catalog-title">
      <header className="jvm-catalog-head">
        <h2 id="jvm-catalog-title" className="jvm-catalog-title">插件市场<span>{catalog.plugins.length}</span></h2>
        <p className="jvm-step-sub">点「加入」放进工具箱，随时可以拿掉。</p>
      </header>
      <div className="jvm-cats" role="group" aria-label="按分类看">
        <button type="button" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>全部</button>
        {catalog.categories.map(c => (
          <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{c.name}</button>
        ))}
      </div>
      {groups.map(g => (
        <section key={g.id} className="jvm-group" aria-label={g.name}>
          <h3 className="jvm-group-title">{g.name}<span>{g.plugins.length}</span></h3>
          <div className="jvm-grid">
            {g.plugins.map(p => (
              <PluginCard key={p.id} plugin={p} picked={pickedSet.has(p.id)} onToggle={onToggle} showAvailability={authed} />
            ))}
          </div>
        </section>
      ))}
    </section>
  )
}
