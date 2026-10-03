/* 任务中心（第二十一轮，归前端代理；契约 docs/proposals/2026-10-round21-assistant.md §8）。
 * 主应用里的一个面板：页签「任务 / 自动化 / 目标 / 想法 / 活动记录」。
 * 目标、想法两个页签的内容由「目标与想法」代理在 ../goals/ 里提供（GoalsTab / IdeasTab）。地基只放占位。 */
export default function TaskCenter({ onClose }) {
  return <section className="jv-taskcenter-stub" aria-label="任务中心"><button type="button" onClick={onClose}>关闭</button>任务中心建设中…</section>
}
