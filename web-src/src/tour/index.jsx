/* 新手引导（第十八轮，归新手引导代理；契约见 docs/proposals/2026-10-round18-flows.md §3.5 / §5.3）。
 *
 * 页面只做三件事：
 *   1. 给要讲解的元素加 data-tour="<锚点>"（锚点清单见契约）；
 *   2. 页面数据就绪后调 useTour('<引导 id>', { ready })：第一次来自动播一次，看完或跳过都不再自动出现；
 *   3. 放一个 <TourButton tour="<引导 id>" />（或在菜单里调 startTour(id)）让用户随时重看。
 *
 * 引导层 <TourLayer /> 在 main.jsx 挂一份；内容在 tours.js；看过没存在 /api/onboarding（游客存本机）。 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  currentPageTour as pageTour, forgetAutoTried, getActive, registerPage, requestAuto, startTour as start, subscribe,
} from './controller.js'
import { resetSeen } from './store.js'
import { TOURS } from './tours.js'
import './tour.css'

export { default as TourLayer } from './TourLayer.jsx'

export const TOUR_IDS = ['flows-home', 'flows-editor', 'market', 'app']

/** 立即开始某个引导（重看）。 */
export function startTour(id) {
  return start(id)
}

/** 当前页面登记过的引导 id（账号菜单 / ⌘K「重看本页」用）；没有返回 ''。 */
export function currentPageTour() {
  return pageTour()
}

/** 重置所有新手引导（设置 / ⌘K 用）：之后各页面会重新自动出现一次。返回是否成功（接口失败时本机已清）。 */
export async function resetAllTours() {
  forgetAutoTried()
  return resetSeen()
}

/** 页面里声明「这里有个引导」：ready 为真且没看过时自动开始。返回 { start, running }。 */
export function useTour(id, { ready = false, auto = true } = {}) {
  const running = useSyncExternalStore(subscribe, () => getActive()?.id === id, () => false)
  useEffect(() => registerPage(id), [id])
  useEffect(() => {
    if (!ready || !auto || !TOURS[id]) return undefined
    return requestAuto(id)
  }, [id, ready, auto])
  const begin = useCallback(() => start(id), [id])
  return { start: begin, running }
}

function QuestionIcon({ size = 16 }) {
  return (
    <svg className="jv-tour-q" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" />
      <path d="M12 17h.01" />
    </svg>
  )
}

/** 「新手引导」按钮：点一下重看本页引导。 */
export function TourButton({ tour, label = '新手引导', className = '' }) {
  return (
    <button type="button" className={`jv-tour-btn${className ? ` ${className}` : ''}`} data-tour-button={tour || ''}
      title="重看本页的新手引导" onClick={() => startTour(tour)}>
      <QuestionIcon />
      <span>{label}</span>
    </button>
  )
}
