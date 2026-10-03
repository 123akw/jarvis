/* 「发送前确认」页（第二十轮，归流程前端代理；契约 docs/proposals/2026-10-round20-flows-ops.md §3.3）。
 * /approve/<id>：看要发出去的内容 → 可改 → 同意（流程接着跑）/ 拒绝（停下）。地基只放占位。 */
export default function Approve({ id }) {
  return <main className="jv-approve-stub" data-approval={id}>正在打开确认页…</main>
}
