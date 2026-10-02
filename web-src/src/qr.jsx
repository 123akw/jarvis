import qrcode from 'qrcode-generator'

/** 文本 → 二维码矩阵（true=深色模块）。纠错等级 M：印在屏上被手指挡一点也扫得出 */
export function qrMatrix(text, level = 'M') {
  const qr = qrcode(0, level)
  qr.addData(String(text || ''), 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)))
}

/** 二维码的 SVG path（每个深色模块一个 1×1 方块，viewBox 含 quiet zone 边距） */
export function qrPath(text, { margin = 2, level = 'M' } = {}) {
  const m = qrMatrix(text, level)
  let d = ''
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + margin} ${r + margin}h1v1h-1z` }))
  return { d, size: m.length + margin * 2 }
}

/** 二维码组件：前景跟随 currentColor，背景默认白（深色主题下也要白底，手机相机才认得出） */
export function QrCode({ value, size = 160, background = '#fff', color = '#000', label, className = '' }) {
  const { d, size: vb } = qrPath(value)
  return (
    <svg className={`jv-qr ${className}`.trim()} width={size} height={size} viewBox={`0 0 ${vb} ${vb}`}
      role="img" aria-label={label || `二维码：${value}`} shapeRendering="crispEdges">
      <rect width={vb} height={vb} fill={background} rx={vb * 0.04} />
      <path d={d} fill={color} />
    </svg>
  )
}
