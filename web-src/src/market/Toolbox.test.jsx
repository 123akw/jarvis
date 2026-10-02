import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { moveItem } from './dnd/engine.js'
import { DndRoot, useDragSource } from './dnd/index.jsx'
import Toolbox from './Toolbox.jsx'

/* 工具箱（Dock + 抽屉）：拖动排序、拖出 / 拖到删除区移除、撤销、键盘替代、播报、手机收起。
 * jsdom 没有布局：抽屉每行 44 高、间距 6（第 i 行 top = 100 + 50i），抽屉面板 y ∈ [40, 460]。 */

const PLUGINS = {
  weather: { id: 'weather', name: '查天气', icon: '🌤️', kind: 'tool' },
  todo: { id: 'todo', name: '待办清单', icon: '✅', kind: 'tool' },
  memo: { id: 'memo', name: '随手记', icon: '📝', kind: 'tool' },
  weekly: { id: 'weekly', name: '周报写手', icon: '🗓️', kind: 'skill' },
}

function Box({ initial = ['weather', 'todo', 'memo'], spy = {}, withRoot = true }) {
  const [picked, setPicked] = useState(initial)
  const onAdd = (ids, meta) => { spy.onAdd?.(ids, meta); setPicked(v => [...new Set([...v, ...ids])]) }
  const onReorder = (from, to) => { spy.onReorder?.(from, to); setPicked(v => moveItem(v, from, to)) }
  const onRemove = id => { spy.onRemove?.(id); setPicked(v => v.filter(x => x !== id)) }
  const onMove = (id, dir) => {
    spy.onMove?.(id, dir)
    setPicked(v => { const i = v.indexOf(id); return i < 0 || i + dir < 0 || i + dir >= v.length ? v : moveItem(v, i, i + dir) })
  }
  const toolbox = (
    <Toolbox plugins={picked.map(id => PLUGINS[id])} onRemove={onRemove} onMove={onMove} onClear={() => setPicked([])} onOpen={() => {}}
      action={{ label: '下一步', onClick() {} }} />
  )
  return withRoot ? <DndRoot onAdd={onAdd} onReorder={onReorder} onRemove={onRemove}>{toolbox}</DndRoot> : toolbox
}

function setRect(el, { left = 0, top = 0, width = 100, height = 40 }) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} })
}
function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: /^工具箱：已选/ }))
  const sheet = screen.getByRole('dialog', { name: '我的工具箱' })
  layout(sheet)
  return sheet
}
function layout(sheet) {
  setRect(sheet, { left: 0, top: 40, width: 400, height: 420 })
  const list = sheet.querySelector('ol')
  setRect(list, { left: 20, top: 100, width: 360, height: 250 })
  within(sheet).getAllByRole('listitem').forEach((li, i) => setRect(li, { left: 20, top: 100 + i * 50, width: 360, height: 44 }))
}
const order = sheet => within(sheet).getAllByRole('listitem').map(li => li.getAttribute('data-id'))
const row = (sheet, id) => sheet.querySelector(`[data-id="${id}"]`)
const P = (type = 'mouse') => ({ pointerId: 1, pointerType: type, isPrimary: true, button: 0 })
const down = (el, x, y, type) => fireEvent.pointerDown(el, { ...P(type), clientX: x, clientY: y })
const move = (x, y, type) => fireEvent.pointerMove(window, { ...P(type), clientX: x, clientY: y })
const up = (x, y, type) => fireEvent.pointerUp(window, { ...P(type), clientX: x, clientY: y })
const ghost = () => document.querySelector('.jvd-ghost')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete window.matchMedia
  document.body.className = ''
})

