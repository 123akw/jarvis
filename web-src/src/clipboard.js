/** 复制到剪贴板：优先异步 Clipboard API；非安全上下文（http 内网访问）没有它时退回 execCommand。
 *  返回 Promise<boolean>，调用方据此给「已复制 / 复制失败」反馈。 */
export async function copyText(text) {
  const value = String(text ?? '')
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch { /* 权限被拒等：走兜底 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand?.('copy') ?? false
    ta.remove()
    return Boolean(ok)
  } catch {
    return false
  }
}
