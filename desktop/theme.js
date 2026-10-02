/* 桌面端主题：默认深色（与网页端「暗色为默认」一致），设置页可改浅色或跟随 macOS 外观。
 * 只是本机外观偏好，存 localStorage，不进 settings.json、不经主进程。
 * 亮色 token 挂在 body.light 上（与网页端 web-src/src/theme.js 同一个开关）。
 * UMD：页面里自动初始化并暴露 window.JWSTheme；node --test 直接 require 纯逻辑。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSTheme = api
  if (root && root.document && root.document.body) {
    try { api.initTheme() } catch { /* 主题失败就留暗色 */ }
  }
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  const KEY = 'jws_desktop_theme'
  const PREFS = ['dark', 'light', 'system']
  const QUERY = '(prefers-color-scheme: light)'

  function normalizePref(value) {
    return PREFS.includes(value) ? value : 'dark'
  }

  /** 偏好 + 系统是否浅色 → 实际主题 'light' | 'dark' */
  function resolveTheme(pref, systemLight) {
    const p = normalizePref(pref)
    if (p === 'system') return systemLight ? 'light' : 'dark'
    return p
  }

  /**
   * 主题控制器。依赖全注入：storage（localStorage 形状）、matchMedia、classList（body.classList）。
   * 偏好为「跟随系统」时，系统外观一变即重算；返回 { apply, set, pref }。
   */
  function createThemeController({ storage, matchMedia, classList }) {
    let mq = null
    try { mq = matchMedia ? matchMedia(QUERY) : null } catch { mq = null }
    function pref() {
      try { return normalizePref(storage && storage.getItem(KEY)) } catch { return 'dark' }
    }
    function apply() {
      const theme = resolveTheme(pref(), Boolean(mq && mq.matches))
      classList.toggle('light', theme === 'light')
      return theme
    }
    function set(next) {
      try { storage && storage.setItem(KEY, normalizePref(next)) } catch { /* 存不下就只本次生效 */ }
      return apply()
    }
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', apply)
      else if (mq.addListener) mq.addListener(apply)
    }
    apply()
    return { apply, set, pref }
  }

  let controller = null
  function initTheme(scope = globalThis) {
    if (!controller) {
      controller = createThemeController({
        storage: scope.localStorage,
        matchMedia: scope.matchMedia ? q => scope.matchMedia(q) : null,
        classList: scope.document.body.classList,
      })
    }
    return controller
  }
  function current() { return controller }

  return { KEY, PREFS, normalizePref, resolveTheme, createThemeController, initTheme, current }
})
