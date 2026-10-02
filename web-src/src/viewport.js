/* iOS Safari 软键盘：布局视口不变、只缩可视视口，并把可视视口往上平移去露出输入框——
 * 顶栏被推出屏外，滑对话时整页跟着平移，输入条时不时钻到键盘底下。
 * 这里把可视视口的高度/偏移写进 --jv-vvh / --jv-vvt，.hud 据此正好铺满键盘以上的可见区域；
 * Android Chrome 走 viewport meta 的 interactive-widget=resizes-content，布局视口本身会缩，这里不介入。 */
const KB_MIN = 120   // 可视视口比布局视口矮这么多才算键盘弹出（地址栏伸缩只有几十 px）

export function trackKeyboard(win = window) {
  const vv = win.visualViewport
  if (!vv) return () => {}
  const root = win.document.documentElement
  let frame = 0
  function apply() {
    frame = 0
    const open = Math.abs(vv.scale - 1) < 0.01 && win.innerHeight - vv.height > KB_MIN   // 双指放大时不算
    if (!open) {
      if (root.hasAttribute('data-kb')) {
        root.removeAttribute('data-kb')
        root.style.removeProperty('--jv-vvh')
        root.style.removeProperty('--jv-vvt')
      }
      return
    }
    root.setAttribute('data-kb', '')
    root.style.setProperty('--jv-vvh', `${Math.round(vv.height)}px`)
    root.style.setProperty('--jv-vvt', `${Math.round(vv.offsetTop)}px`)
  }
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(apply) }
  vv.addEventListener('resize', schedule)
  vv.addEventListener('scroll', schedule)
  apply()
  return () => {
    vv.removeEventListener('resize', schedule)
    vv.removeEventListener('scroll', schedule)
    if (frame) win.cancelAnimationFrame(frame)
    root.removeAttribute('data-kb')
    root.style.removeProperty('--jv-vvh')
    root.style.removeProperty('--jv-vvt')
  }
}
