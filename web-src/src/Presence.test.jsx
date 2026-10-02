import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Presence, {
  clamp01, EdgeGlow, PARAM_KEYS, paramsSettled, presenceClock, PRESENCE_STATES, resetWebglProbe, rmsToLevel,
  setPresenceGLLoader, smoothLevel, stepParams, targetParams,
} from './Presence.jsx'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 模拟 prefers-reduced-motion */
function stubReducedMotion(reduced) {
  vi.stubGlobal('matchMedia', q => ({
    matches: reduced && q.includes('reduce'), media: q,
    addEventListener() {}, removeEventListener() {},
  }))
}

/** 模拟一个「有 WebGL」的浏览器 */
function stubWebGL() {
  vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ getExtension: () => null }))
}

describe('Presence 状态参数与插值', () => {
  it('四个状态都给出完整参数，未知状态按 idle', () => {
    for (const s of PRESENCE_STATES) {
      const t = targetParams(s, 0.5)
      for (const k of PARAM_KEYS) expect(Number.isFinite(t[k])).toBe(true)
    }
    expect(targetParams('???', 0.9)).toEqual(targetParams('idle', 0))
  })

  it('listening/speaking 随音量膨胀，level 越界被截断；thinking 不受音量影响', () => {
    expect(targetParams('listening', 1).scale).toBeGreaterThan(targetParams('listening', 0).scale)
    expect(targetParams('speaking', 0.8).halo).toBeGreaterThan(targetParams('speaking', 0.1).halo)
    expect(targetParams('listening', 5)).toEqual(targetParams('listening', 1))
    expect(targetParams('listening', -3)).toEqual(targetParams('listening', 0))
    expect(targetParams('thinking', 0)).toEqual(targetParams('thinking', 1))
    expect(targetParams('thinking', 0).speed).toBeGreaterThan(targetParams('idle', 0).speed) // 思考 = 加速流转
    expect(clamp01(NaN)).toBe(0)
  })

  it('状态切换不跳变：一帧只走一小段，每个参数都落在旧值与目标之间', () => {
    const from = targetParams('idle', 0)
    const to = targetParams('thinking', 0)
    const next = stepParams(from, to, 1 / 60)
    for (const k of PARAM_KEYS) {
      const lo = Math.min(from[k], to[k])
      const hi = Math.max(from[k], to[k])
      expect(next[k]).toBeGreaterThanOrEqual(lo)
      expect(next[k]).toBeLessThanOrEqual(hi)
      if (from[k] !== to[k]) {
        expect(Math.abs(next[k] - from[k]) / Math.abs(to[k] - from[k])).toBeLessThan(0.2) // 首帧移动 < 20%
      }
    }
  })

  it('插值单调收敛，约 5 秒内到位', () => {
    const to = targetParams('speaking', 0.7)
    let cur = targetParams('idle', 0)
    let prevGap = Infinity
    for (let i = 0; i < 300; i++) {
      cur = stepParams(cur, to, 1 / 60)
      const gap = Math.abs(cur.speed - to.speed)
      expect(gap).toBeLessThanOrEqual(prevGap)
      prevGap = gap
    }
    expect(paramsSettled(cur, to, 0.01)).toBe(true)
  })

  it('帧率无关：两个半帧 == 一个整帧（掉帧时动画速度不变）', () => {
    const from = targetParams('idle', 0)
    const to = targetParams('listening', 1)
    const once = stepParams(from, to, 1 / 30)
    const twice = stepParams(stepParams(from, to, 1 / 60), to, 1 / 60)
    for (const k of PARAM_KEYS) expect(twice[k]).toBeCloseTo(once[k], 9)
    expect(stepParams(from, to, -1)).toEqual(from) // 负 dt（时钟回拨）不动
  })

  it('音量包络：起音快、释放慢', () => {
    const up = smoothLevel(0, 1, 0.05)
    const down = 1 - smoothLevel(1, 0, 0.05)
    expect(up).toBeGreaterThan(down)
    expect(up).toBeLessThan(1)
  })

  it('RMS → 视觉音量：底噪归零、满量程封顶、单调', () => {
    expect(rmsToLevel(0)).toBe(0)
    expect(rmsToLevel(0.01)).toBe(0)
    expect(rmsToLevel(0.5)).toBe(1)
    expect(rmsToLevel(0.05)).toBeLessThan(rmsToLevel(0.1))
  })
})

