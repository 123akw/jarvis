import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { presenceClock } from '../../Presence.jsx'
import Intro from './Intro.jsx'
import { glowWidth, loginLayout, measureTarget, particleCount } from './layout.js'
import { createScene } from './scene.js'
import { glowParams, orbParams, TL } from './timeline.js'

/** 假的 WebGL 上下文：任何方法都是 spy，编译/链接都成功，WEBGL_lose_context 可观测；
 *  extra 覆盖个别方法（如 KHR_parallel_shader_compile） */
function fakeGL(extra = {}) {
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
    ...extra,
  }
  return new Proxy({ lose }, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k !== 'string') return undefined
      if (/^[A-Z0-9_]+$/.test(k)) return 1           // gl.VERTEX_SHADER 之类的常量
      t[k] = vi.fn(impl[k] || (() => undefined))
      return t[k]
    },
  })
}

let contexts
let rafSpy
let cafSpy

function stubWebGL({ fail = false, make = () => fakeGL() } = {}) {
  vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    if (fail) return null
    const gl = make()
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
  document.body.innerHTML = ''
})

/** 手动跑一帧 rAF 回调 */
function runFrame() {
  const cb = rafSpy.mock.calls.at(-1)?.[0]
  act(() => { cb?.(performance.now()) })
}

describe('版面：进场末帧对准登录页光球', () => {
  it('与 Playwright 实测的登录页几何一致（1440×900、390×844）', () => {
    const d = loginLayout(1440, 900)
    expect(d.size).toBe(210)
    expect(d.cx).toBe(720)
    expect(d.cy).toBeCloseTo(249.95, 1)
    const m = loginLayout(390, 844)
    expect(m.size).toBe(164)
    expect(m.cx).toBe(195)
    expect(m.cy).toBeCloseTo(229.81, 1)
  })

  it('measureTarget 优先量真实光球：中心取包围盒中心，直径取未变换的布局宽度', () => {
    expect(measureTarget()).toMatchObject(loginLayout(window.innerWidth, window.innerHeight))
    const wrap = document.createElement('div')
    wrap.className = 'jvl-orb'
    const orb = document.createElement('div')
    orb.className = 'jv-presence'
    wrap.appendChild(orb)
    document.body.appendChild(wrap)
    vi.spyOn(orb, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 40, width: 200, height: 200 })
    Object.defineProperty(orb, 'offsetWidth', { value: 210 })
    expect(measureTarget()).toMatchObject({ cx: 200, cy: 140, size: 210 })
  })

  it('手机减少粒子数，低核数设备再降；流光手机更窄但不窄于 22px', () => {
    expect(particleCount(390, 844)).toBeLessThan(particleCount(1440, 900))
    expect(particleCount(1440, 900, 4)).toBeLessThan(particleCount(1440, 900, 8))
    expect(particleCount(3840, 2160)).toBeLessThanOrEqual(8000)
    expect(glowWidth(390, 844)).toBe(22)
    expect(glowWidth(1440, 900)).toBeGreaterThan(glowWidth(390, 844))
    expect(glowWidth(3840, 2160)).toBe(60)
  })
})

describe('时间轴', () => {
  it('总长 ≤3.5s；流光开场全黑、1.35s 绕完一周；碎裂在点亮光球之前完成', () => {
    expect(TL.end).toBeLessThanOrEqual(3.5)
    expect(glowParams(0).a).toBe(0)
    expect(glowParams(1.4).p).toBe(1)
    expect(TL.shatter[0]).toBeGreaterThanOrEqual(1.4)
    expect(TL.shatter[0] + TL.shatter[1]).toBeLessThan(TL.glowOff)
    expect(TL.glowOff).toBeLessThan(TL.ignite)
    expect(TL.ignite).toBeLessThan(TL.end)
  })

  it('光球末帧与登录页待命光球完全一致：同一花纹时钟、待命参数', () => {
    const clk = presenceClock(12345)
    const end = orbParams(TL.end, clk)
    expect(end.phase).toBe(clk.phase)
    expect(end.spin).toBe(clk.spin)
    expect(end.energy).toBeCloseTo(0.28, 10)
    expect(end.halo).toBeCloseTo(0.5, 10)
    expect(end.scale).toBeCloseTo(clk.breath, 10)
    expect(end.sweep).toBe(0)
    const ignite = orbParams(TL.ignite, clk)   // 点亮时更亮、更小、相位滞后（随后加速追上时钟）
    expect(ignite.energy).toBeGreaterThan(end.energy)
    expect(ignite.scale).toBeLessThan(end.scale)
    expect(ignite.phase).toBeLessThan(clk.phase)
  })
})

