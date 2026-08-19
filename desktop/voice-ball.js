/* 悬浮球通话态外显：语音状态机 phase → body 类切换（听/想/说三态配色动效）。
 * 纯逻辑无 DOM 依赖（classList 注入），node --test 可直跑；CSS 在 index.html。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSVoiceBall = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  const PHASE_CLASS = {
    listening: 'voice-listening',
    thinking: 'voice-thinking',
    speaking: 'voice-speaking',
  }
  const ALL_CLASSES = Object.values(PHASE_CLASS)

  /** phase → 对应 body 类；connecting/closed 等一律空（球回常态） */
  function ballPhaseClass(phase) {
    return PHASE_CLASS[phase] || ''
  }

  /** 切换 body 上的通话态类：先清光三态再挂新的，保证任何时刻至多一个 */
  function applyBallPhase(classList, phase) {
    for (const cls of ALL_CLASSES) classList.remove(cls)
    const next = ballPhaseClass(phase)
    if (next) classList.add(next)
    return next
  }

  return { PHASE_CLASS, ballPhaseClass, applyBallPhase }
})