describe('Presence 组件', () => {
  let loader
  beforeEach(() => {
    resetWebglProbe()
    loader = vi.fn(async () => ({ createPresenceRenderer: () => null }))
    setPresenceGLLoader(loader)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetWebglProbe()
  })

  it('默认是可访问的图形，名称随状态变化；decorative 时对读屏隐藏', () => {
    stubReducedMotion(false)
    const { rerender } = render(<Presence />)
    expect(screen.getByRole('img', { name: '贾维斯：待命' })).toHaveAttribute('data-state', 'idle')
    rerender(<Presence state="thinking" />)
    expect(screen.getByRole('img', { name: '贾维斯：思考中' })).toHaveClass('is-thinking')
    rerender(<Presence state="bogus" decorative />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(document.querySelector('.jv-presence')).toHaveAttribute('aria-hidden', 'true')
  })

  it('音量驱动：listening + 高音量时球体被平滑放大（CSS 版只写 transform）', async () => {
    stubReducedMotion(false)
    render(<Presence state="listening" getLevel={() => 1} size={40} />)
    await sleep(250)
    const t = document.querySelector('.jvp-body').style.transform
    const s = Number(/scale\(([\d.]+)\)/.exec(t)?.[1])
    expect(s).toBeGreaterThan(1.02)
    expect(s).toBeLessThanOrEqual(1.16 + 1e-6)
  })

  it('减弱动态：静态 CSS 版，不跑帧驱动、不加载 WebGL', async () => {
    stubReducedMotion(true)
    stubWebGL()
    render(<Presence state="listening" level={1} size={200} />)
    const root = screen.getByRole('img')
    expect(root).toHaveClass('is-reduced')
    expect(root.querySelector('canvas')).toBeNull()
    await sleep(450)
    expect(root.querySelector('.jvp-body').style.transform).toBe('')
    expect(loader).not.toHaveBeenCalled()
  })

  it('支持 WebGL 且非减弱动态时，首屏之后才懒加载 WebGL 版；小尺寸和 quality="css" 不加载', async () => {
    stubReducedMotion(false)
    stubWebGL()
    render(<Presence size={20} />)
    render(<Presence size={200} quality="css" />)
    await sleep(450)
    expect(loader).not.toHaveBeenCalled()
    cleanup()
    render(<Presence size={200} />)
    expect(loader).not.toHaveBeenCalled() // 不阻塞首屏
    await sleep(450)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.jv-presence')).not.toHaveClass('gl-ready') // 渲染器建不起来就留在 CSS 版
  })

  it('没有 WebGL 的环境不去探 getContext，留在 CSS 版', async () => {
    stubReducedMotion(false)
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    render(<Presence size={200} />)
    await sleep(450)
    expect(spy).not.toHaveBeenCalled()
    expect(loader).not.toHaveBeenCalled()
  })
})

describe('EdgeGlow 屏幕边缘流光', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('四条边、对读屏隐藏；减弱动态时标记静态', () => {
    stubReducedMotion(true)
    render(<EdgeGlow state="speaking" level={0.5} />)
    const el = document.querySelector('.jv-edge')
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(el).toHaveClass('is-reduced', 'is-speaking', 'on')
    expect(el.querySelectorAll('.jve-s')).toHaveLength(4)
  })
})

describe('全局花纹时钟', () => {
  it('只由时间决定：同一时刻处处相同，相位按待命流速前进，呼吸在 ±2.2% 内', () => {
    expect(presenceClock(5000)).toEqual(presenceClock(5000))
    const a = presenceClock(1000)
    const b = presenceClock(3000)
    expect(b.phase - a.phase).toBeCloseTo(targetParams('idle').speed * 2, 10)
    expect(b.time - a.time).toBeCloseTo(2, 10)
    for (const t of [0, 700, 1400, 2800]) {
      const { breath } = presenceClock(t)
      expect(Math.abs(breath - 1)).toBeLessThanOrEqual(0.0221)
    }
  })
})