describe('工具箱抽屉：拖动排序', () => {
  it('拖第 1 行到第 3 行：邻居让位、原位留虚线空位；松手调 onReorder(0, 2)，播报新位置', () => {
    const spy = { onReorder: vi.fn() }
    render(<Box spy={spy} />)
    const sheet = openDrawer()
    const first = row(sheet, 'weather')
    down(first, 100, 122)
    move(100, 128)
    expect(ghost()).toHaveTextContent('查天气')
    expect(sheet.querySelector('.jvd-trash')).toHaveTextContent('拖到这里移除')     // 删除区在拖动时出现
    move(100, 230)
    expect(first).toHaveAttribute('data-sort', 'placeholder')
    expect(first.style.transform).toBe('translateY(100px)')
    expect(row(sheet, 'todo').style.transform).toBe('translateY(-50px)')
    expect(row(sheet, 'memo').style.transform).toBe('translateY(-50px)')
    up(100, 230)
    expect(spy.onReorder).toHaveBeenCalledWith(0, 2)
    expect(order(sheet)).toEqual(['todo', 'memo', 'weather'])
    expect(sheet).toHaveTextContent('「查天气」移到第 3 位')
    expect(ghost()).toBeNull()
    expect(first.style.transform).toBe('')                // 位移清干净，不残留
    expect(first).not.toHaveAttribute('data-sort')
    expect(sheet.querySelector('.jvd-trash')).toBeNull()
  })

  it('往回拖、拖回原位：不调 onReorder；Esc 取消且不关抽屉', () => {
    const spy = { onReorder: vi.fn() }
    render(<Box spy={spy} />)
    const sheet = openDrawer()
    down(row(sheet, 'memo'), 100, 222)
    move(100, 228)
    move(100, 150)
    expect(row(sheet, 'todo').style.transform).toBe('translateY(50px)')
    move(100, 222)
    up(100, 222)
    expect(spy.onReorder).not.toHaveBeenCalled()

    down(row(sheet, 'memo'), 100, 222)
    move(100, 228)
    move(100, 120)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(ghost()).toBeNull()
    up(100, 120)
    expect(spy.onReorder).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '我的工具箱' })).toBeInTheDocument()
    expect(order(sheet)).toEqual(['weather', 'todo', 'memo'])
  })

  it('抓手：触屏按住抓手不用长按，直接拖', () => {
    const spy = { onReorder: vi.fn() }
    render(<Box spy={spy} />)
    const sheet = openDrawer()
    const grip = row(sheet, 'memo').querySelector('.jvd-grip')
    down(grip, 30, 222, 'touch')
    move(30, 226, 'touch')
    expect(ghost()).not.toBeNull()
    move(30, 110, 'touch')
    up(30, 110, 'touch')
    expect(spy.onReorder).toHaveBeenCalledWith(2, 0)
  })

  it('没有 DndRoot、也没给 onReorder：退回用 onMove 一步步挪', () => {
    const spy = { onMove: vi.fn() }
    render(<Box spy={spy} withRoot={false} />)
    const sheet = openDrawer()
    down(row(sheet, 'weather'), 100, 122)
    move(100, 128)
    move(100, 230)
    up(100, 230)
    expect(spy.onMove.mock.calls).toEqual([['weather', 1], ['weather', 1]])
    expect(order(sheet)).toEqual(['todo', 'memo', 'weather'])
  })
})

