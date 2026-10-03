import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { dayLong, dayShort, fmtCompact, fmtInt, fmtYuan } from './model.js'

/* 每日趋势（自写 SVG，不加图表库）：上下两格共用一条日期轴——
 *   上格：每天的模型调用（柱）；下格：每天的估算花费（折线 + 淡面积）。
 * 两个量单位不同，分格画、各用各的纵轴（不画双纵轴，免得两条线「看起来相关」）。
 * 悬停 / 键盘左右键逐天看：竖线对准那一天，提示框列出调用、花费、流程运行。
 * 「看数据」切成表格（同样的数），读屏与不方便悬停的人都能拿到每个值。 */

const PAD_L = 46        // 纵轴刻度的位置
const PAD_R = 18
const CALLS_TOP = 30
const CALLS_H = 132
const GAP = 52          // 两格之间：放下格的标题
const COST_H = 76
const AXIS_GAP = 22     // 日期标签离下格底线
const MIN_BAND = 18     // 每天至少这么宽：30 天在手机上横向滚，不挤成一团
const TIP_W = 188       // 提示框宽度（与 admin.css .ad-tip 一致）：放不下就翻到竖线左边

/** 把最大值放大到好读的整刻度：1 / 1.2 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 × 10^n（中线也落在整数上） */
export function niceMax(v) {
  if (!(v > 0)) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * exp) return m * exp
  return 10 * exp
}

/** 顶部带 4px 圆角、底边方正的柱 */
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

/** 量容器宽度（没有 ResizeObserver 的环境用 fallback） */
function useWidth(ref, fallback) {
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const read = () => { const v = Math.floor(el.clientWidth); if (v > 0) setW(v) }
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return w
}

/** 日期标签隔几天标一个：7 天每天都标，再多就隔开（总是标到最后一天） */
const labelStep = n => (n <= 8 ? 1 : n <= 16 ? 2 : n <= 24 ? 4 : 5)

