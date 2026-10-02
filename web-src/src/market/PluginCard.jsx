import { useCallback, useRef } from 'react'
import Icon from '../Icon.jsx'
import { flyToDock, useDragSource } from './dnd/index.jsx'
import { SOURCE_LABEL, badgesFor, blockReason, sourceOf } from './model.js'

/** 插件详情的地址：当前路径 + ?plugin=<id>（不新增顶层路由；可分享、可后退） */
export function detailHref(id) {
  if (typeof window === 'undefined') return `?plugin=${encodeURIComponent(id)}`
  const q = new URLSearchParams(window.location.search)
  q.set('plugin', id)
  return `${window.location.pathname}?${q.toString()}`
}

/** 普通点击交给页面内打开详情；⌘ / Ctrl / 中键等照浏览器默认（新标签打开） */
export function linkClick(e, fn) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  fn()
}

/** 详情页用的完整徽标组（官方 / 社区 / MCP / 技能 / 专业版 / 需要配置） */
export function Badges({ plugin, className = '' }) {
  const list = badgesFor(plugin)
  return (
    <span className={`jvm-badges ${className}`.trim()}>
      {list.map(b => <span key={b.id} className={`jvm-badge is-${b.tone}`}>{b.label}</span>)}
    </span>
  )
}

/**
 * 卡片上最多一个徽标（ChatGPT / Claude 目录的行卡几乎不放徽标），按优先级取第一个：
 * 需要配置 > 暂不可用 > 专业版 > MCP > 社区 / 插件源。「官方」不再显示（线上全是官方，是噪音）；
 * 技能 / 积木这类类型、「需绑定飞书」这类前置条件只在详情里出现。
 */
export function keyBadge(p) {
  if (p.status === 'needs_config') return { id: 'config', label: '需要配置', tone: 'warn' }
  if (p.status === 'unavailable') return { id: 'off', label: '暂不可用', tone: 'muted' }
  if (p.tier === 'pro') return { id: 'pro', label: '专业版', tone: 'pro' }
  if (p.kind === 'mcp') return { id: 'mcp', label: 'MCP', tone: 'mcp' }
  const src = sourceOf(p)
  if (src !== 'official') return { id: src, label: SOURCE_LABEL[src], tone: 'community' }
  return null
}

/** 详情页底部的「加入工具箱」大按钮：已加入的可以移出；不可用 / 需要配置时禁用（已在工具箱里的仍可移出） */
export function AddButton({ plugin, picked, onToggle, size = '', label = '加入' }) {
  const blocked = blockReason(plugin)
  return (
    <button type="button" className={`jvm-add${picked ? ' is-on' : ''}${size ? ` is-${size}` : ''}`} aria-pressed={picked}
      disabled={!!blocked && !picked} title={blocked && !picked ? blocked : undefined}
      aria-label={picked ? `移出工具箱：${plugin.name}` : `加入工具箱：${plugin.name}`} onClick={() => onToggle(plugin.id)}>
      {picked ? <><Icon name="check" size={15} /><span>已加入</span></> : <><Icon name="plus" size={15} /><span>{label}</span></>}
    </button>
  )
}

/** 卡片右侧的轻量「＋」（32 圆，热区用伪元素扩到 44）：加入时从卡片「飞」进底部工具箱；已加入变成实心对勾，再点移出。
 *  pointerdown 不往上冒，免得在「＋」上按下也触发整卡拖动 */
export function PlusButton({ plugin, picked, onToggle, fromRef, describedBy }) {
  const blocked = blockReason(plugin)
  return (
    <button type="button" className={`jvm-plus${picked ? ' is-on' : ''}`} aria-pressed={picked}
      disabled={!!blocked && !picked} title={blocked && !picked ? blocked : picked ? '已在工具箱，点一下移出' : '加入工具箱'}
      aria-label={picked ? `移出工具箱：${plugin.name}` : `加入工具箱：${plugin.name}`} aria-describedby={describedBy}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        if (!picked) flyToDock(fromRef?.current || e.currentTarget, { icon: plugin.icon })
        onToggle(plugin.id)
      }}>
      <Icon name="plus" size={16} className="jvm-plus-add" />
      <Icon name="check" size={16} className="jvm-plus-done" />
    </button>
  )
}

/** 插件卡（紧凑行卡，三列：图标 44｜名称 + 一个徽标 / 一句话｜「＋」）。桌面是发丝边小卡，手机是无边框列表行。
 *  整卡可点开详情（名称是链接，铺满整卡）；整卡也是拖拽源，可直接拖进底部工具箱（手机长按）。
 *  已加入：边框换成 40% 强调色，图标右下角挂一个小对勾，不再整卡铺色。 */
export default function PluginCard({ plugin, picked, onToggle, onOpen }) {
  const p = plugin
  const ref = useRef(null)
  const blocked = blockReason(p)
  const badge = keyBadge(p)
  const { dragProps, isDragging } = useDragSource({ id: p.id, ids: [p.id], kind: 'plugin' })
  const { className: dragClass = '', ref: dragRef, ...drag } = dragProps || {}
  const setRef = useCallback(el => {
    ref.current = el
    if (typeof dragRef === 'function') dragRef(el)
    else if (dragRef && typeof dragRef === 'object') dragRef.current = el
  }, [dragRef])
  return (
    <article {...drag} ref={setRef} data-plugin={p.id}
      className={`jvm-card${picked ? ' is-picked' : ''}${blocked ? ' is-off' : ''}${isDragging ? ' is-dragging' : ''} ${dragClass}`.trim()}
      aria-label={p.name}>
      <span className="jvm-card-icon" aria-hidden="true">
        {p.icon}
        {picked ? <i className="jvm-card-check"><Icon name="check" size={9} /></i> : null}
      </span>
      <div className="jvm-card-body">
        <h4 className="jvm-card-name">
          <a className="jvm-card-link" href={detailHref(p.id)} onClick={e => linkClick(e, () => onOpen(p.id))} draggable={false}>{p.name}</a>
          {badge ? <span className={`jvm-badge is-${badge.tone}`}>{badge.label}</span> : null}
        </h4>
        {p.summary ? <p className="jvm-card-summary">{p.summary}</p> : null}
        {blocked ? <span id={`jvm-why-${p.id}`} className="sr-only">{p.status === 'needs_config' ? `需要管理员配置后才能加入：${blocked}` : `暂不可用：${blocked}`}</span> : null}
      </div>
      <PlusButton plugin={p} picked={picked} onToggle={onToggle} fromRef={ref} describedBy={blocked ? `jvm-why-${p.id}` : undefined} />
    </article>
  )
}