describe('Intro（awaken）：onDone 契约', () => {
  it('没有 WebGL 时走 CSS 降级：内发光 + 光点 + Presence CSS 光球，不建 canvas', () => {
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jva').dataset.mode).toBe('css')
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('.jva-fb')).not.toBeNull()
    expect(container.querySelector('.jv-presence')).not.toBeNull()
    expect(container.querySelectorAll('.jva-dots i').length).toBeGreaterThan(0)
    expect(container.querySelector('.jva').classList.contains('is-run')).toBe(true)
  })

  it('大字「你好，我是贾维斯。」逐字拆开，「贾维斯」走 AI 渐变', () => {
    const { container } = render(<Intro onDone={() => {}} />)
    const chars = [...container.querySelectorAll('.jva-ch')]
    expect(chars.map(c => c.textContent).join('')).toBe('你好，我是贾维斯。')
    expect([...container.querySelectorAll('.jva-ch.is-name')].map(c => c.textContent).join('')).toBe('贾维斯')
  })

  it('onDone 一定会被调用、只调一次，时长 = TL.end', () => {
    const onDone = vi.fn()
    render(<Intro onDone={onDone} />)
    act(() => { vi.advanceTimersByTime(TL.end * 1000 - 50) })
    expect(onDone).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(100) })
    expect(onDone).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(10000) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('onDone 换了引用也不会重启计时', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Intro onDone={first} />)
    act(() => { vi.advanceTimersByTime(2000) })
    rerender(<Intro onDone={second} />)
    act(() => { vi.advanceTimersByTime(TL.end * 1000 - 2000 + 10) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('提前卸载（点击跳过）后不再调用 onDone', () => {
    const onDone = vi.fn()
    const { unmount } = render(<Intro onDone={onDone} />)
    act(() => { vi.advanceTimersByTime(800) })
    unmount()
    act(() => { vi.advanceTimersByTime(10000) })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('prefers-reduced-motion：只有静态终帧淡入，1 秒内结束，不建 GL、没有大字', () => {
    stubReducedMotion()
    stubWebGL()
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jva').dataset.mode).toBe('reduced')
    expect(container.querySelector('canvas')).toBeNull()
    expect(contexts).toHaveLength(0)
    act(() => { vi.advanceTimersByTime(TL.reducedEnd * 1000) })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(TL.reducedEnd).toBeLessThanOrEqual(1)
  })

  it('authed 时不铺登录页背景光（下一屏是主界面）', () => {
    const { container } = render(<Intro onDone={() => {}} authed />)
    expect(container.querySelector('.jva-amb')).toBeNull()
  })
})

describe('Intro（awaken）：WebGL 资源', () => {
  it('有 WebGL：场景 + 光球两个上下文；卸载时释放全部 GL 资源并停帧', () => {
    stubWebGL()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const onDone = vi.fn()
    const { container, unmount } = render(<Intro onDone={onDone} />)
    expect(container.querySelector('.jva').dataset.mode).toBe('gl')
    expect(container.querySelectorAll('canvas')).toHaveLength(2)
    expect(rafSpy).toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(TL.orbAt * 1000 + 50) })   // 光球上下文延后建
    expect(contexts).toHaveLength(2)
    runFrame()
    expect(contexts[0].drawArrays).toHaveBeenCalled()             // 流光 + 粒子
    unmount()
    for (const gl of contexts) {
      expect(gl.deleteBuffer).toHaveBeenCalled()
      expect(gl.deleteProgram).toHaveBeenCalled()
      expect(gl.deleteShader).toHaveBeenCalled()
      expect(gl.lose).toHaveBeenCalled()
    }
    expect(contexts[0].deleteProgram).toHaveBeenCalledTimes(2)
    expect(cafSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    act(() => { vi.advanceTimersByTime(10000) })
    expect(onDone).not.toHaveBeenCalled()                         // 卸载后定时器已清
  })

  it('提前卸载时光球上下文还没建：只留下已释放的场景上下文', () => {
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
    expect(container.querySelector('.jva').dataset.mode).toBe('css')
    expect(container.querySelector('canvas')).toBeNull()
    act(() => { vi.advanceTimersByTime(TL.end * 1000 + 10) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('GL 上下文丢失：立即结束进场', () => {
    stubWebGL()
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} />)
    const canvas = container.querySelector('canvas.jva-gl')
    act(() => { canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })) })
    expect(onDone).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(TL.end * 1000 + 10) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('后台编译：编好之前不画；编译失败时提前结束进场', () => {
    let done = false
    let linked = true
    stubWebGL({
      make: () => fakeGL({
        getExtension: n => (n === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: 9 } : null),
        getProgramParameter: (_, k) => (k === 9 ? done : linked),
      }),
    })
    const onDone = vi.fn()
    render(<Intro onDone={onDone} />)
    runFrame()
    expect(contexts[0].drawArrays).not.toHaveBeenCalled()
    done = true
    linked = false
    runFrame()
    expect(contexts[0].drawArrays).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('createScene：建不出上下文返回 null；同步编译失败也返回 null 并释放', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
    expect(createScene(document.createElement('canvas'))).toBeNull()
    const gl = fakeGL({ getProgramParameter: () => false })
    HTMLCanvasElement.prototype.getContext.mockImplementation(() => gl)
    expect(createScene(document.createElement('canvas'))).toBeNull()
    expect(gl.lose).toHaveBeenCalled()
  })
})
