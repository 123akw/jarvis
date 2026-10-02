import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Toolbox from '../Toolbox.jsx'
import { moveItem } from './engine.js'
import { DOCK_ID, DndRoot, flyToDock, useDockDrop, useDragSource } from './index.jsx'

/* 最小测试页：几张假卡 + 一张套装卡 + Toolbox，包在 DndRoot 里；不依赖版面代理的组件。
 * jsdom 没有布局：用 setRect 给卡片 / Dock 摆好位置（视口 1024×768，底部 120px 即 y ≥ 648 都算放置区）。 */

const PLUGINS = [
  { id: 'weather', name: '查天气', icon: '🌤️', kind: 'tool' },
  { id: 'todo', name: '待办清单', icon: '✅', kind: 'tool' },
  { id: 'memo', name: '随手记', icon: '📝', kind: 'tool' },
  { id: 'amap', name: '高德地图', icon: '🗺️', kind: 'mcp', blocked: '需要管理员配置' },
  { id: 'weekly', name: '周报写手', icon: '🗓️', kind: 'skill' },
]
const byId = new Map(PLUGINS.map(p => [p.id, p]))
const BUNDLE = { id: 'shop', title: '店主套装', icon: '🏪', ids: ['memo', 'todo', 'weather', 'amap'] }

function FakeCard({ p, onAddClick, onOpen }) {
  const { dragProps } = useDragSource({ id: p.id, kind: 'plugin' })
  return (
    <article aria-label={p.name} {...dragProps} onClick={() => onOpen?.(p.id)}>
      <span className="jvm-card-icon" aria-hidden="true">{p.icon}</span>
      <h4>{p.name}</h4>
      <button type="button" aria-label={`加入工具箱：${p.name}`} onClick={e => { e.stopPropagation(); flyToDock(e.currentTarget, { icon: p.icon }); onAddClick(p.id) }}>+</button>
    </article>
  )
}

function FakeBundle() {
  const { dragProps } = useDragSource({ id: BUNDLE.id, ids: BUNDLE.ids, kind: 'bundle' })
  return (
    <article aria-labelledby="b-shop" {...dragProps}>
      <span className="jvm-bundle-icon" aria-hidden="true">{BUNDLE.icon}</span>
      <h3 id="b-shop">{BUNDLE.title}</h3>
      <ul data-dnd-icons="">{BUNDLE.ids.map(id => <li key={id}>{byId.get(id).icon}</li>)}</ul>
    </article>
  )
}

function Page({ initial = [], spy = {}, withRoot = true }) {
  const [picked, setPicked] = useState(initial)
  const canAdd = id => (picked.includes(id) ? '已在工具箱' : byId.get(id)?.blocked || '')
  const onAdd = (ids, meta) => { spy.onAdd?.(ids, meta); setPicked(v => [...new Set([...v, ...ids])]) }
  const onReorder = (from, to) => { spy.onReorder?.(from, to); setPicked(v => moveItem(v, from, to)) }
  const onRemove = id => { spy.onRemove?.(id); setPicked(v => v.filter(x => x !== id)) }
  const onMove = (id, dir) => {
    spy.onMove?.(id, dir)
    setPicked(v => { const i = v.indexOf(id); return i < 0 ? v : moveItem(v, i, i + dir) })
  }
  const body = (
    <>
      {PLUGINS.map(p => <FakeCard key={p.id} p={p} onAddClick={id => onAdd([id])} onOpen={spy.onOpen} />)}
      <FakeBundle />
      <Toolbox plugins={picked.map(id => byId.get(id))} onRemove={onRemove} onMove={onMove} onClear={() => setPicked([])}
        onOpen={() => {}} action={{ label: '下一步', onClick() {} }} />
    </>
  )
  return withRoot ? <DndRoot onAdd={onAdd} canAdd={canAdd} onReorder={onReorder} onRemove={onRemove}>{body}</DndRoot> : body
}

