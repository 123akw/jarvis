/* 进场动画注册表：方案是 intro/<name>/Intro.jsx，按需懒加载，不进首屏主包。
 *
 * 选择规则（pickIntro）：
 *   ?intro=<name>  强制播放该方案（预览/评审用，每次刷新都播）
 *   ?intro=off     本次不播（截图 / 联调用）
 *   否则每次整页打开或刷新都播 DEFAULT_INTRO（站内切页不重播）；DEFAULT_INTRO 为 null 时不播
 *   prefers-reduced-motion 时照样播，由方案自己降级（awaken 只淡入静态终帧，≤1s）
 *
 * 方案组件契约：<Intro onDone={fn} authed={bool} />
 *   - 自己铺满视口（position:fixed; inset:0），背景与 --jv-bg 一致，结束时调 onDone()
 *   - 时长 ≤ 3.5s；IntroGate 统一处理「点击/任意键跳过」与 8s 兜底超时，方案无需重复实现
 *   - 结尾画面应能自然衔接登录页（中心光球 / 暗底），IntroGate 负责最后的淡出
 *
 * 与登录页的交接：播放期间 introPlaying() 为 true，登录页的问候语和登录卡先不入场；
 * IntroGate 开始淡出时派发 INTRO_DONE_EVENT，登录页收到后再播入场动画。 */
export const INTROS = {
  awaken: () => import('./awaken/Intro.jsx'),
}

export const DEFAULT_INTRO = 'awaken'
export const INTRO_DONE_EVENT = 'jv:intro-done'

let playing = false
/** 进场动画是否正在播（登录页据此决定是否推迟入场） */
export function introPlaying() { return playing }
export function setIntroPlaying(v) { playing = !!v }

export function pickIntro({ search = '', fallback = DEFAULT_INTRO } = {}) {
  const forced = new URLSearchParams(search).get('intro')
  if (forced === 'off') return null
  if (forced && INTROS[forced]) return forced
  return fallback && INTROS[fallback] ? fallback : null
}
