/* 进场动画注册表：方案是 intro/<name>/Intro.jsx，按需懒加载，不进首屏主包。
 *
 * 选择规则（pickIntro）：
 *   ?intro=<name>  强制播放该方案（预览/评审用，每次刷新都播）
 *   ?intro=off     本次不播
 *   否则播 DEFAULT_INTRO，且同一浏览器会话只播一次；DEFAULT_INTRO 为 null 时不播
 *   prefers-reduced-motion 时不自动播（强制预览除外，方案自己负责降级）
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
export const SEEN_KEY = 'jws_intro_seen'
export const INTRO_DONE_EVENT = 'jv:intro-done'

let playing = false
/** 进场动画是否正在播（登录页据此决定是否推迟入场） */
export function introPlaying() { return playing }
export function setIntroPlaying(v) { playing = !!v }

export function pickIntro({ search = '', storage = null, reducedMotion = false, fallback = DEFAULT_INTRO } = {}) {
  const forced = new URLSearchParams(search).get('intro')
  if (forced === 'off') return null
  if (forced && INTROS[forced]) return forced
  if (!fallback || !INTROS[fallback] || reducedMotion) return null
  try { if (storage?.getItem(SEEN_KEY) === '1') return null } catch { /* 存储不可用：照常播一次 */ }
  return fallback
}

export function markSeen(storage) {
  try { storage?.setItem(SEEN_KEY, '1') } catch { /* 无痕模式：下次刷新会再播，可接受 */ }
}