describe('工具箱抽屉：拖出移除与撤销', () => {
  it('拖出抽屉面板：标「松手移除」，松手调 onRemove；5 秒内可撤销，回到原位置', () => {
    const spy = { onRemove: vi.fn(), onAdd: vi.fn() }
    render(<Box spy={spy} />)
    const sheet = openDrawer()
    down(row(sheet, 'todo'), 100, 172)
    move(100, 178)
    move(100, 10)                                           // 面板顶边 40 之上
    expect(ghost()).toHaveClass('is-removing')
    expect(ghost()).toHaveTextContent('松手移除')
    expect(sheet.querySelector('.jvd-trash')).toHaveTextContent('松手移除')
    expect(row(sheet, 'memo').style.transform).toBe('translateY(-50px)')   // 后面的补上空位
    up(100, 10)
    expect(spy.onRemove).toHaveBeenCalledWith('todo')
    expect(order(sheet)).toEqual(['weather', 'memo'])
    expect(sheet).toHaveTextContent('已移除「待办清单」，5 秒内可以撤销。')
    fireEvent.click(within(sheet).getByRole('button', { name: '撤销' }))
    expect(spy.onAdd).toHaveBeenCalledWith(['todo'], { id: 'todo', kind: 'plugin', restore: true, index: 1 })
    expect(order(sheet)).toEqual(['weather', 'todo', 'memo'])
    expect(sheet).toHaveTextContent('已撤销，「待办清单」回到第 2 位。')
    expect(within(sheet).queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('拖到删除区也移除；撤销提示 5 秒后消失', () => {
    vi.useFakeTimers()
    const spy = { onRemove: vi.fn() }
    render(<Box spy={spy} />)
    const sheet = openDrawer()
    down(row(sheet, 'memo'), 100, 222)
    move(100, 228)
    setRect(sheet.querySelector('.jvd-trash'), { left: 20, top: 380, width: 360, height: 48 })
    move(100, 400)
    expect(ghost()).toHaveClass('is-removing')
    up(100, 400)
    expect(spy.onRemove).toHaveBeenCalledWith('memo')
    expect(within(sheet).getByRole('button', { name: '撤销' })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(within(sheet).queryByRole('button', { name: '撤销' })).toBeNull()
  })
})

describe('Dock 上的小图标往上拖出 = 移除（macOS Dock）', () => {
  it('拖出不到 56px 放回；超过 56px 标「松手移除」，松手移除并给撤销；拖完不误开抽屉', () => {
    const spy = { onRemove: vi.fn(), onAdd: vi.fn() }
    render(<Box spy={spy} />)
    const dock = screen.getByRole('region', { name: '工具箱' })
    setRect(document.getElementById('jvm-dock-drop'), { left: 192, top: 680, width: 640, height: 64 })
    const icon = () => [...dock.querySelectorAll('.jvm-tray-icons i')].find(i => i.textContent === '✅')
    down(icon(), 230, 712)
    move(232, 700)
    expect(ghost()).toHaveTextContent('待办清单')
    expect(icon()).toHaveAttribute('data-pull', 'lifted')
    move(240, 650)                                  // 只高出 30px
    expect(ghost()).not.toHaveClass('is-removing')
    up(240, 650)
    fireEvent.click(dock.querySelector('.jvm-tray'))
    expect(screen.queryByRole('dialog')).toBeNull()  // 拖完那一下 click 被吞掉
    expect(spy.onRemove).not.toHaveBeenCalled()
    expect(icon()).not.toHaveAttribute('data-pull')

    down(icon(), 230, 712)
    move(232, 700)
    move(260, 600)
    expect(ghost()).toHaveClass('is-removing')
    expect(ghost()).toHaveTextContent('松手移除')
    up(260, 600)
    expect(spy.onRemove).toHaveBeenCalledWith('todo')
    expect(dock).toHaveTextContent('已移除「待办清单」，5 秒内可以撤销。')
    expect(dock).toHaveTextContent('已选 2 个')
    fireEvent.click(within(dock).getByRole('button', { name: '撤销' }))
    expect(spy.onAdd).toHaveBeenCalledWith(['todo'], expect.objectContaining({ restore: true, index: 1 }))
    expect(dock).toHaveTextContent('已选 3 个')
    expect(dock).toHaveTextContent('已撤销，「待办清单」回到第 2 位。')
  })
})

describe('键盘 / 读屏替代', () => {
  it('上移 / 下移 / 移除按钮照常可用，并播报；焦点不丢', async () => {
    render(<Box />)
    const sheet = openDrawer()
    fireEvent.click(within(sheet).getByRole('button', { name: '下移 查天气' }))
    expect(order(sheet)).toEqual(['todo', 'weather', 'memo'])
    expect(sheet).toHaveTextContent('「查天气」移到第 2 位')
    await waitFor(() => expect(within(sheet).getByRole('button', { name: '下移 查天气' })).toHaveFocus())
    fireEvent.click(within(sheet).getByRole('button', { name: '移除 查天气' }))
    expect(order(sheet)).toEqual(['todo', 'memo'])
    expect(sheet).toHaveTextContent('已移除「查天气」，5 秒内可以撤销。')
    await waitFor(() => expect(within(sheet).getByRole('button', { name: '移除 随手记' })).toHaveFocus())
    fireEvent.click(within(sheet).getByRole('button', { name: '撤销' }))
    expect(order(sheet)).toEqual(['todo', 'weather', 'memo'])
  })

  it('没有 onAdd 可用时不给撤销（不承诺做不到的事）', () => {
    render(<Box withRoot={false} />)
    const sheet = openDrawer()
    fireEvent.click(within(sheet).getByRole('button', { name: '移除 查天气' }))
    expect(within(sheet).queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('点「+」/ 整套加入后，Dock 播报「已加入 X，工具箱共 N 个」（初次渲染不播）', () => {
    function Adder() {
      const [ids, setIds] = useState(['weather'])
      return (
        <>
          <button type="button" onClick={() => setIds(v => [...v, 'todo'])}>加一个</button>
          <button type="button" onClick={() => setIds(v => [...v, 'memo', 'weekly'])}>加一套</button>
          <Toolbox plugins={ids.map(id => PLUGINS[id])} onRemove={() => {}} onMove={() => {}} onClear={() => {}} onOpen={() => {}} />
        </>
      )
    }
    render(<Adder />)
    const dock = screen.getByRole('region', { name: '工具箱' })
    expect(dock).not.toHaveTextContent('已加入')
    fireEvent.click(screen.getByRole('button', { name: '加一个' }))
    expect(dock).toHaveTextContent('已加入「待办清单」，工具箱共 2 个。')
    fireEvent.click(screen.getByRole('button', { name: '加一套' }))
    expect(dock).toHaveTextContent('已加入 2 个插件，工具箱共 4 个。')
  })
})

describe('手机：Dock 往下滚收起、往上滚展开', () => {
  it('窄屏滚动方向切换 is-mini；横向滚动不算；宽屏不收', () => {
    let narrow = true
    window.matchMedia = vi.fn(q => ({ get matches() { return q.includes('max-width') ? narrow : false }, media: q, addEventListener() {}, removeEventListener() {} }))
    render(<div data-testid="page"><Box /></div>)
    const page = screen.getByTestId('page')
    Object.defineProperty(page, 'clientHeight', { value: 800, configurable: true })
    Object.defineProperty(page, 'scrollHeight', { value: 4000, configurable: true })
    let top = 0
    Object.defineProperty(page, 'scrollTop', { get: () => top, configurable: true })
    const dock = screen.getByRole('region', { name: '工具箱' })
    const scrollTo = y => { top = y; fireEvent.scroll(page) }
    scrollTo(100)
    scrollTo(300)
    expect(dock).toHaveClass('is-mini')
    scrollTo(300)                     // 只有横向在动
    expect(dock).toHaveClass('is-mini')
    scrollTo(200)
    expect(dock).not.toHaveClass('is-mini')
    scrollTo(3300)                    // 滚到底：展开
    expect(dock).not.toHaveClass('is-mini')
    narrow = false
    scrollTo(600)
    scrollTo(900)
    expect(dock).not.toHaveClass('is-mini')
  })
})

describe('Dock 上方的提示让位于步骤提示 / 报错', () => {
  function Card() {
    const { dragProps } = useDragSource({ id: 'weekly', label: '周报写手', icon: '🗓️' })
    return <div data-testid="card" {...dragProps}>周报写手</div>
  }
  function Page({ hint }) {
    return (
      <DndRoot onAdd={() => {}}>
        <Card />
        <Toolbox plugins={[PLUGINS.todo]} onRemove={() => {}} onMove={() => {}} onClear={() => {}} onOpen={() => {}} hint={hint} />
      </DndRoot>
    )
  }

  it('第一次悬停的用法提示不盖住报错；没有报错时照常提示', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    const { rerender } = render(<Page hint="生成失败：网络断了，再试一次" />)
    fireEvent.pointerEnter(screen.getByTestId('card'), { pointerType: 'mouse' })
    expect(screen.getByRole('status')).toHaveTextContent('生成失败')
    expect(screen.queryByText(/拖到这里/)).toBeNull()
    rerender(<Page hint="" />)
    expect(screen.queryByText('生成失败：网络断了，再试一次')).toBeNull()
    vi.unstubAllGlobals()
  })
})
