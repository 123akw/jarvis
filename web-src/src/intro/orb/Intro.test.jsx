import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Intro, { TL, loginLayout, particleCount } from './Intro.jsx'

/** 假的 WebGL 上下文：任何方法都是 spy，编译/链接都成功，WEBGL_lose_context 可观测 */
function fakeGL() {
  const lose = vi.fn()
  const impl = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    isContextLost: () => false,
    getExtension: name => (name === 'WEBGL_lose_context' ? { loseContext: lose } : null),
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
  }
  const gl = new Proxy({ lose }, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k !== 'string') return undefined
      if (/^[A-Z0-9_]+$/.test(k)) return 1           // gl.VERTEX_SHADER 之类的常量
      t[k] = vi.fn(impl[k] || (() => undefined))
      return t[k]
    },
  })
  return gl
}

let contexts
let rafSpy
let cafSpy

function stubWebGL({ fail = false } = {}) {
  vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    if (fail) return null
    const gl = fakeGL()
    contexts.push(gl)
    return gl
  })
}

function stubReducedMotion() {
  vi.stubGlobal('matchMedia', q => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }))
}

beforeEach(() => {
  contexts = []
  vi.useFakeTimers()
  let id = 0
  rafSpy = vi.fn(() => ++id)       // 不自动跑帧：时间线只靠 setTimeout 收尾
  cafSpy = vi.fn()
  vi.stubGlobal('requestAnimationFrame', rafSpy)
  vi.stubGlobal('cancelAnimationFrame', cafSpy)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('loginLayout：进场终帧对准登录页光球', () => {
  it('与 Playwright 实测的登录页几何一致（1440×900、390×844）', () => {
    const d = loginLayout(1440, 900)
    expect(d.size).toBe(210)
    expect(d.cx).toBe(720)
    expect(d.cy).toBeCloseTo(249.95, 1)
    expect(d.wy).toBeCloseTo(416.14, 0)
    const m = loginLayout(390, 844)
    expect(m.size).toBe(164)
    expect(m.cx).toBe(195)
    expect(m.cy).toBeCloseTo(229.81, 1)
    expect(m.wy).toBeCloseTo(364.53, 0)
  })

  it('手机减少粒子数，低核数设备再降', () => {
    expect(particleCount(390, 844)).toBeLessThan(particleCount(1440, 900))
    expect(particleCount(1440, 900, 4)).toBeLessThan(particleCount(1440, 900, 8))
    expect(particleCount(3840, 2160)).toBeLessThanOrEqual(8000)
  })
})

describe('Intro（orb）', () => {
  it('没有 WebGL 时走 CSS 降级：光点 + Presence CSS 光球，不建 canvas', () => {
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    const root = container.querySelector('.jvo')
    expect(root.dataset.mode).toBe('css')
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('.jv-presence')).not.toBeNull()
    expect(container.querySelectorAll('.jvo-dots i').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.jvo-word span')).toHaveLength(6)
  })

  it('onDone 一定会被调用，且只调一次（时长 ≤ 3.5s）', () => {
    const onDone = vi.fn()
    render(<Intro onDone={onDone} />)
    act(() => { vi.advanceTimersByTime(TL.end * 1000 - 50) })
    expect(onDone).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(100) })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(TL.end).toBeLessThanOrEqual(3.5)
    act(() => { vi.advanceTimersByTime(10000) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('prefers-reduced-motion：只做 600ms 淡入，1 秒内结束，不建 GL', () => {
    stubReducedMotion()
    stubWebGL()
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jvo').dataset.mode).toBe('reduced')
    expect(container.querySelector('canvas')).toBeNull()
    expect(contexts).toHaveLength(0)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('有 WebGL：粒子 + 光球两个上下文；卸载时释放全部 GL 资源并停帧', () => {
    stubWebGL()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const onDone = vi.fn()
    const { container, unmount } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jvo').dataset.mode).toBe('gl')
    expect(container.querySelectorAll('canvas')).toHaveLength(2)
    expect(rafSpy).toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(600) })        // 光球着色器延后编译
    expect(contexts).toHaveLength(2)
    unmount()
    for (const gl of contexts) {
      expect(gl.deleteBuffer).toHaveBeenCalled()
      expect(gl.deleteProgram).toHaveBeenCalled()
      expect(gl.deleteShader).toHaveBeenCalled()
      expect(gl.lose).toHaveBeenCalled()
    }
    expect(cafSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    act(() => { vi.advanceTimersByTime(10000) })
    expect(onDone).not.toHaveBeenCalled()             // 卸载后定时器已清
  })

  it('提前卸载（点击跳过）时光球着色器还没编译：不留下任何上下文', () => {
    stubWebGL()
    const { unmount } = render(<Intro onDone={() => {}} />)
    expect(contexts).toHaveLength(1)
    unmount()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(contexts).toHaveLength(1)
    expect(contexts[0].lose).toHaveBeenCalled()
  })

  it('WebGL 存在但建不出上下文（软件渲染被拒等）：退回 CSS 版，照常收尾', () => {
    stubWebGL({ fail: true })
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jvo').dataset.mode).toBe('css')
    expect(container.querySelector('canvas')).toBeNull()
    act(() => { vi.advanceTimersByTime(TL.end * 1000 + 10) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('GL 上下文丢失：立即结束进场', () => {
    stubWebGL()
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    const dust = container.querySelector('canvas.jvo-dust')
    act(() => { dust.dispatchEvent(new Event('webglcontextlost', { cancelable: true })) })
    expect(onDone).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(TL.end * 1000 + 10) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('authed 时不铺登录页背景光（下一屏是主界面）', () => {
    const { container } = render(<Intro onDone={() => {}} authed />)
    expect(container.querySelector('.jvo-amb')).toBeNull()
  })
})
