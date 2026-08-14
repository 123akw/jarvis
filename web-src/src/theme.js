/** 主题切换：暗色 HUD（默认）↔ 亮色。登录页保持暗色电影感，只在 HUD 内生效。 */
const KEY = 'jws_theme'

export function currentTheme() {
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
}

export function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light')
}

export function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light'
  localStorage.setItem(KEY, next)
  applyTheme(next)
  return next
}
