import { useState } from 'react'
import Icon from '../../Icon.jsx'
import { MARKET_PATH } from '../../routes.js'
import { TYPE_INFO } from '../graph.js'
import { needsPlugin, searchCatalog, unavailableReason } from './catalog.js'
import { NodeIcon } from './glyphs.jsx'

export const DND_TYPE = 'application/x-jv-flow-node'

/** 一项节点：图标、名字、一句话；不可用的灰显并说原因，给「去加插件」 */
function Item({ item, onPick, draggable, blocked }) {
  const why = unavailableReason(item) || blocked
  const off = !!why
  const descId = `fc-pal-why-${item.key.replace(/[^A-Za-z0-9_-]/g, '_')}`
  return (
    <li className={`fc-pal-li${off ? ' is-off' : ''}`}>
      <button type="button" className="fc-pal-item" aria-disabled={off || undefined}
        aria-describedby={off ? descId : undefined}
        draggable={draggable && !off ? true : undefined}
        onDragStart={draggable && !off ? e => {
          e.dataTransfer.setData(DND_TYPE, item.key)
          e.dataTransfer.setData('text/plain', item.title)
          e.dataTransfer.effectAllowed = 'move'
        } : undefined}
        onClick={() => { if (!off) onPick(item) }}
        title={off ? why : `${item.summary || TYPE_INFO[item.type]?.hint || ''}${draggable ? '（拖到画布，或点一下接在选中节点后面）' : ''}`}>
        <NodeIcon type={item.type} emoji={item.icon} />
        <span className="fc-pal-text">
          <b>{item.title}</b>
          {item.summary ? <span className="fc-pal-sum">{item.summary}</span> : null}
        </span>
      </button>
      {off ? (
        <p className="fc-pal-why" id={descId}>
          {why}
          {!blocked && needsPlugin(item) ? (
            <a className="fc-pal-add" href={MARKET_PATH} target="_blank" rel="noopener noreferrer">去加插件<Icon name="chevron" size={12} /></a>
          ) : null}
        </p>
      ) : null}
    </li>
  )
}

/**
 * 节点清单：搜索 + 分组（基础 / 插件工具（按插件）/ 技能 / 积木）。
 * 左侧面板、节点出口的「+」快捷面板、手机底部面板共用。
 */
export function NodeList({ index, onPick, draggable = false, blocked = '', autoFocus = false, exclude = null, idPrefix = 'fc-pal' }) {
  const [query, setQuery] = useState('')
  const groups = searchCatalog(index, query)
    .map(g => (exclude ? { ...g, items: g.items.filter(it => !exclude(it)), plugins: g.plugins?.map(p => ({ ...p, items: p.items.filter(it => !exclude(it)) })).filter(p => p.items.length) } : g))
    .filter(g => g.items.length)
  return (
    <div className="fc-pal-list">
      <label className="fc-pal-search">
        <Icon name="search" size={15} />
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜节点、插件、技能"
          aria-label="搜节点" autoFocus={autoFocus} />
      </label>
      {groups.length ? groups.map(g => (
        <section key={g.id} className="fc-pal-group" aria-labelledby={`${idPrefix}-${g.id}`}>
          <h3 className="fc-pal-title" id={`${idPrefix}-${g.id}`}>{g.label}{g.hint ? <small>{g.hint}</small> : null}</h3>
          {g.plugins ? g.plugins.map(p => (
            <div key={p.id || '_'} className="fc-pal-plugin">
              <h4 className="fc-pal-pname">{p.icon ? <span aria-hidden="true">{p.icon}</span> : null}{p.name}</h4>
              <ul className="fc-pal-ul">
                {p.items.map(it => <Item key={it.key} item={it} onPick={onPick} draggable={draggable} blocked={blocked} />)}
              </ul>
            </div>
          )) : (
            <ul className="fc-pal-ul">
              {g.items.map(it => <Item key={it.key} item={it} onPick={onPick} draggable={draggable} blocked={blocked} />)}
            </ul>
          )}
        </section>
      )) : <p className="fc-pal-empty">没有找到「{query}」相关的节点</p>}
    </div>
  )
}

/** 左侧节点面板 */
export default function Palette({ index, onPick, blocked, catalogError, onRetry }) {
  return (
    <aside className="fc-palette" aria-label="节点面板" data-tour="flow-palette">
      <div className="fc-palette-head">
        <h2>节点</h2>
        <p>拖到画布上，或点一下接在选中的节点后面</p>
      </div>
      {catalogError ? (
        <div className="fc-pal-err" role="alert">
          <p>插件和积木没加载出来，现在只能用基础节点。</p>
          <button type="button" className="jv-btn jv-btn--sm" onClick={onRetry}>重新加载</button>
        </div>
      ) : null}
      <NodeList index={index} onPick={onPick} draggable blocked={blocked} />
    </aside>
  )
}
