/* /approve/<id>：通知里的「去确认」链接打开这里（第二十一轮，归前端代理；契约 §6.3、§8）。
 * 手机优先：要做什么、内容可改、同意 / 不同意，处理后显示结果。地基只放占位。 */
export default function ConsentPage({ id }) {
  return <main className="jv-consent-page-stub" data-consent={id}>正在打开确认页…</main>
}
