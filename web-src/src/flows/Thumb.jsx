import { useMemo } from 'react'
import { chainLabel, thumbLayout } from './flowkit.js'

/* 流程缩略图：由节点图直接画（自写，不引画布库）。节点 = 小圆角矩形（左侧色条标类型），连线 = 右出左进的曲线。
 * size：card（列表卡片）· lg（预览弹层，节点里写图标与名字）。 */

const SIZES = {
  card: { w: 360, h: 128, pad: 16, maxScale: 0.42, minChars: 4 },
  lg: { w: 600, h: 180, pad: 20, maxScale: 0.62, minChars: 2 },
}

function clipText(s, n) {
  const chars = [...String(s || '')]
  if (n <= 0) return ''
  return chars.length > n ? `${chars.slice(0, Math.max(1, n - 1)).join('')}…` : chars.join('')
}

export default function Thumb({ graph, idx, size = 'card', className = '', label = '' }) {
  const conf = SIZES[size] || SIZES.card
  const lay = useMemo(() => thumbLayout(graph, conf, idx), [graph, conf, idx])
  const aria = label || `流程图：${chainLabel(graph, idx)}`
  return (
    <svg className={`fh-thumb fh-thumb--${size}${className ? ` ${className}` : ''}`} viewBox={`0 0 ${lay.w} ${lay.h}`}
      role="img" aria-label={aria} preserveAspectRatio="xMidYMid meet">
      <g className="fh-thumb-edges">
        {lay.edges.map(e => <path key={e.id} d={e.d} />)}
      </g>
      {lay.nodes.map(n => {
        const r = Math.min(8, n.h / 3)
        const font = Math.min(13, Math.max(7, n.h * 0.36))
        const showIcon = n.h >= 10
        const textX = n.x + Math.max(4, n.h * 0.22) + 3 + font * 1.05 + 4
        const room = Math.floor((n.x + n.w - textX - 4) / font)
        const title = showIcon && room >= conf.minChars ? clipText(n.name, room) : ''
        // 写得下名字：图标靠左、名字跟在后面；写不下：只在正中放图标
        const iconX = title ? n.x + Math.max(4, n.h * 0.22) + 3 : n.x + n.w / 2 - font * 0.55
        return (
          <g key={n.id} className="fh-thumb-node" data-tone={n.tone}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={r} />
            <rect className="fh-thumb-bar" x={n.x} y={n.y + n.h * 0.22} width={Math.max(2, n.h * 0.08)} height={n.h * 0.56} rx="1" />
            {showIcon ? (
              <text x={iconX} y={n.y + n.h / 2} fontSize={font} dominantBaseline="central" aria-hidden="true">{n.icon}</text>
            ) : null}
            {title ? (
              <text className="fh-thumb-text" x={textX} y={n.y + n.h / 2} fontSize={font * 0.92} dominantBaseline="central" aria-hidden="true">{title}</text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

/** 节点小图标串（模板卡片用）：🚩 › 🌤️ › ✨ › 🏁，太长折叠成「+3」 */
export function IconChain({ nodes, max = 6, label }) {
  const shown = nodes.length > max ? nodes.slice(0, max - 1) : nodes
  const rest = nodes.length - shown.length
  return (
    <span className="fh-chain" role="img" aria-label={label}>
      {shown.map((n, i) => (
        <span key={n.id || i} className="fh-chain-item" data-tone={n.tone}>
          {i ? <i className="fh-chain-wire" aria-hidden="true" /> : null}
          <span className="fh-chain-icon" aria-hidden="true">{n.icon}</span>
        </span>
      ))}
      {rest > 0 ? <span className="fh-chain-more" aria-hidden="true">+{rest}</span> : null}
    </span>
  )
}
