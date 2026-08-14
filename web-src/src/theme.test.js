import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyTheme, currentTheme, toggleTheme } from './theme.js'

describe('主题切换', () => {
  beforeEach(() => {  // 本 jsdom 环境不带 localStorage，按仓库惯例 stub
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    })
  })
  afterEach(() => {
    localStorage.removeItem('jws_theme')
    document.body.classList.remove('light')
  })

  it('默认暗色，切换后落 localStorage 并给 body 加 light 类', () => {
    expect(currentTheme()).toBe('dark')
    expect(toggleTheme()).toBe('light')
    expect(document.body.classList.contains('light')).toBe(true)
    expect(localStorage.getItem('jws_theme')).toBe('light')
    expect(toggleTheme()).toBe('dark')
    expect(document.body.classList.contains('light')).toBe(false)
  })

  it('applyTheme 幂等且不写存储', () => {
    applyTheme('light')
    applyTheme('light')
    expect(document.body.classList.contains('light')).toBe(true)
    expect(localStorage.getItem('jws_theme')).toBeNull()
    applyTheme('dark')
    expect(document.body.classList.contains('light')).toBe(false)
  })
})