function setRect(el, { left = 0, top = 0, width = 100, height = 40 }) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} })
}
const dock = () => document.getElementById(DOCK_ID)
const card = name => screen.getByRole('article', { name })
/** 摆位置：卡片竖着排（每张 80 高），Dock 在底部 */
function layout() {
  screen.getAllByRole('article').forEach((a, i) => {
    setRect(a, { left: 16, top: 20 + i * 80, width: 360, height: 72 })
    const ic = a.querySelector('.jvm-card-icon,.jvm-bundle-icon')
    if (ic) setRect(ic, { left: 28, top: 32 + i * 80, width: 44, height: 44 })
  })
  setRect(dock(), { left: 192, top: 680, width: 640, height: 76 })
}
const P = (type = 'mouse') => ({ pointerId: 1, pointerType: type, isPrimary: true, button: 0 })
const down = (el, x, y, type) => fireEvent.pointerDown(el, { ...P(type), clientX: x, clientY: y })
const move = (x, y, type) => fireEvent.pointerMove(window, { ...P(type), clientX: x, clientY: y })
const up = (x, y, type) => fireEvent.pointerUp(window, { ...P(type), clientX: x, clientY: y })
const live = () => document.querySelector('.jvd-live')
const ghost = () => document.querySelector('.jvd-ghost')
/** 用鼠标把卡片拖到 (x, y) 松手 */
function drag(el, x, y) {
  down(el, 100, 50)
  move(110, 60)
  move(x, y)
  up(x, y)
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => '1', setItem() {}, removeItem() {} })   // 第一次用法提示视为看过
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete Element.prototype.animate
  delete window.matchMedia
  delete navigator.vibrate
  document.body.className = ''
})

