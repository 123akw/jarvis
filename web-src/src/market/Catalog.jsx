import { useMemo } from 'react'
import Icon from '../Icon.jsx'
import PluginCard from './PluginCard.jsx'
import { KIND_FILTERS, SOURCE_FILTERS, filterPlugins, searchPlugins } from './model.js'

/** 总览里每个分类先露几张，其余点「全部」展开（大目录也不必一路滑到底） */
export const GROUP_PREVIEW = 6

/** 插件源页签：源里的插件逐个列出，已装的就是普通插件卡，没装的给「安装」（仅 Owner 看得到） */
function SourceList({ source, byId, picked, onToggle, onOpen, authed, onInstall }) {
  return (
    <section className="jvm-group" aria-label={source.display_name || source.name}>
      <p className="jvm-group-note">来自插件源「{source.display_name || source.name}」，装好后和其他插件一样加入工具箱。</p>
      <div className="jvm-grid">
        {source.plugins.map(item => {
          const installed = item.installed ? byId.get(item.id) : null
          if (installed) {
            return <PluginCard key={item.name} plugin={installed} picked={picked.has(installed.id)} onToggle={onToggle} onOpen={onOpen} showAvailability={authed} />
          }
          return (
            <article key={item.name} className="jvm-card is-remote" aria-label={item.display_name || item.name}>
              <span className="jvm-card-icon" aria-hidden="true">🧩</span>
              <div className="jvm-card-body">
                <h4 className="jvm-card-name">{item.display_name || item.name}</h4>
                {item.description ? <p className="jvm-card-summary">{item.description}</p> : null}
                <span className="jvm-badges"><span className="jvm-badge is-community">插件源</span><span className="jvm-badge is-muted">未安装</span></span>
                {item.note ? <p className="jvm-card-req is-off">{item.note}</p> : null}
              </div>
              <button type="button" className="jvm-add" disabled={item.id_taken} onClick={() => onInstall(source.id, item.name)}
                aria-label={`预览安装：${item.display_name || item.name}`}>
                <Icon name="plus" size={15} /><span>{item.id_taken ? '同名已装' : '安装'}</span>
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function Chip({ on, onClick, children, count }) {
  return (
    <button type="button" className="jvm-chip" aria-pressed={on} onClick={onClick}>
      {children}{count !== undefined ? <span className="jvm-chip-n">{count}</span> : null}
    </button>
  )
}

/** 筛选条：分类（吸顶）+ 来源 + 类型；单选，再点一次取消 */
function FilterBar({ catalog, filters, onFilters, sources, kinds, pool }) {
  const set = patch => onFilters({ ...filters, ...patch })
  const toggle = (key, id) => set({ [key]: filters[key] === id ? 'all' : id })
  const catCount = id => pool.filter(p => p.category === id).length
  const hasCommunity = catalog.plugins.some(p => !p.builtin)
  const sourceOpts = [...SOURCE_FILTERS.filter(s => s.id !== 'community' || hasCommunity || sources.length),
    ...sources.map(s => ({ id: `source:${s.id}`, name: s.display_name || s.name }))]
  return (
    <div className="jvm-filters">
      <div className="jvm-cats" role="group" aria-label="按分类看">
        <Chip on={filters.cat === 'all'} onClick={() => set({ cat: 'all' })}>全部</Chip>
        {catalog.categories.map(c => (
          <Chip key={c.id} on={filters.cat === c.id} onClick={() => toggle('cat', c.id)} count={catCount(c.id)}>{c.name}</Chip>
        ))}
      </div>
      <div className="jvm-facets">
        {sourceOpts.length > 1 ? (
          <div className="jvm-seg" role="group" aria-label="按来源">
            {sourceOpts.map(s => <Chip key={s.id} on={filters.source === s.id} onClick={() => toggle('source', s.id)}>{s.name}</Chip>)}
          </div>
        ) : null}
        {kinds.length > 1 ? (
          <div className="jvm-seg" role="group" aria-label="按类型">
            {kinds.map(k => <Chip key={k.id} on={filters.kind === k.id} onClick={() => toggle('kind', k.id)}>{k.name}</Chip>)}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export const NO_FILTERS = { cat: 'all', source: 'all', kind: 'all' }

/**
 * 插件目录：筛选条 + 结果。
 *  - 总览（没搜索、没筛选）：按分类分组，每组先露 GROUP_PREVIEW 张，「全部 N 个」切到该分类；
 *  - 搜索或筛选：一张平铺的结果网格，带数量；空了给出路（清空 / 让 AI 推荐）。
 */
export default function Catalog({ catalog, picked, onToggle, onOpen, query = '', onClearQuery, onAskAI, filters, onFilters,
  authed, admin = null, sources = [], onInstallFromSource }) {
  const pickedSet = useMemo(() => new Set(picked), [picked])
  const byId = useMemo(() => new Map(catalog.plugins.map(p => [p.id, p])), [catalog])
  const source = filters.source.startsWith('source:') ? sources.find(s => `source:${s.id}` === filters.source) : null
  const kinds = useMemo(() => KIND_FILTERS.filter(k => catalog.plugins.some(p => (p.kind === 'channel' ? 'tool' : p.kind) === k.id)), [catalog])
  const searched = useMemo(() => searchPlugins(catalog.plugins, query, catalog.categories), [catalog, query])
  const results = useMemo(() => (source ? [] : filterPlugins(searched, filters)), [searched, filters, source])
  const q = query.trim()
  const overview = !q && filters.cat === 'all' && filters.source === 'all' && filters.kind === 'all'
  const filtered = filters.cat !== 'all' || filters.source !== 'all' || filters.kind !== 'all'
  const card = p => <PluginCard key={p.id} plugin={p} picked={pickedSet.has(p.id)} onToggle={onToggle} onOpen={onOpen} showAvailability={authed} />
  const catName = id => catalog.categories.find(c => c.id === id)?.name || ''

  let body
  if (source) {
    body = <SourceList source={source} byId={byId} picked={pickedSet} onToggle={onToggle} onOpen={onOpen} authed={authed} onInstall={onInstallFromSource} />
  } else if (overview) {
    body = catalog.categories.map(c => {
      const list = catalog.plugins.filter(p => p.category === c.id)
      if (!list.length) return null
      return (
        <section key={c.id} className="jvm-group" aria-labelledby={`jvm-g-${c.id}`}>
          <header className="jvm-group-head">
            <h3 id={`jvm-g-${c.id}`} className="jvm-group-title">{c.name}<span>{list.length}</span></h3>
            {list.length > GROUP_PREVIEW ? (
              <button type="button" className="jvm-more" onClick={() => onFilters({ ...filters, cat: c.id })}
                aria-label={`查看${c.name}的全部 ${list.length} 个插件`}>
                全部 {list.length} 个<Icon name="chevron" size={14} />
              </button>
            ) : null}
          </header>
          <div className="jvm-grid">{list.slice(0, GROUP_PREVIEW).map(card)}</div>
        </section>
      )
    })
  } else if (results.length) {
    body = (
      <section className="jvm-group" aria-label="结果">
        <div className="jvm-grid">{results.map(card)}</div>
      </section>
    )
  } else {
    body = (
      <div className="jvm-none" role="status">
        <span className="jvm-none-icon" aria-hidden="true">{q ? '🔍' : '🗂️'}</span>
        <p className="jvm-none-title">
          {q ? `没找到和「${q}」相关的插件` : filters.source === 'community' ? '还没有社区插件' : '这个组合下还没有插件'}
        </p>
        <p className="jvm-none-sub">
          {q ? '换个说法试试，或者让 AI 按这句话帮你挑一套。'
            : filters.source === 'community' && admin ? '点「导入插件」，从 GitHub、Gitee 或 zip 装一个。' : '换个分类或类型看看。'}
        </p>
        <div className="jvm-none-actions">
          {q && onAskAI ? (
            <button type="button" className="jvm-btn" onClick={() => onAskAI(q)}><Icon name="sparkles" size={16} />让 AI 按这句推荐</button>
          ) : null}
          {q ? <button type="button" className="jvm-btn jvm-btn--ghost" onClick={onClearQuery}>清空搜索</button> : null}
          {filtered ? <button type="button" className="jvm-btn jvm-btn--ghost" onClick={() => onFilters(NO_FILTERS)}>清除筛选</button> : null}
        </div>
      </div>
    )
  }

  const title = q ? '搜索结果' : filters.cat !== 'all' ? catName(filters.cat) || '插件' : '全部插件'
  return (
    <section className="jvm-catalog" id="jvm-catalog" aria-labelledby="jvm-catalog-title">
      <header className="jvm-catalog-head">
        <h2 id="jvm-catalog-title" className="jvm-catalog-title" tabIndex={-1}>
          {title}<span aria-live="polite">{source ? source.plugins.length : overview ? catalog.plugins.length : `${results.length} 个`}</span>
        </h2>
        {filtered || q ? (
          <button type="button" className="jvm-link" onClick={() => { onFilters(NO_FILTERS); if (q) onClearQuery?.() }}>
            {q ? '清空搜索和筛选' : '清除筛选'}
          </button>
        ) : <p className="jvm-catalog-sub">点卡片看详情，点「加入」放进工具箱。</p>}
        {admin ? <div className="jvm-admin-entry" role="group" aria-label="插件管理（管理员）">{admin}</div> : null}
      </header>
      <FilterBar catalog={catalog} filters={filters} onFilters={onFilters} sources={sources} kinds={kinds} pool={searched} />
      {body}
    </section>
  )
}
