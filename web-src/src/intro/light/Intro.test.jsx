import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Intro, { measure } from './Intro.jsx'
import { createGlow } from './glow.js'
import { DONE_MS, REDUCED_MS, bezier, glowWidth, sample } from './timeline.js'

function stubReducedMotion(reduced) {
  vi.stubGlobal('matchMedia', q => ({
    matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {},
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom 没有 WebGL：getContext 返回 null，组件应走 CSS 兜底
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('light 进场：onDone 契约', () => {
  it('正常动态：时长 ≤3.5s，到点一定调用 onDone，且只调用一次', () => {
    stubReducedMotion(false)
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('canvas')).not.toBeNull()
    expect(DONE_MS).toBeLessThanOrEqual(3500)
    act(() => { vi.advanceTimersByTime(DONE_MS - 1) })
    expect(onDone).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onDone).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(10000) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('没有 WebGL 时退到 CSS 兜底，照样按时调用 onDone', () => {
    stubReducedMotion(false)
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jvi').classList.contains('no-gl')).toBe(true)
    act(() => { vi.advanceTimersByTime(DONE_MS) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('matchMedia 不可用（老浏览器 / jsdom）也不报错，按正常动态处理', () => {
    vi.stubGlobal('matchMedia', undefined)
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jvi.is-reduced')).toBeNull()
    act(() => { vi.advanceTimersByTime(DONE_MS) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('提前卸载（用户点击跳过）后不再调用 onDone', () => {
    stubReducedMotion(false)
    const onDone = vi.fn()
    const { unmount } = render(<Intro onDone={onDone} />)
    act(() => { vi.advanceTimersByTime(800) })
    unmount()
    act(() => { vi.advanceTimersByTime(DONE_MS) })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('onDone 换了引用也不会重启计时', () => {
    stubReducedMotion(false)
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Intro onDone={first} />)
    act(() => { vi.advanceTimersByTime(2000) })
    rerender(<Intro onDone={second} />)
    act(() => { vi.advanceTimersByTime(DONE_MS - 2000) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('light 进场：减弱动态降级', () => {
  it('prefers-reduced-motion：不建画布、不跑流光，只做淡入，较短时间内结束', () => {
    stubReducedMotion(true)
    const getContext = HTMLCanvasElement.prototype.getContext
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jvi.is-reduced')).not.toBeNull()
    expect(container.querySelector('canvas')).toBeNull()
    expect(getContext).not.toHaveBeenCalled()
    expect(REDUCED_MS).toBeLessThan(DONE_MS)
    act(() => { vi.advanceTimersByTime(REDUCED_MS) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

describe('light 进场：时间轴', () => {
  const L = { w: 1440, h: 900, tx: 720, ty: 250, r: 105 }

  it('开场全黑、绕完一周、收拢到登录页光球中心、最后长成同样大小的光球', () => {
    expect(sample(0, L).a).toBe(0)
    expect(sample(1.6, L).p).toBe(1)
    const end = sample(3.4, L)
    expect(end.hx).toBe(0)
    expect(end.hy).toBe(0)
    expect(end.cx).toBeCloseTo(720)
    expect(end.cy).toBeCloseTo(250)
    expect(end.o).toBeCloseTo(105)
    expect(end.a).toBe(0)
    expect(sample(2.5, L).o).toBeGreaterThanOrEqual(0)
  })

  it('收拢前流光框就是整个视口，收拢中途变成圆角', () => {
    const s = sample(2.0, L)
    expect(s.hx).toBe(720)
    expect(s.hy).toBe(450)
    expect(s.rad).toBe(0)
    const mid = sample(2.6, L)
    expect(mid.rad).toBeGreaterThan(0)
    expect(mid.rad).toBeLessThanOrEqual(Math.min(mid.hx, mid.hy))
  })

  it('找不到光球（已登录 / MOSS 形态）时光点散成柔光，不画球', () => {
    const s = sample(3.3, { ...L, r: 0, tx: 720, ty: 450 })
    expect(s.o).toBe(0)
    expect(s.wd).toBeGreaterThan(glowWidth(1440, 900))
  })

  it('手机流光更窄，但不窄于 22px', () => {
    expect(glowWidth(390, 844)).toBe(22)
    expect(glowWidth(1440, 900)).toBeGreaterThan(glowWidth(390, 844))
    expect(glowWidth(3840, 2160)).toBe(60)
  })

  it('bezier 与 CSS cubic-bezier 端点一致且单调', () => {
    const f = bezier(0.66, 0, 0.1, 1)
    expect(f(0)).toBeCloseTo(0, 4)
    expect(f(1)).toBeCloseTo(1, 4)
    let prev = -1
    for (let x = 0; x <= 1; x += 0.05) { const y = f(x); expect(y).toBeGreaterThanOrEqual(prev - 1e-9); prev = y }
  })
})

describe('light 进场：版面测量与 WebGL', () => {
  it('measure 读到登录页光球的中心与未变换半径；没有光球时退回视口中心', () => {
    expect(measure()).toMatchObject({ tx: window.innerWidth / 2, ty: window.innerHeight / 2, r: 0 })
    const orb = document.createElement('div')
    orb.className = 'jvl-orb'
    document.body.appendChild(orb)
    vi.spyOn(orb, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 40, width: 200, height: 200 })
    Object.defineProperty(orb, 'offsetWidth', { value: 210 })
    expect(measure()).toMatchObject({ tx: 200, ty: 140, r: 105 })
  })

  it('createGlow 在建不出上下文时返回 null', () => {
    expect(createGlow(document.createElement('canvas'))).toBeNull()
  })

  it('着色器编译中不画、编好后才画；编译失败时组件停画并退到 CSS 兜底', () => {
    stubReducedMotion(false)
    let linked = null   // null=编译中，true/false=结果
    const draws = vi.fn()
    const gl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3, ARRAY_BUFFER: 4, STATIC_DRAW: 5, FLOAT: 6, TRIANGLES: 7,
      createProgram: () => ({}), createShader: () => ({}), shaderSource() {}, compileShader() {}, attachShader() {},
      bindAttribLocation() {}, linkProgram() {}, viewport() {}, useProgram() {}, bindBuffer() {}, createBuffer: () => ({}),
      bufferData() {}, enableVertexAttribArray() {}, vertexAttribPointer() {}, getUniformLocation: () => ({}),
      uniform1f() {}, uniform2f() {}, drawArrays: draws,
      getExtension: n => (n === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: 9 } : null),
      getProgramParameter: (_, k) => (k === 9 ? linked !== null : linked),
    }
    HTMLCanvasElement.prototype.getContext.mockImplementation(() => gl)
    const { container } = render(<Intro onDone={() => {}} />)
    act(() => { vi.advanceTimersByTime(100) })
    expect(draws).not.toHaveBeenCalled()
    expect(container.querySelector('.jvi.no-gl')).toBeNull()
    linked = false
    act(() => { vi.advanceTimersByTime(50) })
    expect(draws).not.toHaveBeenCalled()
    expect(container.querySelector('.jvi.no-gl')).not.toBeNull()
  })

  it('编译成功后逐帧绘制', () => {
    stubReducedMotion(false)
    const draws = vi.fn()
    const gl = new Proxy({ getExtension: () => null, getProgramParameter: () => true, drawArrays: draws }, {
      get: (o, k) => (k in o ? o[k] : typeof k === 'string' && k.toUpperCase() === k ? 1 : () => ({})),
    })
    HTMLCanvasElement.prototype.getContext.mockImplementation(() => gl)
    render(<Intro onDone={() => {}} />)
    act(() => { vi.advanceTimersByTime(200) })
    expect(draws.mock.calls.length).toBeGreaterThan(3)
  })
})
