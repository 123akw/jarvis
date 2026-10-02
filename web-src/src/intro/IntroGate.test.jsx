import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IntroGate, { setPrefetchLoader } from './IntroGate.jsx'
import { INTRO_DONE_EVENT, introPlaying, SEEN_KEY, setIntroPlaying } from './registry.js'

function setSearch(search) {
  window.history.replaceState(null, '', `/${search}`)
}

let prefetch
beforeEach(() => {
  vi.useFakeTimers()
  prefetch = vi.fn(() => Promise.resolve({}))
  setPrefetchLoader(prefetch)
  try { window.sessionStorage.removeItem(SEEN_KEY) } catch { /* 无存储 */ }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setSearch('')
  setIntroPlaying(false)
})

describe('IntroGate 与登录页的交接', () => {
  it('?intro=off：不渲染、不标记播放中', () => {
    setSearch('?intro=off')
    const { container } = render(<IntroGate />)
    expect(container.querySelector('.jv-intro-gate')).toBeNull()
    expect(introPlaying()).toBe(false)
  })

  it('播放中标记 introPlaying；结束（点击跳过）时派发 jv:intro-done、取消标记，淡出后卸载', () => {
    setSearch('?intro=awaken')
    const onDone = vi.fn()
    window.addEventListener(INTRO_DONE_EVENT, onDone)
    const { container } = render(<IntroGate />)
    expect(container.querySelector('.jv-intro-gate')).not.toBeNull()
    expect(introPlaying()).toBe(true)
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('.jv-intro-gate'))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(introPlaying()).toBe(false)
    expect(container.querySelector('.jv-intro-gate.leaving')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(500) })
    expect(container.querySelector('.jv-intro-gate')).toBeNull()
    window.removeEventListener(INTRO_DONE_EVENT, onDone)
  })

  it('8 秒兜底也会派发 jv:intro-done', () => {
    setSearch('?intro=awaken')
    const onDone = vi.fn()
    window.addEventListener(INTRO_DONE_EVENT, onDone)
    render(<IntroGate />)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(onDone).toHaveBeenCalledTimes(1)
    window.removeEventListener(INTRO_DONE_EVENT, onDone)
  })

  it('播放期间空闲时预取登录页光球的 WebGL chunk', () => {
    setSearch('?intro=awaken')
    render(<IntroGate />)
    expect(prefetch).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1300) })
    expect(prefetch).toHaveBeenCalledTimes(1)
  })
})