describe('拖入 Dock', () => {
  it('鼠标：移动不到 5px 不算拖；拖起有药丸与占位，Dock 进入接收态；松手在 Dock 内调 onAdd 并播报', () => {
    const spy = { onAdd: vi.fn() }
    render(<Page spy={spy} />)
    layout()
    const c = card('查天气')
    down(c, 100, 50)
    move(103, 52)                       // 3.6px：还算点击
    expect(ghost()).toBeNull()
    expect(c).toHaveAttribute('data-dnd', 'pressing')
    move(110, 60)
    expect(ghost()).not.toBeNull()
    expect(ghost()).toHaveTextContent('查天气')
    expect(c).toHaveAttribute('data-dnd', 'dragging')
    expect(document.body).toHaveClass('jvd-dragging')
    expect(dock()).toHaveAttribute('data-dock', 'ready')
    expect(dock()).toHaveTextContent('拖到这里加入')
    expect(live()).toHaveTextContent('已拿起「查天气」。拖到底部工具箱松手即可加入，按 Esc 取消。')

    move(500, 700)
    expect(dock()).toHaveAttribute('data-dock', 'over')
    expect(dock()).toHaveTextContent('松手加入 · 将有 1 个')
    expect(dock().querySelector('[data-dock-slot]')).not.toBeNull()       // 图标行末尾撑开空位
    expect(ghost()).toHaveClass('is-over')
    expect(live()).toHaveTextContent('在工具箱上方，松手加入。')

    up(500, 700)
    expect(spy.onAdd).toHaveBeenCalledWith(['weather'], { id: 'weather', kind: 'plugin', label: '查天气' })
    const box = screen.getByRole('region', { name: '工具箱' })
    expect(box).toHaveTextContent('已选 1 个')
    expect(box).toHaveTextContent('已加入「查天气」，工具箱共 1 个。')
    expect(ghost()).toBeNull()
    expect(c).toHaveAttribute('data-dnd', 'idle')
    expect(dock()).toHaveAttribute('data-dock', 'idle')
    expect(document.body).not.toHaveClass('jvd-dragging')
  })

  it('视口底部 120px 整条都算放置区（不必正好落在 Dock 上）', () => {
    const spy = { onAdd: vi.fn() }
    render(<Page spy={spy} />)
    layout()
    drag(card('随手记'), 20, 660)          // Dock 左边外面，但在底部 120px 内
    expect(spy.onAdd).toHaveBeenCalledWith(['memo'], expect.objectContaining({ id: 'memo' }))
  })

  it('在 Dock 外松手：不加入，药丸回原位，播报取消；拖完紧接着的 click 被吞掉（不误开详情）', () => {
    const spy = { onAdd: vi.fn(), onOpen: vi.fn() }
    render(<Page spy={spy} />)
    layout()
    const c = card('查天气')
    drag(c, 300, 300)
    fireEvent.click(c)
    expect(spy.onAdd).not.toHaveBeenCalled()
    expect(spy.onOpen).not.toHaveBeenCalled()
    expect(ghost()).toBeNull()
    expect(c).toHaveAttribute('data-dnd', 'idle')
    expect(live()).toHaveTextContent('已取消，「查天气」放回原处。')
  })

  it('没拖起来的就是普通点击：详情照开；「+」按钮按下去不会起拖', () => {
    const spy = { onAdd: vi.fn(), onOpen: vi.fn() }
    render(<Page spy={spy} />)
    layout()
    const c = card('待办清单')
    down(c, 100, 50)
    up(100, 50)
    fireEvent.click(c)
    expect(spy.onOpen).toHaveBeenCalledWith('todo')
    const plus = within(c).getByRole('button', { name: '加入工具箱：待办清单' })
    down(plus, 100, 50)
    move(300, 700)
    expect(ghost()).toBeNull()
    up(300, 700)
    expect(spy.onAdd).not.toHaveBeenCalled()
  })

  it('套装：拖入一次加入多个；跳过已在工具箱的和不能加的；角标是会新加的个数', () => {
    const spy = { onAdd: vi.fn() }
    render(<Page spy={spy} initial={['todo']} />)
    layout()
    const b = card('店主套装')
    down(b, 100, 380)
    move(110, 390)
    expect(ghost().querySelector('.jvd-ghost-icon.is-fan')).not.toBeNull()   // 前 3 个图标扇形叠放
    expect(ghost().querySelector('.jvd-ghost-badge')).toHaveTextContent('2')
    move(500, 700)
    expect(ghost().querySelector('.jvd-ghost-badge')).toHaveTextContent('+2')
    expect(dock()).toHaveTextContent('松手加入 · 将有 3 个')
    up(500, 700)
    expect(spy.onAdd).toHaveBeenCalledWith(['memo', 'weather'], { id: 'shop', kind: 'bundle', label: '店主套装' })
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('已加入 2 个插件，工具箱共 3 个。')
  })

  it('canAdd 给出原因：起拖就显示原因，越过时 reject、角标 ⦸，松手放回原处、不调 onAdd，并播报原因', () => {
    const spy = { onAdd: vi.fn() }
    render(<Page spy={spy} />)
    layout()
    const c = card('高德地图')
    down(c, 100, 280)
    move(110, 290)
    expect(dock()).toHaveAttribute('data-dock', 'ready')
    expect(dock()).toHaveAttribute('data-dock-tone', 'deny')
    expect(dock()).toHaveTextContent('需要管理员配置')
    move(500, 700)
    expect(dock()).toHaveAttribute('data-dock', 'reject')
    expect(dock().querySelector('[data-dock-slot]')).toBeNull()          // 不撑空位
    expect(ghost().querySelector('.jvd-ghost-badge')).toHaveTextContent('⦸')
    expect(live()).toHaveTextContent('不能加入：需要管理员配置。')
    up(500, 700)
    expect(spy.onAdd).not.toHaveBeenCalled()
    expect(live()).toHaveTextContent('「高德地图」需要管理员配置，不能加入，已放回原处。')
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('需要管理员配置')   // Dock 上方提示条 2.6s
    expect(c).toHaveAttribute('data-dnd', 'idle')
  })

  it('已在工具箱：灰色态，松手不加入', () => {
    const spy = { onAdd: vi.fn() }
    render(<Page spy={spy} initial={['weather']} />)
    layout()
    const c = card('查天气')
    down(c, 100, 50)
    move(110, 60)
    expect(dock()).toHaveAttribute('data-dock-tone', 'same')
    move(500, 700)
    expect(dock()).toHaveAttribute('data-dock', 'reject')
    up(500, 700)
    expect(spy.onAdd).not.toHaveBeenCalled()
    expect(live()).toHaveTextContent('「查天气」已在工具箱，已放回原处。')
  })

  it('Esc 取消拖动；pointercancel 也取消', () => {
    const spy = { onAdd: vi.fn() }
    render(<Page spy={spy} />)
    layout()
    const c = card('随手记')
    down(c, 100, 200)
    move(110, 210)
    move(500, 700)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(ghost()).toBeNull()
    up(500, 700)
    expect(spy.onAdd).not.toHaveBeenCalled()
    expect(live()).toHaveTextContent('已取消，「随手记」放回原处。')

    down(c, 100, 200)
    move(110, 210)
    fireEvent.pointerCancel(window, P())
    expect(ghost()).toBeNull()
    expect(spy.onAdd).not.toHaveBeenCalled()
  })
})

describe('拖拽源本身是按钮', () => {
  it('根元素是 <button> 时，从它里面的文字按下照样能拖（只忽略嵌在卡片里的按钮）', () => {
    const onAdd = vi.fn()
    function ButtonCard() {
      const { dragProps } = useDragSource({ id: 'memo', label: '随手记', icon: '📝' })
      return <button type="button" {...dragProps}><span className="jvm-card-icon">📝</span><span>随手记</span></button>
    }
    render(
      <DndRoot onAdd={onAdd} canAdd={() => ''}>
        <ButtonCard />
        <Toolbox plugins={[]} onRemove={() => {}} onMove={() => {}} onClear={() => {}} onOpen={() => {}} />
      </DndRoot>,
    )
    setRect(dock(), { left: 192, top: 680, width: 640, height: 76 })
    const btn = screen.getByRole('button', { name: '📝随手记' })
    setRect(btn, { left: 16, top: 20, width: 200, height: 60 })
    down(btn.lastChild, 60, 40)
    move(70, 50)
    expect(ghost()).toHaveTextContent('随手记')
    move(400, 700)
    up(400, 700)
    expect(onAdd).toHaveBeenCalledWith(['memo'], expect.objectContaining({ id: 'memo' }))
  })
})

