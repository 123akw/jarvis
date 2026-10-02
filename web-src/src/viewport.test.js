import { afterEach, describe, expect, it } from 'vitest'
import { trackKeyboard } from './viewport.js'

/** 假的 window：可控的 innerHeight 与 visualViewport，rAF 立即执行 */
function fakeWin({ inner = 844, height = 844, offsetTop = 0, scale = 1 } = {}) {
  const listeners = {}
  const vv = {
    height, offsetTop, scale,
    addEventListener: (t, fn) => { (listeners[t] ||= new Set()).add(fn) },
    removeEventListener: (t, fn) => listeners[t]?.delete(fn),
    fire: t => listeners[t]?.forEach(fn => fn()),
    count: () => Object.values(listeners).reduce((n, s) => n + s.size, 0),
  }
  return {
    innerHeight: inner, visualViewport: vv, document,
    requestAnimationFrame: cb => { cb(); return 0 },   // 同步执行：返回 0 表示这一帧已跑完
    cancelAnimationFrame: () => {},
  }
}

const root = document.documentElement

describe('iOS 软键盘可视区 trackKeyboard', () => {
  let stop = () => {}
  afterEach(() => { stop(); root.removeAttribute('data-kb'); root.removeAttribute('style') })

  it('键盘弹出（可视视口明显变矮）时写入可视区高度与偏移，收起后清掉', () => {
    const win = fakeWin()
    stop = trackKeyboard(win)
    expect(root.hasAttribute('data-kb')).toBe(false)
    Object.assign(win.visualViewport, { height: 480, offsetTop: 210 })
    win.visualViewport.fire('resize')
    expect(root.hasAttribute('data-kb')).toBe(true)
    expect(root.style.getPropertyValue('--jv-vvh')).toBe('480px')
    expect(root.style.getPropertyValue('--jv-vvt')).toBe('210px')
    Object.assign(win.visualViewport, { offsetTop: 120 })
    win.visualViewport.fire('scroll')
    expect(root.style.getPropertyValue('--jv-vvt')).toBe('120px')
    Object.assign(win.visualViewport, { height: 844, offsetTop: 0 })
    win.visualViewport.fire('resize')
    expect(root.hasAttribute('data-kb')).toBe(false)
    expect(root.style.getPropertyValue('--jv-vvh')).toBe('')
  })

  it('地址栏伸缩（只差几十 px）和双指放大都不算键盘', () => {
    const win = fakeWin()
    stop = trackKeyboard(win)
    Object.assign(win.visualViewport, { height: 790 })
    win.visualViewport.fire('resize')
    expect(root.hasAttribute('data-kb')).toBe(false)
    Object.assign(win.visualViewport, { height: 400, scale: 2 })
    win.visualViewport.fire('resize')
    expect(root.hasAttribute('data-kb')).toBe(false)
  })

  it('Android 走 interactive-widget=resizes-content：布局视口一起缩，不介入', () => {
    const win = fakeWin({ inner: 500, height: 500 })
    stop = trackKeyboard(win)
    expect(root.hasAttribute('data-kb')).toBe(false)
  })

  it('卸载时移除监听并清理变量；没有 visualViewport 的环境直接跳过', () => {
    const win = fakeWin({ height: 480 })
    stop = trackKeyboard(win)
    expect(root.hasAttribute('data-kb')).toBe(true)
    stop()
    stop = () => {}
    expect(win.visualViewport.count()).toBe(0)
    expect(root.hasAttribute('data-kb')).toBe(false)
    expect(() => trackKeyboard({ document })()).not.toThrow()
  })
})
