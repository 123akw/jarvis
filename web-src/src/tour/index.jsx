/* 新手引导（第十八轮，归新手引导代理；契约见 docs/proposals/2026-10-round18-flows.md §6）。
 *
 * 页面只做三件事：
 *   1. 给要讲解的元素加 data-tour="<锚点>"（锚点清单见契约）；
 *   2. 页面数据就绪后调 useTour('<引导 id>', { ready })：第一次来自动播一次，看完或跳过都不再自动出现；
 *   3. 放一个 <TourButton tour="<引导 id>" />（或在菜单里调 startTour(id)）让用户随时重看。
 *
 * 地基只放空实现：接口稳定，新手引导代理替换内部。 */

export const TOUR_IDS = ['flows-home', 'flows-editor', 'market', 'app']

/** 立即开始某个引导（重看）。 */
export function startTour(_id) {}

/** 页面里声明「这里有个引导」：ready 为真且没看过时自动开始。返回 { start, running }。 */
export function useTour(_id, _opts = {}) {
  return { start() {}, running: false }
}

/** 「新手引导」按钮：点一下重看本页引导。 */
export function TourButton({ tour: _tour, label = '新手引导', className = '' }) {
  return <button type="button" className={className} data-tour-button="" onClick={() => startTour(_tour)}>{label}</button>
}
