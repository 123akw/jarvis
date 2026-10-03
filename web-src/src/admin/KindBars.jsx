import { fmtCompact, fmtInt, fmtPct, fmtYuan, kindRows } from './model.js'

/* 按类别分布：对话 / 流程 / 一句话生成 / 语音 / 其他，横条长短 = 调用次数（同一个颜色，名字和数字写在旁边）。
 * 顺序固定不随大小重排：换范围时同一类总在同一行。 */
export default function KindBars({ byKind }) {
  const rows = kindRows(byKind)
  const max = Math.max(0, ...rows.map(r => r.calls))
  if (!max) return <p className="ad-empty-line">这段时间还没有模型调用</p>
  return (
    <ul className="ad-kinds">
      {rows.map(r => (
        <li key={r.kind} className={`ad-kind${r.calls ? '' : ' is-zero'}`} data-kind={r.kind}>
          <div className="ad-kind-head">
            <span className="ad-kind-name">{r.label}</span>
            <span className="ad-kind-val"><b>{fmtInt(r.calls)}</b> 次<span className="ad-kind-share"> · {fmtPct(r.share)}</span></span>
          </div>
          <div className="ad-kind-track" aria-hidden="true">
            <i style={{ width: `${r.calls ? Math.max(1.5, (r.calls / max) * 100) : 0}%` }} />
          </div>
          <div className="ad-kind-sub">{fmtCompact(r.tokens)} token · {fmtYuan(r.cost_yuan)}</div>
        </li>
      ))}
    </ul>
  )
}
