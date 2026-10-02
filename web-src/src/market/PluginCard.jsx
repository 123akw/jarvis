import Icon from '../Icon.jsx'
import { flyToDock, useDragSource } from './dnd/index.jsx'
import { SOURCE_LABEL, blockReason, sourceOf } from './model.js'

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

/** 卡片右侧的轻量「＋」（32 圆，热区用伪元素扩到 44）：加入时从卡片图标「飞」进底部工具箱；已加入变成实心对勾，再点移出。
 *  （拖拽源会忽略卡片里按钮上的按下，「＋」不会触发整卡拖动） */
export function PlusButton({ plugin, picked, onToggle, describedBy }) {
  const blocked = blockReason(plugin)
  return (
    <button type="button" className={`jvm-plus${picked ? ' is-on' : ''}`} aria-pressed={picked}
      disabled={!!blocked && !picked} title={blocked && !picked ? blocked : picked ? '已在工具箱，点一下移出' : '加入工具箱'}
      aria-label={picked ? `移出工具箱：${plugin.name}` : `加入工具箱：${plugin.name}`} aria-describedby={describedBy}
      onClick={e => {
        if (!picked) flyToDock(e.currentTarget, { icon: plugin.icon })
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
  const blocked = blockReason(p)
  const badge = keyBadge(p)
  // dragProps 带 onPointerDown / onPointerEnter / onDragStart 与 data-dnd*：之后不要再在根元素上写同名事件
  const { dragProps } = useDragSource({ id: p.id, ids: [p.id], kind: 'plugin', icon: p.icon, label: p.name })
  return (
    <article {...dragProps} data-plugin={p.id} aria-label={p.name}
      className={`jvm-card${picked ? ' is-picked' : ''}${blocked ? ' is-off' : ''}`}>
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
      <PlusButton plugin={p} picked={picked} onToggle={onToggle} describedBy={blocked ? `jvm-why-${p.id}` : undefined} />
    </article>
  )
}
