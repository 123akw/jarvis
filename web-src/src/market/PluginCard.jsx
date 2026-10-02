import Icon from '../Icon.jsx'
import { badgesFor, blockReason, requireText } from './model.js'

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

export function Badges({ plugin, className = '' }) {
  const list = badgesFor(plugin)
  return (
    <span className={`jvm-badges ${className}`.trim()}>
      {list.map(b => <span key={b.id} className={`jvm-badge is-${b.tone}`}>{b.label}</span>)}
    </span>
  )
}

/** 「加入工具箱」开关：已加入的可以移出；不可用 / 需要配置时禁用（已在工具箱里的仍可移出） */
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

/** 一张插件卡：图标、名称、一句话、徽标（官方 / 社区 / MCP / 技能 / 专业版 / 需要配置），右侧「加入」。
 *  整张卡可点开详情（名称是链接，铺满整卡）；「加入」按钮浮在上面单独可点。 */
export default function PluginCard({ plugin, picked, onToggle, onOpen, showAvailability = false }) {
  const p = plugin
  const blocked = blockReason(p)
  const reqs = p.requires.map(requireText)
  if (showAvailability && !p.available && !blocked) reqs.push('当前账号暂不可用')
  return (
    <article className={`jvm-card${picked ? ' is-picked' : ''}${blocked ? ' is-off' : ''}`} aria-label={p.name}>
      <span className="jvm-card-icon" aria-hidden="true">{p.icon}</span>
      <div className="jvm-card-body">
        <h4 className="jvm-card-name">
          <a className="jvm-card-link" href={detailHref(p.id)} onClick={e => linkClick(e, () => onOpen(p.id))}>{p.name}</a>
        </h4>
        {p.summary ? <p className="jvm-card-summary">{p.summary}</p> : null}
        <Badges plugin={p} />
        {blocked ? <p className="jvm-card-req is-off">{p.status === 'needs_config' ? '需要管理员配置后才能用' : `暂不可用：${blocked}`}</p>
          : reqs.length ? <p className="jvm-card-req">{reqs.join(' · ')}</p> : null}
      </div>
      <AddButton plugin={p} picked={picked} onToggle={onToggle} />
    </article>
  )
}
