/* 对话里的同意卡（第二十一轮，归前端代理；契约 §6.3、§8）。
 * 由界面原生渲染（不是模型写的文字）：要做什么、给谁、内容（可改）、同意 / 不同意。地基只放占位。 */
export default function ConsentCard({ consent }) {
  return <div className="jv-consent-stub" data-consent={consent?.id}>需要你确认：{consent?.title}</div>
}
