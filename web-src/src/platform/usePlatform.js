import { useEffect, useMemo, useState } from 'react'
import { accentTokens, getFlows, getPlatform, getPluginIndex } from './platform.js'

/* ---------------- 主题色：覆盖 --jv-accent 及派生 token ---------------- */

const THEME_CLASS = 'jv-pf'
const THEME_VARS = ['--pf-accent-d', '--pf-on-d', '--pf-accent-l', '--pf-on-l', '--pf-c1', '--pf-c2', '--pf-c3', '--pf-c4']

/** 把平台主题色挂到 body：body.jv-pf 上的规则（platform.css）按深浅色取对应变量。传空值即还原成贾维斯默认蓝。 */
export function applyPlatformTheme(accent) {
  const body = document.body
  if (!accent) {
    body.classList.remove(THEME_CLASS)
    THEME_VARS.forEach(k => body.style.removeProperty(k))
    return
  }
  const t = accentTokens(accent)
  const values = [t.dark, t.darkOn, t.light, t.lightOn, ...t.orb]
  THEME_VARS.forEach((k, i) => body.style.setProperty(k, values[i]))
  body.classList.add(THEME_CLASS)
}

export function usePlatformTheme(accent) {
  useEffect(() => {
    if (!accent) return undefined
    applyPlatformTheme(accent)
    return () => applyPlatformTheme(null)
  }, [accent])
}

/* ---------------- PWA：manifest / 主屏图标 / 状态栏色 / service worker ---------------- */

/** 找到或建一个 head 里的标签；返回 [元素, 还原函数]（原来就有的恢复旧值，新建的删掉） */
function headTag(tag, match, attrs) {
  let el = document.head.querySelector(`${tag}[${match[0]}="${match[1]}"]`)
  const created = !el
  const prev = {}
  if (!el) {
    el = document.createElement(tag)
    el.setAttribute(match[0], match[1])
    document.head.appendChild(el)
  }
  for (const [k, v] of Object.entries(attrs)) {
    prev[k] = el.getAttribute(k)
    el.setAttribute(k, v)
  }
  return () => {
    if (created) { el.remove(); return }
    for (const [k, v] of Object.entries(prev)) (v === null ? el.removeAttribute(k) : el.setAttribute(k, v))
  }
}

/** 注册 /sw.js（最小 service worker，不缓存 /api）：没有 serviceWorker 或非安全上下文就跳过，失败静默 */
export function registerServiceWorker() {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return false
    navigator.serviceWorker.register('/sw.js').catch(() => {})
    return true
  } catch {
    return false
  }
}

/**
 * 平台入口页、以及有平台的账号进主应用时，把这个平台声明成可装到主屏的 App：
 * manifest、apple-touch-icon、theme-color、apple-mobile-web-app-*，标题换成平台名，并注册 service worker。
 * brand: { slug, name, accent, theme? } —— 缺 slug 时什么都不做；卸载时把 head 还原。
 */
export function usePwaHead(brand) {
  const slug = brand?.slug || ''
  const name = brand?.name || ''
  const accent = brand?.accent || ''
  const theme = brand?.theme || ''
  useEffect(() => {
    if (!slug) return undefined
    const base = `/p/${encodeURIComponent(slug)}`
    const bar = accentTokens(accent).bar
    const dark = theme ? theme !== 'light' : !document.body.classList.contains('light')
    const undo = [
      headTag('link', ['rel', 'manifest'], { href: `${base}/manifest.webmanifest` }),
      headTag('link', ['rel', 'apple-touch-icon'], { href: `${base}/icon-192.png` }),
      headTag('meta', ['name', 'theme-color'], { content: dark ? bar.dark : bar.light }),
      headTag('meta', ['name', 'apple-mobile-web-app-capable'], { content: 'yes' }),
      headTag('meta', ['name', 'mobile-web-app-capable'], { content: 'yes' }),
      headTag('meta', ['name', 'apple-mobile-web-app-title'], { content: name || slug }),
      headTag('meta', ['name', 'apple-mobile-web-app-status-bar-style'], { content: 'black-translucent' }),
    ]
    const title = document.title
    if (name) document.title = name
    registerServiceWorker()
    return () => {
      undo.forEach(fn => fn())
      document.title = title
    }
  }, [slug, name, accent, theme])
}

/** 安卓 Chrome 的「安装应用」提示：拦下 beforeinstallprompt，界面上给一个「一键装到主屏」按钮；iOS 没有这个事件，返回 null */
export function useInstallPrompt() {
  const [evt, setEvt] = useState(null)
  useEffect(() => {
    const on = e => { e.preventDefault(); setEvt(e) }
    const done = () => setEvt(null)
    window.addEventListener('beforeinstallprompt', on)
    window.addEventListener('appinstalled', done)
    return () => { window.removeEventListener('beforeinstallprompt', on); window.removeEventListener('appinstalled', done) }
  }, [])
  if (!evt) return null
  return async () => {
    try { evt.prompt(); await evt.userChoice } catch { /* 用户取消或浏览器不给装 */ }
    setEvt(null)
  }
}

/* ---------------- 主应用里的平台数据 ---------------- */

/**
 * 登录后取当前账号的平台；有平台再取插件目录（图标、示例问题）和「我的流程」。
 * 都是静默失败：没有平台 = 主页保持贾维斯原样；目录取不到用兜底表；流程取不到就不显示那张卡。
 * draft：平台设置里还没保存的改动（名称 / 图标 / 主题色），实时预览到顶栏与主页上。
 */
export function usePlatformHome() {
  const [platform, setPlatform] = useState(null)
  const [plugins, setPlugins] = useState(null)
  const [flows, setFlows] = useState(null)
  const [draft, setDraft] = useState(null)
  useEffect(() => {
    let alive = true
    getPlatform().then(p => { if (alive) setPlatform(p) })
    return () => { alive = false }
  }, [])
  const has = Boolean(platform)
  useEffect(() => {
    if (!has) return undefined
    let alive = true
    getPluginIndex().then(p => { if (alive) setPlugins(p) }).catch(() => {})
    getFlows().then(f => { if (alive) setFlows(f) }).catch(() => {})
    return () => { alive = false }
  }, [has])
  const shown = useMemo(() => (platform && draft ? { ...platform, ...draft } : platform), [platform, draft])
  return { platform: shown, saved: platform, plugins, flows, setPlatform, setDraft }
}
