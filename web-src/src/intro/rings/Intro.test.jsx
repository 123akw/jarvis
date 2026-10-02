import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Intro from './Intro.jsx'
import { estimateOrbSize, estimateTarget, measureTarget } from './target.js'
import {
  CSS_S, MAX_TOTAL_MS, READY_DEADLINE_MS, REDUCED_MS, SCENE_S, distanceForSize, ringFit, sceneState, springSettle,
} from './timeline.js'

const never = () => new Promise(() => {})
const modeOf = c => c.querySelector('.ir-root')?.dataset.mode

/** 假 3D 场景：挂载后 delay 毫秒「画出首帧」 */
function fakeScene(delay = 0) {
  return function FakeScene({ onReady }) {
    useEffect(() => {
      const id = setTimeout(() => onReady(performance.now()), delay)
      return () => clearTimeout(id)
    }, [onReady])
    return <div data-testid="fake-scene" />
  }
}

async function advance(ms) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('rings 进场：编排与兜底', () => {
  it('three 迟迟加载不出来：先出预备画面，700ms 超时切 CSS 版，onDone 在 3.5s 内被调用且只调一次', async () => {
    const onDone = vi.fn()
    const { container } = render(<Intro onDone={onDone} loadScene={never} canUse3D={() => true} reducedMotion={false} />)
    expect(modeOf(container)).toBe('preroll')
    expect(container.querySelector('.ir-ember')).not.toBeNull()   // 立刻有画面，不是黑屏等 three
    await advance(READY_DEADLINE_MS - 20)
    expect(modeOf(container)).toBe('preroll')
    await advance(40)
    expect(modeOf(container)).toBe('css')
    expect(container.querySelector('.ir-css .ir-cring')).not.toBeNull()
    expect(onDone).not.toHaveBeenCalled()
    await advance(MAX_TOTAL_MS - READY_DEADLINE_MS - 20)
    expect(onDone).toHaveBeenCalledTimes(1)
    await advance(5000)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('3D 场景在 700ms 内画出首帧：播 3D 版，首帧起 2.75s 调 onDone', async () => {
    const onDone = vi.fn()
    const Scene = fakeScene(150)
    const { container, getByTestId } = render(
      <Intro onDone={onDone} loadScene={() => Promise.resolve({ default: Scene })} canUse3D={() => true} reducedMotion={false} />,
    )
    await advance(10)                               // 模块到位 → 场景挂载（act 结束时提交）
    expect(modeOf(container)).toBe('preroll')
    await advance(200)
    expect(modeOf(container)).toBe('3d')
    expect(getByTestId('fake-scene')).toBeTruthy()
    await advance(SCENE_S * 1000 - 100)
    expect(onDone).not.toHaveBeenCalled()
    await advance(200)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('3D 模块到了但首帧晚于 700ms：放弃 3D（卸掉画布）走 CSS 版，总时长仍 ≤3.5s', async () => {
    const onDone = vi.fn()
    const Scene = fakeScene(900)
    const { container, queryByTestId } = render(
      <Intro onDone={onDone} loadScene={() => Promise.resolve({ default: Scene })} canUse3D={() => true} reducedMotion={false} />,
    )
    await advance(10)
    expect(queryByTestId('fake-scene')).not.toBeNull()
    await advance(READY_DEADLINE_MS)
    expect(modeOf(container)).toBe('css')
    expect(queryByTestId('fake-scene')).toBeNull()
    await advance(MAX_TOTAL_MS)
    expect(modeOf(container)).toBe('css')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('加载失败或没有 WebGL2：直接走 CSS 版，onDone 照常调用', async () => {
    const a = vi.fn()
    const r1 = render(<Intro onDone={a} loadScene={() => Promise.reject(new Error('chunk 404'))} canUse3D={() => true} reducedMotion={false} />)
    await advance(10)
    expect(modeOf(r1.container)).toBe('css')
    await advance(CSS_S * 1000 + 10)
    expect(a).toHaveBeenCalledTimes(1)
    r1.unmount()

    const b = vi.fn()
    const load = vi.fn(never)
    const r2 = render(<Intro onDone={b} loadScene={load} canUse3D={() => false} reducedMotion={false} />)
    expect(modeOf(r2.container)).toBe('css')
    expect(load).not.toHaveBeenCalled()            // 不支持就不去拉 three
    await advance(CSS_S * 1000 + 10)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('减弱动态：不加载 3D，只做 600ms 淡入后结束', async () => {
    const onDone = vi.fn()
    const load = vi.fn(never)
    const { container } = render(<Intro onDone={onDone} loadScene={load} canUse3D={() => true} reducedMotion />)
    expect(modeOf(container)).toBe('reduced')
    expect(container.querySelector('.ir-orb-at .jv-presence')).not.toBeNull()   // 直接是登录页同款光球
    expect(load).not.toHaveBeenCalled()
    await advance(REDUCED_MS - 10)
    expect(onDone).not.toHaveBeenCalled()
    await advance(20)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('播放中被跳过（卸载）：清掉计时器，之后不再回调 onDone', async () => {
    const onDone = vi.fn()
    const { unmount } = render(<Intro onDone={onDone} loadScene={never} canUse3D={() => true} reducedMotion={false} />)
    await advance(900)
    unmount()
    await advance(5000)
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('rings 时间轴', () => {
  it('最坏情况总时长 ≤ 3.5s', () => {
    expect(READY_DEADLINE_MS + SCENE_S * 1000).toBeLessThanOrEqual(MAX_TOTAL_MS)
    expect(READY_DEADLINE_MS + CSS_S * 1000).toBeLessThanOrEqual(MAX_TOTAL_MS)
  })

  it('起始帧：只有一点白热微光，环不可见、未点火、镜头在深空', () => {
    const st = sceneState(0)
    expect(st.ignite).toBe(0)
    expect(st.flash).toBe(0)
    expect(st.dolly).toBe(0)
    expect(st.pan).toBe(0)
    expect(st.coreScale).toBeCloseTo(0.3)
    st.rings.forEach(r => expect(r.appear).toBe(0))
  })

  it('定格帧：环全部消散，光球回到登录页 idle 参数（energy .28 / halo .5 / 原大），镜头到位', () => {
    const st = sceneState(SCENE_S)
    st.rings.forEach(r => expect(r.appear).toBe(0))
    expect(st.ignite).toBe(1)
    expect(st.coreScale).toBe(1)
    expect(st.energy).toBeCloseTo(0.28, 5)
    expect(st.halo).toBeCloseTo(0.5, 5)
    expect(st.flash).toBeLessThan(0.01)
    expect(st.dolly).toBe(1)
    expect(st.pan).toBe(1)
    expect(st.bloom).toBe(0)
    expect(st.dust).toBe(0)
    expect(st.ambient).toBe(1)
    expect(st.pulse.alpha).toBe(0)
  })

  it('环在点火前已基本对齐（剩余偏转 < 10°），之后才开始扩散', () => {
    const st = sceneState(1.5)
    st.rings.forEach(r => {
      expect(Math.abs(r.angle)).toBeLessThan((10 * Math.PI) / 180)
      expect(r.appear).toBeGreaterThan(0.9)
      expect(r.out).toBe(0)
    })
  })

  it('对齐弹簧从静止起步、有界、终点为 1', () => {
    expect(springSettle(0)).toBe(0)
    expect(springSettle(1)).toBe(1)
    for (let t = 0; t <= 1; t += 0.01) {
      expect(springSettle(t)).toBeGreaterThanOrEqual(0)
      expect(springSettle(t)).toBeLessThan(1.06)
    }
  })

  it('镜头距离反算：半径 1 的球在画面上正好是目标直径', () => {
    for (const [size, H] of [[210, 900], [164, 844]]) {
      const d = distanceForSize(size, H, 28)
      const px = (H / 2) * Math.tan(Math.asin(1 / d)) / Math.tan((14 * Math.PI) / 180) * 2
      expect(px).toBeCloseTo(size, 3)
    }
    const fit = ringFit(390, 844, 30, 28, 2.6)
    expect(fit).toBeGreaterThanOrEqual(0.9)
    expect(fit).toBeLessThanOrEqual(1.5)
  })
})

describe('rings 落点', () => {
  it('估算与 Login.jsx 同公式：1440×900 → 210，390×844 → 164', () => {
    expect(estimateOrbSize(1440, 900)).toBe(210)
    expect(estimateOrbSize(390, 844)).toBe(164)
    const t = estimateTarget(1440, 900)
    expect(t.x).toBe(720)
    expect(Math.abs(t.y - 250)).toBeLessThan(3)
  })

  it('优先量登录页上真实的光球（中心取外接框，直径取 offsetWidth）', () => {
    const el = {
      offsetWidth: 164,
      getBoundingClientRect: () => ({ left: 113, top: 147.8, width: 164, height: 164 }),
    }
    const doc = { querySelector: sel => (sel === '.jvl-orb .jv-presence' ? el : null) }
    expect(measureTarget(doc, 390, 844)).toEqual({ x: 195, y: 229.8, size: 164, measured: true })
    expect(measureTarget({ querySelector: () => null }, 390, 844).measured).toBe(false)
  })
})