function DataTable({ daily, now }) {
  return (
    <div className="ad-trend-table">
      <table>
        <caption className="sr-only">每日模型调用、估算花费与流程运行</caption>
        <thead>
          <tr><th scope="col">日期</th><th scope="col">调用</th><th scope="col">估算花费</th><th scope="col">流程运行</th><th scope="col">失败</th></tr>
        </thead>
        <tbody>
          {[...daily].reverse().map(d => (
            <tr key={d.day}>
              <th scope="row">{dayLong(d.day, now)}</th>
              <td>{fmtInt(d.calls)}</td>
              <td>{fmtYuan(d.cost_yuan)}</td>
              <td>{fmtInt(d.flow_runs)}</td>
              <td>{fmtInt(d.flow_failures)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function TrendChart({ daily = [], now = new Date(), label = '每日调用与花费' }) {
  const boxRef = useRef(null)
  const width = useWidth(boxRef, 720)
  const [active, setActive] = useState(-1)
  const [table, setTable] = useState(false)
  const scrollRef = useRef(null)
  const n = daily.length
  useEffect(() => { setActive(-1) }, [n])

  const W = Math.max(width, PAD_L + PAD_R + n * MIN_BAND)
  // 放不下要横向滚时（手机上的 30 天），一打开先停在最近几天
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth
  }, [W, n, table])
  const plotW = W - PAD_L - PAD_R
  const band = n ? plotW / n : plotW
  const cx = i => PAD_L + band * (i + 0.5)
  const barW = Math.min(24, Math.max(4, band * 0.6))

  const maxCalls = niceMax(Math.max(0, ...daily.map(d => d.calls)))
  const maxCost = niceMax(Math.max(0, ...daily.map(d => d.cost_yuan)))
  const callsBase = CALLS_TOP + CALLS_H
  const costTop = callsBase + GAP
  const costBase = costTop + COST_H
  const H = costBase + AXIS_GAP + 14
  const yCalls = v => callsBase - (v / maxCalls) * CALLS_H
  const yCost = v => costBase - (v / maxCost) * COST_H

  const step = labelStep(n)
  const peak = daily.reduce((best, d, i) => (d.calls > (best < 0 ? -1 : daily[best].calls) ? i : best), -1)
  const pts = daily.map((d, i) => [cx(i), yCost(d.cost_yuan)])
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')
  const area = n ? `${line}L${pts[n - 1][0].toFixed(1)},${costBase}L${pts[0][0].toFixed(1)},${costBase}Z` : ''
  const cur = active >= 0 && active < n ? daily[active] : null

  function onKey(e) {
    if (!n) return
    if (e.key === 'ArrowRight') { e.preventDefault(); setActive(i => Math.min(n - 1, i < 0 ? n - 1 : i + 1)) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setActive(i => Math.max(0, i < 0 ? n - 1 : i - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1) }
    else if (e.key === 'Escape') setActive(-1)
  }

  // 提示框：在竖线右边，靠右边缘时翻到左边
  const tipLeft = cur ? cx(active) : 0
  const flip = cur && tipLeft + TIP_W + 12 > W

  return (
    <div className="ad-trend" ref={boxRef}>
      <div className="ad-trend-bar">
        <span className="ad-legend" aria-hidden="true">
          <span><i className="k-calls" />调用</span><span><i className="k-cost" />估算花费</span>
        </span>
        <button type="button" className="ad-link" aria-pressed={table} onClick={() => setTable(v => !v)}>
          {table ? '看图' : '看数据'}
        </button>
      </div>
      {table ? <DataTable daily={daily} now={now} /> : (
        <div className="ad-trend-scroll" ref={scrollRef}>
          <div className="ad-trend-canvas" style={{ width: W }} tabIndex={0} role="group"
            aria-label={`${label}。用左右方向键逐天查看`}
            onKeyDown={onKey} onFocus={() => setActive(i => (i < 0 ? n - 1 : i))} onBlur={() => setActive(-1)}
            onPointerLeave={() => setActive(-1)}>
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="ad-trend-svg" aria-hidden="true" focusable="false">
              {/* 格标题与纵轴刻度 */}
              <text className="ad-ax-title" x={PAD_L} y={CALLS_TOP - 14}>模型调用（次）</text>
              <text className="ad-ax-title" x={PAD_L} y={costTop - 14}>估算花费（元）</text>
              {[0, 0.5, 1].map(f => (
                <g key={`c${f}`}>
                  <line className="ad-grid" x1={PAD_L} x2={W - PAD_R} y1={yCalls(maxCalls * f)} y2={yCalls(maxCalls * f)} />
                  <text className="ad-ax" x={PAD_L - 8} y={yCalls(maxCalls * f) + 4} textAnchor="end">{fmtCompact(maxCalls * f)}</text>
                </g>
              ))}
              {[0, 1].map(f => (
                <g key={`y${f}`}>
                  <line className="ad-grid" x1={PAD_L} x2={W - PAD_R} y1={yCost(maxCost * f)} y2={yCost(maxCost * f)} />
                  <text className="ad-ax" x={PAD_L - 8} y={yCost(maxCost * f) + 4} textAnchor="end">
                    {maxCost * f >= 100 ? fmtCompact(maxCost * f) : trimMoney(maxCost * f)}
                  </text>
                </g>
              ))}

              {/* 竖线：对准当前那一天，贯穿两格 */}
              {cur ? <line className="ad-cross" x1={cx(active)} x2={cx(active)} y1={CALLS_TOP - 6} y2={costBase} /> : null}

              {/* 调用柱 */}
              <g className={`ad-bars${cur ? ' has-active' : ''}`}>
                {daily.map((d, i) => {
                  const h = callsBase - yCalls(d.calls)
                  return h > 0
                    ? <path key={d.day} className={`ad-bar${i === active ? ' on' : ''}`} d={barPath(cx(i) - barW / 2, yCalls(d.calls), barW, h)} />
                    : null
                })}
              </g>
              {peak >= 0 && n > 1 && daily[peak].calls > 0 && !cur ? (
                <text className="ad-peak" x={cx(peak)} y={yCalls(daily[peak].calls) - 6} textAnchor="middle">{fmtCompact(daily[peak].calls)}</text>
              ) : null}

              {/* 花费折线 */}
              {n > 1 ? <path className="ad-cost-area" d={area} /> : null}
              {n > 1 ? <path className="ad-cost-line" d={line} /> : null}
              {n ? (
                <circle className="ad-cost-dot" cx={pts[cur ? active : n - 1][0]} cy={pts[cur ? active : n - 1][1]} r={4} />
              ) : null}

              {/* 日期轴 */}
              {daily.map((d, i) => ((n - 1 - i) % step === 0 ? (
                <text key={d.day} className={`ad-ax${i === active ? ' on' : ''}`} x={cx(i)} y={costBase + AXIS_GAP} textAnchor="middle">
                  {dayShort(d.day, now)}
                </text>
              ) : null))}

              {/* 命中区：每天一整列，比柱子宽得多 */}
              {daily.map((d, i) => (
                <rect key={`hit-${d.day}`} className="ad-hit" data-day={d.day} x={PAD_L + band * i} y={CALLS_TOP - 10}
                  width={band} height={costBase - CALLS_TOP + 10} onPointerEnter={() => setActive(i)} onPointerMove={() => setActive(i)} />
              ))}
            </svg>
            {cur ? (
              <div className={`ad-tip${flip ? ' flip' : ''}`} style={{ left: tipLeft }} role="status">
                <div className="ad-tip-day">{dayLong(cur.day, now)}</div>
                <div className="ad-tip-row"><i className="k-calls" aria-hidden="true" /><b>{fmtInt(cur.calls)}</b><span>次调用</span></div>
                <div className="ad-tip-row"><i className="k-cost" aria-hidden="true" /><b>{fmtYuan(cur.cost_yuan)}</b><span>估算花费</span></div>
                <div className="ad-tip-sub">
                  <span>{fmtCompact(cur.tokens)} token</span>
                  <span>流程 {fmtInt(cur.flow_runs)} 次{cur.flow_failures ? ` · 失败 ${fmtInt(cur.flow_failures)}` : ''}</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

/** 纵轴上的小金额：去掉多余的 0（2.50 → 2.5，0 → 0） */
function trimMoney(v) {
  if (!v) return '0'
  return String(Number(v.toFixed(2)))
}
