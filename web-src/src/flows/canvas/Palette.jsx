import { useState } from 'react'
import Icon from '../../Icon.jsx'
import { MARKET_PATH } from '../../routes.js'
import { TYPE_INFO } from '../graph.js'
import { needsPlugin, searchCatalog, unavailableReason } from './catalog.js'
import { NodeIcon } from './glyphs.jsx'

export const DND_TYPE = 'application/x-jv-flow-node'
const RECENT_KEY = 'jvf-recent-nodes'

/** 最近用过的节点（只存目录 key，最多 5 个；存储不可用时当没有） */
export function readRecent() {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(k => typeof k === 'string').slice(0, 5) : [] } catch { return [] }
}
export function rememberRecent(key) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...readRecent().filter(k => k !== key)].slice(0, 5))) } catch { /* 隐私模式 */ }
}

/** 一项节点：图标、名字、一句话；不可用的灰显并说原因，给「去加插件」 */
function Item({ item, onPick, draggable, blocked, prefix = 'fc-pal' }) {
  const why = unavailableReason(item) || blocked
  const off = !!why
  const descId = `${prefix}-why-${item.key.replace(/[^A-Za-z0-9_-]/g, '_')}`
  return (
    <li className={`fc-pal-li${off ? ' is-off' : ''}`}>
      <button type="button" className="fc-pal-item" aria-disabled={off || undefined}
        aria-describedby={off ? (blocked ? `${prefix}-blocked` : descId) : undefined}
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
          {item.summary || item.plugin_name ? (
            <span className="fc-pal-sum">{item.type === 'tool' && item.plugin_name ? `${item.plugin_name}${item.summary ? ' · ' : ''}` : ''}{item.summary}</span>
          ) : null}
        </span>
      </button>
      {off && !blocked ? (
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
export function NodeList({ index, onPick, draggable = false, blocked = '', autoFocus = false, exclude = null, idPrefix = 'fc-pal', recent = true }) {
  const [query, setQuery] = useState('')
  const keep = it => !exclude || !exclude(it)
  let groups = searchCatalog(index, query)
    .map(g => (exclude ? { ...g, items: g.items.filter(keep), sections: g.sections?.map(p => ({ ...p, items: p.items.filter(keep) })).filter(p => p.items.length) } : g))
    .filter(g => g.items.length)
  // 「最近用过」：没在搜索时放最前面
  const recentItems = recent && !query.trim() ? readRecent().map(k => index.byKey.get(k)).filter(it => it && it.available !== false && keep(it)) : []
  if (recentItems.length) groups = [{ id: 'recent', label: '最近用过', hint: '', items: recentItems }, ...groups]
  const pick = it => { rememberRecent(it.key); onPick(it) }
  const lock = blocked ? <p className="fc-pal-lock" id={`${idPrefix}-blocked`} role="status">{blocked}</p> : null
  return (
    <div className="fc-pal-list">
      <label className="fc-pal-search">
        <Icon name="search" size={15} />
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜节点、插件、技能"
          aria-label="搜节点" autoFocus={autoFocus} />
      </label>
      {lock}
      {groups.length ? groups.map(g => (
        <section key={g.id} className="fc-pal-group" aria-labelledby={`${idPrefix}-${g.id}`}>
          <h3 className="fc-pal-title" id={`${idPrefix}-${g.id}`}>{g.label}{g.hint ? <small>{g.hint}</small> : null}</h3>
          {g.sections ? g.sections.map(p => (
            <div key={p.id} className="fc-pal-plugin">
              <h4 className="fc-pal-pname">{p.label}</h4>
              <ul className="fc-pal-ul">
                {p.items.map(it => <Item key={it.key} item={it} onPick={pick} draggable={draggable} blocked={blocked} prefix={idPrefix} />)}
              </ul>
            </div>
          )) : (
            <ul className="fc-pal-ul">
              {g.items.map(it => <Item key={`${g.id}-${it.key}`} item={it} onPick={pick} draggable={draggable} blocked={blocked} prefix={idPrefix} />)}
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