describe('触屏', () => {
  it('长按 350ms 才拖起（震一下）；之前移动超过 8px 视为滚动，放弃', () => {
    vi.useFakeTimers()
    navigator.vibrate = vi.fn()
    const spy = { onAdd: vi.fn() }
    render(<Page spy={spy} />)
    layout()
    const c = card('周报写手')
    // 滑动：350ms 内移动 20px → 交还给滚动
    down(c, 100, 360, 'touch')
    move(100, 380, 'touch')
    act(() => { vi.advanceTimersByTime(400) })
    expect(ghost()).toBeNull()
    expect(c).toHaveAttribute('data-dnd', 'idle')
    up(100, 380, 'touch')

    // 长按：按住时 pressing，抖 3px 不算移动，350ms 后拖起
    down(c, 100, 360, 'touch')
    expect(c).toHaveAttribute('data-dnd', 'pressing')
    move(102, 362, 'touch')
    act(() => { vi.advanceTimersByTime(340) })
    expect(ghost()).toBeNull()
    act(() => { vi.advanceTimersByTime(20) })
    expect(ghost()).not.toBeNull()
    expect(navigator.vibrate).toHaveBeenCalledWith(10)
    expect(c).toHaveAttribute('data-dnd', 'dragging')
    // 拖起后页面不跟着滚
    const tm = new Event('touchmove', { cancelable: true })
    window.dispatchEvent(tm)
    expect(tm.defaultPrevented).toBe(true)
    move(400, 720, 'touch')
    up(400, 720, 'touch')
    expect(spy.onAdd).toHaveBeenCalledWith(['weekly'], expect.anything())
    // 不拖的时候 touchmove 不拦
    const free = new Event('touchmove', { cancelable: true })
    window.dispatchEvent(free)
    expect(free.defaultPrevented).toBe(false)
  })
})

describe('flyToDock', () => {
  const animated = () => {
    Element.prototype.animate = vi.fn(function animate() { return { finished: Promise.resolve(), cancel() {} } })
  }
  it('点「+」：从卡片图标复制一个图标飞向 Dock，到达后移除', async () => {
    animated()
    render(<Page />)
    layout()
    const plus = within(card('查天气')).getByRole('button', { name: '加入工具箱：查天气' })
    const p = flyToDock(plus, { icon: '🌤️' })
    const fly = document.querySelector('.jvd-fly')
    expect(fly).not.toBeNull()
    expect(fly).toHaveTextContent('🌤️')
    expect(Element.prototype.animate).toHaveBeenCalled()
    await expect(p).resolves.toBe(true)
    expect(document.querySelector('.jvd-fly')).toBeNull()
  })

  it('prefers-reduced-motion：不飞', async () => {
    animated()
    window.matchMedia = vi.fn(q => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }))
    render(<Page />)
    layout()
    const p = flyToDock(card('查天气'), { icon: '🌤️' })
    expect(document.querySelector('.jvd-fly')).toBeNull()
    await expect(p).resolves.toBe(false)
    expect(Element.prototype.animate).not.toHaveBeenCalled()
  })

  it('没有 Dock / 元素不可见 / 浏览器不支持动画：什么都不做', async () => {
    render(<div><span className="jvm-card-icon">🌤️</span></div>)
    await expect(flyToDock(document.querySelector('.jvm-card-icon'))).resolves.toBe(false)
    render(<Page />)                                         // 有 Dock，但 jsdom 没有 animate
    layout()
    await expect(flyToDock(card('查天气'))).resolves.toBe(false)
    expect(document.querySelector('.jvd-fly')).toBeNull()
  })
})

describe('没有 DndRoot', () => {
  it('useDragSource / useDockDrop 退化成无事发生（页面照常可用）', () => {
    let drop = null
    function Probe() {
      drop = useDockDrop()
      const { dragProps, isDragging } = useDragSource({ id: 'x' })
      return <div data-testid="probe" {...dragProps}>{String(isDragging)}</div>
    }
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
    expect(drop.dropProps.id).toBe(DOCK_ID)
    expect(drop).toMatchObject({ isOver: false, dragging: null, reason: '' })
  })
})
