import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon.jsx'
import PluginCard from './PluginCard.jsx'
import { KIND_FILTERS, SOURCE_FILTERS, filterPlugins, searchPlugins } from './model.js'
import { useMedia } from './useMedia.js'

/** 手机上「筛选」是底部抽屉 */
const SHEET = '(max-width: 639px)'

/** 总览里每个分类先露几行，其余点「全部」展开（大目录也不必一路滑到底） */
export const GROUP_PREVIEW = 6

export const NO_FILTERS = { cat: 'all', source: 'all', kind: 'all' }

/** 插件源：源里的插件逐个列出，已装的就是普通插件行，没装的给「安装」（仅 Owner 看得到） */
function SourceList({ source, byId, picked, onToggle, onOpen, onInstall }) {
  return (
    <section className="jvm-group" aria-label={source.display_name || source.name}>
      <p className="jvm-group-note">来自插件源「{source.display_name || source.name}」，装好后和其他插件一样加入工具箱。</p>
      <div className="jvm-grid">
        {source.plugins.map(item => {
          const installed = item.installed ? byId.get(item.id) : null
          if (installed) {
            return <PluginCard key={item.name} plugin={installed} picked={picked.has(installed.id)} onToggle={onToggle} onOpen={onOpen} />
          }
          return (
            <article key={item.name} className="jvm-card is-remote" aria-label={item.display_name || item.name}>
              <span className="jvm-card-icon" aria-hidden="true">🧩</span>
              <div className="jvm-card-body">
                <h4 className="jvm-card-name">{item.display_name || item.name}<span className="jvm-badge is-muted">未安装</span></h4>
                {item.description || item.note ? <p className="jvm-card-summary">{item.note || item.description}</p> : null}
              </div>
              <button type="button" className="jvm-install" disabled={item.id_taken} onClick={() => onInstall(source.id, item.name)}
                aria-label={`预览安装：${item.display_name || item.name}`}>
                {item.id_taken ? '同名已装' : '安装'}
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

/** 分类页签条吸住顶栏时才铺底色（没吸住时透明，不在页面中间留一条色带） */
function useStuck(ref) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = ref.current
    const scroller = el?.closest('.jvm')
    if (!el || !scroller) return undefined
    let frame = 0
    const check = () => {
      frame = 0
      const top = parseFloat(getComputedStyle(el).top) || 0
      setStuck(el.getBoundingClientRect().top <= top + 0.5 && scroller.scrollTop > 0)
    }
    const on = () => { if (!frame) frame = requestAnimationFrame(check) }
    check()
    scroller.addEventListener('scroll', on, { passive: true })
    return () => { scroller.removeEventListener('scroll', on); cancelAnimationFrame(frame) }
  }, [ref])
  return stuck
}

/** 分段控件（单选）：「全部」+ 各项 */
function Segmented({ label, options, value, onChange }) {
  return (
    <div className="jvm-filter-row">
      <span className="jvm-filter-label" aria-hidden="true">{label}</span>
      <div className="jvm-seg" role="group" aria-label={`按${label}`}>
        {[{ id: 'all', name: '全部' }, ...options].map(o => (
          <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.name}</button>
        ))}
      </div>
    </div>
  )
}

/** 手机：底部抽屉 + 遮罩挂到市场根节点（.jvm）下——浏览区带入场动画，fixed 定位在它里面会被困住；
 *  桌面：就地挂在按钮下面的弹出层 */
function layer(sheet, dialog) {
  if (!sheet) return dialog
  const root = (typeof document !== 'undefined' && document.querySelector('.jvm')) || document.body
  return createPortal(<div className="jvm-filter-layer"><span className="jvm-filter-scrim" aria-hidden="true" />{dialog}</div>, root)
}

/** 「筛选」：来源与类型收进一个轻量弹层（不再同时摆三排）：桌面是 320 宽的弹出层，手机是底部抽屉。
 *  有生效的条件时按钮右上角一个强调色小圆点。点外面 / Esc 收起，焦点回到按钮 */
function FilterMenu({ filters, onFilters, sourceOpts, kinds }) {
  const [open, setOpen] = useState(false)
  const sheet = useMedia(SHEET)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const active = (filters.source !== 'all') + (filters.kind !== 'all')
  useEffect(() => {
    if (!open) return undefined
    const onDown = e => {
      if (!popRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false)
    }
    const onKey = e => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      btnRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  const set = patch => onFilters({ ...filters, ...patch })
  if (sourceOpts.length < 2 && kinds.length < 2) return null
  return (
    <div className="jvm-filter">
      <button ref={btnRef} type="button" className={`jvm-filter-btn${active ? ' is-active' : ''}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(v => !v)} aria-label={active ? `筛选（已选 ${active} 项）` : '筛选'}>
        <Icon name="sliders" size={16} /><span className="jvm-filter-text">筛选</span>{active ? <i className="jvm-filter-dot" aria-hidden="true" /> : null}
      </button>
      {open ? layer(sheet, (
        <div ref={popRef} className="jvm-filter-pop" role="dialog" aria-label="筛选">
          <p className="jvm-filter-head" aria-hidden="true">筛选</p>
          {sourceOpts.length > 1 ? <Segmented label="来源" options={sourceOpts} value={filters.source} onChange={source => set({ source })} /> : null}
          {kinds.length > 1 ? <Segmented label="类型" options={kinds} value={filters.kind} onChange={kind => set({ kind })} /> : null}
          <div className="jvm-filter-foot">
            <button type="button" className="jvm-text-btn" disabled={!active} onClick={() => set({ source: 'all', kind: 'all' })}>重置</button>
            <button type="button" className="jvm-btn jvm-btn--tint jvm-btn--sm" onClick={() => { setOpen(false); btnRef.current?.focus() }}>完成</button>
          </div>
        </div>
      )) : null}
    </div>
  )
}

/** 分类页签（主导航，吸顶，下划线样式，不带计数）+ 右端「筛选」。搜索或筛选后没有结果的分类收起 */
function FilterBar({ catalog, filters, onFilters, sources, kinds, pool }) {
  const barRef = useRef(null)
  const stuck = useStuck(barRef)
  const catCount = id => pool.filter(p => p.category === id).length
  const hasCommunity = catalog.plugins.some(p => !p.builtin)
  const sourceOpts = [...SOURCE_FILTERS.filter(s => s.id !== 'community' || hasCommunity || sources.length),
    ...sources.map(s => ({ id: `source:${s.id}`, name: s.display_name || s.name }))]
  const tab = (id, name) => (
    <button key={id} type="button" className="jvm-tab" aria-pressed={filters.cat === id}
      onClick={() => onFilters({ ...filters, cat: filters.cat === id && id !== 'all' ? 'all' : id })}>
      {name}
    </button>
  )
  return (
    <div className={`jvm-tabbar${stuck ? ' is-stuck' : ''}`} ref={barRef}>
      <div className="jvm-tabs-scroll" role="group" aria-label="按分类看">
        {tab('all', '全部')}
        {catalog.categories.filter(c => filters.cat === c.id || catCount(c.id) > 0).map(c => tab(c.id, c.name))}
      </div>
      <FilterMenu filters={filters} onFilters={onFilters} sourceOpts={sourceOpts} kinds={kinds} />
    </div>
  )
}

/**
 * 插件目录：分类页签（吸顶）→（总览时）精选一行 → 结果。
 *  - 总览（没搜索、没筛选）：按分类分组，每组先露 GROUP_PREVIEW 行，「全部 N 个」切到该分类；
 *  - 搜索或筛选：一张平铺的结果列表，带数量；空了给出路（清空 / 让 AI 推荐）。
 * 列表用「紧凑行」而不是大卡片：图标 + 名称 + 一句话 + 「＋」，一屏能看到的插件多一倍，拖起来也轻。
 */
export default function Catalog({ catalog, picked, onToggle, onOpen, query = '', onClearQuery, onAskAI, filters, onFilters,
  lead = null, sources = [], onInstallFromSource, onFirstHover }) {
  const pickedSet = useMemo(() => new Set(picked), [picked])
  const byId = useMemo(() => new Map(catalog.plugins.map(p => [p.id, p])), [catalog])
  const source = filters.source.startsWith('source:') ? sources.find(s => `source:${s.id}` === filters.source) : null
  const kinds = useMemo(() => KIND_FILTERS.filter(k => catalog.plugins.some(p => (p.kind === 'channel' ? 'tool' : p.kind) === k.id)), [catalog])
  const searched = useMemo(() => searchPlugins(catalog.plugins, query, catalog.categories), [catalog, query])
  const results = useMemo(() => (source ? [] : filterPlugins(searched, filters)), [searched, filters, source])
  // 页签上的数字：搜索 + 来源 + 类型都算上，只是不限分类
  const catPool = useMemo(() => filterPlugins(searched, { ...filters, cat: 'all', source: source ? 'all' : filters.source }), [searched, filters, source])
  const q = query.trim()
  const overview = !q && filters.cat === 'all' && filters.source === 'all' && filters.kind === 'all'
  const filtered = filters.cat !== 'all' || filters.source !== 'all' || filters.kind !== 'all'
  const card = p => <PluginCard key={p.id} plugin={p} picked={pickedSet.has(p.id)} onToggle={onToggle} onOpen={onOpen} />
  const catName = id => catalog.categories.find(c => c.id === id)?.name || ''

  let body
  if (source) {
    body = <SourceList source={source} byId={byId} picked={pickedSet} onToggle={onToggle} onOpen={onOpen} onInstall={onInstallFromSource} />
  } else if (overview) {
    body = catalog.categories.map(c => {
      const list = catalog.plugins.filter(p => p.category === c.id)
      if (!list.length) return null
      return (
        <section key={c.id} className="jvm-group" aria-labelledby={`jvm-g-${c.id}`}>
          <header className="jvm-group-head">
            <h3 id={`jvm-g-${c.id}`} className="jvm-group-title">{c.name}</h3>
            {list.length > GROUP_PREVIEW ? (
              <button type="button" className="jvm-more" onClick={() => onFilters({ ...filters, cat: c.id })}
                aria-label={`查看${c.name}的全部 ${list.length} 个插件`}>
                查看全部 {list.length}<Icon name="chevron" size={14} />
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
    const onlyCommunity = filters.source === 'community' && filters.cat === 'all' && filters.kind === 'all'
    body = (
      <div className="jvm-none" role="status">
        <span className="jvm-none-icon" aria-hidden="true">{q ? '🔍' : '🗂️'}</span>
        <p className="jvm-none-title">
          {q ? `没找到和「${q}」相关的插件` : onlyCommunity ? '还没有社区插件' : '这个组合下还没有插件'}
        </p>
        <p className="jvm-none-sub">
          {q ? '换个说法试试，或者让 AI 按这句话帮你挑一套。'
            : onlyCommunity ? '管理员可以在头像菜单的「插件管理」里，从 GitHub、Gitee 或 zip 导入。' : '换个分类或类型看看。'}
        </p>
        <div className="jvm-none-actions">
          {q && onAskAI ? (
            <button type="button" className="jvm-btn" onClick={() => onAskAI(q)}><Icon name="sparkles" size={16} />让 AI 按这句推荐</button>
          ) : null}
          {q ? <button type="button" className="jvm-text-btn" onClick={onClearQuery}>清空搜索</button> : null}
          {filtered ? <button type="button" className="jvm-text-btn" onClick={() => onFilters(NO_FILTERS)}>清除筛选</button> : null}
        </div>
      </div>
    )
  }

  const title = q ? `“${q}” 的结果` : filters.cat !== 'all' ? catName(filters.cat) || '插件' : '全部插件'
  const count = source ? `· ${source.plugins.length} 个` : overview ? '' : `· ${results.length} 个`
  // 第一次用鼠标悬停到卡片上：在工具箱上方提示一次「把卡片拖到这里，或点 +」
  const hover = e => {
    if (e.pointerType === 'mouse' && e.target.closest?.('.jvm-card:not(.is-remote), .jvm-bundle article')) onFirstHover?.()
  }
  return (
    <div className="jvm-browse" onPointerOver={onFirstHover ? hover : undefined}>
      <FilterBar catalog={catalog} filters={filters} onFilters={onFilters} sources={sources} kinds={kinds} pool={catPool} />
      {overview && lead ? lead : null}
      <section className={`jvm-catalog${overview && !source ? ' is-overview' : ''}`} id="jvm-catalog" aria-labelledby="jvm-catalog-title">
        <header className="jvm-catalog-head">
          <h2 id="jvm-catalog-title" className="jvm-catalog-title" tabIndex={-1}>
            <span className="jvm-catalog-name">{title}</span>{count ? <span className="jvm-catalog-n" aria-live="polite">{count}</span> : null}
          </h2>
          {filtered || q ? (
            <button type="button" className="jvm-text-btn" onClick={() => { onFilters(NO_FILTERS); if (q) onClearQuery?.() }}>
              {q ? '清空搜索和筛选' : '清除筛选'}
            </button>
          ) : null}
        </header>
        {body}
      </section>
    </div>
  )
}
