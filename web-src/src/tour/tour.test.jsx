import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentAccount } from '../accountStorage.js'
import { INTRO_DONE_EVENT, setIntroPlaying } from '../intro/registry.js'
import { _resetController, getActive } from './controller.js'
import { holeFor, needsScroll, placeCard } from './geometry.js'
import { resetAllTours, startTour, TOUR_IDS, TourButton, TourLayer, useTour } from './index.jsx'
import { _resetStoreCache, LOCAL_KEY } from './store.js'
import { TOURS } from './tours.js'

/* 第十八轮·新手引导：自动开始只一次、跳过 / 看完都记录、重看不改记录、目标缺失跳步、键盘、
 * 等进场动画、同时只播一个、游客只用本机、登录走接口、接口失败退回本机 */

function memoryStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: k => { m.delete(k) }, clear: () => m.clear(), _map: m,
  }
}

const MARKET = ['market-search', 'market-card', 'market-dock', 'market-next']
const APP = ['app-input', 'app-cmdk', 'app-today', 'app-menu']

function Page({ id = 'market', ready = true, anchors = MARKET, auto = true }) {
  const { running } = useTour(id, { ready, auto })
  return (
    <div data-running={String(running)} data-testid={`page-${id}`}>
      {anchors.map(a => <button key={a} type="button" data-tour={a}>{a}</button>)}
    </div>
  )
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const seenLocal = (who = '') => JSON.parse(localStorage.getItem(who ? `${LOCAL_KEY}:${who}` : LOCAL_KEY) || '{}')
const dialog = () => screen.queryByRole('dialog')
const title = () => dialog()?.querySelector('.jv-tour-title')?.textContent

let fetchMock
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  fetchMock = vi.fn(async () => json({ error: 'not mocked' }, 404))
  vi.stubGlobal('fetch', fetchMock)
  setCurrentAccount('')
  setIntroPlaying(false)
  _resetController()
  _resetStoreCache()
})
afterEach(() => {
  cleanup()
  _resetController()
  setIntroPlaying(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('引导内容与接口形状', () => {
  it('TOUR_IDS 与 tours.js 一一对应；每步都有标题和不超过两句的说明', () => {
    expect(Object.keys(TOURS).sort()).toEqual([...TOUR_IDS].sort())
    for (const id of TOUR_IDS) {
      const steps = TOURS[id].steps
      expect(steps.length).toBeGreaterThanOrEqual(id === 'flows-editor' ? 5 : 3)
      for (const s of steps) {
        expect(s.title).toBeTruthy()
        expect(s.body.split(/[。！？]/).filter(x => x.trim()).length).toBeLessThanOrEqual(2)
        expect(s.body).not.toMatch(/[A-Za-z]{4,}/)   // 不出现英文工具名 / 术语（⌘K、⌘S 这类快捷键除外）
      }
    }
    expect(TOURS['flows-editor'].steps.map(s => s.target)).toEqual(
      ['flow-palette', 'flow-canvas', 'flow-node-start', 'flow-config', 'flow-var', 'flow-run', 'flow-save'])
    expect(TOURS['flows-home'].steps.map(s => s.target)).toEqual(['flows-new', 'flows-compose', 'flows-templates', 'flows-list'])
    expect(TOURS.market.steps.map(s => s.target)).toEqual(MARKET)
    expect(TOURS.app.steps.map(s => s.target)).toEqual(APP)
  })
})

describe('自动开始与记录（游客：只用本机）', () => {
  it('第一次 ready 自动开始；点「跳过」记 skipped；再打开页面不再自动出现', async () => {
    const user = userEvent.setup()
    const first = render(<><Page /><TourLayer /></>)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(title()).toBe('先搜一搜')
    expect(screen.getByTestId('page-market')).toHaveAttribute('data-running', 'true')
    expect(dialog()).toHaveTextContent('1 / 4')
    await user.click(screen.getByRole('button', { name: '跳过' }))
    expect(dialog()).toBeNull()
    expect(seenLocal().market.status).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()                 // 游客不打接口
    first.unmount()
    _resetController()                                     // 模拟重新打开页面
    _resetStoreCache()
    render(<><Page /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(dialog()).toBeNull()
  })

  it('一步步看完点「完成」记 done；ready 为假时不开始', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<><Page ready={false} /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(dialog()).toBeNull()
    rerender(<><Page ready /><TourLayer /></>)
    await screen.findByRole('dialog')
    for (const t of ['先搜一搜', '看中了就放进工具箱', '这是你的工具箱']) {
      expect(title()).toBe(t)
      await user.click(screen.getByRole('button', { name: '下一步' }))
    }
    expect(title()).toBe('下一步：起名生成')
    expect(screen.queryByRole('button', { name: '跳过' })).toBeNull()   // 最后一步只有上一步 / 完成
    await user.click(screen.getByRole('button', { name: '完成' }))
    expect(dialog()).toBeNull()
    expect(seenLocal().market.status).toBe('done')
  })

  it('同一次打开页面里只自动播一次（ready 来回变也不重播）', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<><Page /><TourLayer /></>)
    await screen.findByRole('dialog')
    localStorage.clear()                                  // 就算记录丢了
    _resetStoreCache()
    await user.keyboard('{Escape}')
    localStorage.clear()
    _resetStoreCache()
    rerender(<><Page ready={false} /><TourLayer /></>)
    rerender(<><Page ready /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(dialog()).toBeNull()
  })

  it('auto=false 只登记不自动开始；startTour / TourButton 随时重看，重看不改已有记录', async () => {
    const user = userEvent.setup()
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ market: { status: 'done', at: '2026-10-01T00:00:00Z' } }))
    render(<><Page auto={false} /><TourButton tour="market" /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(dialog()).toBeNull()
    await user.click(screen.getByRole('button', { name: '新手引导' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '跳过' }))
    expect(seenLocal().market).toEqual({ status: 'done', at: '2026-10-01T00:00:00Z' })   // 重看点跳过不改成 skipped
    act(() => { startTour('market') })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('没看过时手动看完也记上（之后不再自动出现）；不认识的引导 id 不开始', async () => {
    const user = userEvent.setup()
    render(<><Page auto={false} /><TourLayer /></>)
    act(() => { expect(startTour('nope')).toBe(false) })
    act(() => { startTour('market') })
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(seenLocal().market.status).toBe('skipped')
  })
})

describe('目标缺失', () => {
  it('某一步的目标等 1.5 秒还没有就跳过，步骤数随之减少', async () => {
    const user = userEvent.setup()
    render(<><Page anchors={['market-search', 'market-dock', 'market-next']} /><TourLayer /></>)
    await screen.findByRole('dialog')
    expect(dialog()).toHaveTextContent('1 / 4')
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await waitFor(() => expect(title()).toBe('这是你的工具箱'), { timeout: 2500 })
    expect(dialog()).toHaveTextContent('2 / 3')
    await user.click(screen.getByRole('button', { name: '上一步' }))   // 往回跳过缺失的那步
    expect(title()).toBe('先搜一搜')
  })

  it('目标晚一点才出现：等到就接着讲', async () => {
    function Late() {
      useTour('market', { ready: true })
      return <button type="button" data-tour="market-search">搜索</button>
    }
    render(<><Late /><TourLayer /></>)
    await screen.findByRole('dialog')
    const late = document.createElement('div')
    late.setAttribute('data-tour', 'market-card')
    try {
      fireEvent.click(screen.getByRole('button', { name: '下一步' }))
      expect(dialog()).not.toHaveClass('is-on')                  // 找目标时卡片先藏起来
      await act(async () => { await new Promise(r => setTimeout(r, 300)) })
      document.body.appendChild(late)
      await waitFor(() => expect(dialog()).toHaveClass('is-on'), { timeout: 1400 })
      expect(title()).toBe('看中了就放进工具箱')
      expect(dialog()).toHaveTextContent('2 / 4')
    } finally {
      late.remove()
    }
  })

  it('所有目标都找不到就不弹，也不记录（下次照样会出现）', async () => {
    render(<><Page anchors={[]} /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 1700)) })
    expect(dialog()).toBeNull()
    expect(getActive()).toBeNull()
    expect(seenLocal()).toEqual({})
  })

  it('第一步缺失时从第一个找得到的开始；被隐藏（hidden / inert）的元素不算', async () => {
    render(
      <>
        <div hidden><button type="button" data-tour="market-search">藏起来的</button></div>
        <Page anchors={['market-card']} />
        <TourLayer />
      </>,
    )
    await waitFor(() => expect(dialog()).toHaveClass('is-on'), { timeout: 2500 })
    expect(title()).toBe('看中了就放进工具箱')
    expect(dialog()).toHaveTextContent('1 / 3')                   // 前面缺的不算；后面的到了再看
    expect(screen.queryByRole('button', { name: '上一步' })).toBeNull()
  })
})

describe('键盘、焦点与读屏', () => {
  it('→ / ← 翻页、Esc 跳过；焦点在卡片里，结束后还给打开前的控件', async () => {
    const user = userEvent.setup()
    render(<><button type="button">原来的按钮</button><Page auto={false} /><TourLayer /></>)
    const origin = screen.getByRole('button', { name: '原来的按钮' })
    origin.focus()
    act(() => { startTour('market') })
    const box = await screen.findByRole('dialog')
    expect(box).toHaveAttribute('aria-modal', 'true')
    expect(box).toHaveAccessibleName('先搜一搜')
    expect(box).toHaveAccessibleDescription(/输入插件名字/)
    await waitFor(() => expect(box.contains(document.activeElement)).toBe(true))
    await user.keyboard('{ArrowRight}')
    expect(title()).toBe('看中了就放进工具箱')
    await user.keyboard('{ArrowRight}')
    await user.keyboard('{ArrowLeft}')
    expect(title()).toBe('看中了就放进工具箱')
    await user.tab()
    await user.tab()
    await user.tab()
    expect(box.contains(document.activeElement)).toBe(true)   // Tab 只在卡片里转
    await user.keyboard('{Escape}')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(origin)
    expect(seenLocal().market.status).toBe('skipped')
  })

  it('Esc 只给引导用：页面上别的 Esc 处理不会同时响应', async () => {
    const user = userEvent.setup()
    const onEsc = vi.fn()
    const listener = e => { if (e.key === 'Escape') onEsc() }
    window.addEventListener('keydown', listener)
    render(<><Page /><TourLayer /></>)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(onEsc).not.toHaveBeenCalled()
    window.removeEventListener('keydown', listener)
  })

  it('页面卸载时引导收起，不记录', async () => {
    const { rerender } = render(<><Page /><TourLayer /></>)
    await screen.findByRole('dialog')
    rerender(<><TourLayer /></>)
    expect(dialog()).toBeNull()
    expect(seenLocal()).toEqual({})
  })
})

describe('调度：进场动画与同时只播一个', () => {
  it('进场动画还在播时先不开始，播完（收到结束事件）再开始', async () => {
    setIntroPlaying(true)
    render(<><Page /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    expect(dialog()).toBeNull()
    act(() => {
      setIntroPlaying(false)
      window.dispatchEvent(new Event(INTRO_DONE_EVENT))
    })
    expect(dialog()).toBeNull()                                 // 等进场层淡出
    expect(await screen.findByRole('dialog', {}, { timeout: 1500 })).toBeInTheDocument()
  })

  it('两个页面都想自动开始：先播一个，结束后再播下一个', async () => {
    const user = userEvent.setup()
    render(<><Page /><Page id="app" anchors={APP} /><TourLayer /></>)
    await screen.findByRole('dialog')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(title()).toBe('先搜一搜')
    await user.click(screen.getByRole('button', { name: '跳过' }))
    await waitFor(() => expect(title()).toBe('有事直接说'))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('手动开始会打断正在播的（被打断的不记录）', async () => {
    render(<><Page /><Page id="app" anchors={APP} auto={false} /><TourLayer /></>)
    await screen.findByRole('dialog')
    act(() => { startTour('app') })
    await waitFor(() => expect(title()).toBe('有事直接说'))
    expect(seenLocal().market).toBeUndefined()
  })
})

describe('登录用户：走 /api/onboarding，失败退回本机', () => {
  function serverMock(seen = {}, { failGet = false, failPut = false } = {}) {
    const calls = []
    fetchMock.mockImplementation(async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase()
      const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ url: String(url), method, body, headers: init.headers || {} })
      if (method === 'GET') return failGet ? json({ error: '离线' }, 503) : json({ seen })
      if (failPut) throw new Error('offline')
      if (body.reset) { seen = {}; return json({ ok: true, seen }) }
      seen = { ...seen, [body.tour]: { status: body.status, at: 'now' } }
      return json({ ok: true, seen })
    })
    return calls
  }

  it('服务端没记录 → 自动开始；跳过 → PUT 记一笔并缓存到按账号区分的本机键', async () => {
    const user = userEvent.setup()
    setCurrentAccount('Alice')
    const calls = serverMock({})
    render(<><Page /><TourLayer /></>)
    await screen.findByRole('dialog')
    expect(calls[0]).toMatchObject({ url: '/api/onboarding', method: 'GET' })
    await user.click(screen.getByRole('button', { name: '跳过' }))
    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true))
    const put = calls.find(c => c.method === 'PUT')
    expect(put.body).toEqual({ tour: 'market', status: 'skipped' })
    expect(put.headers['Content-Type']).toBe('application/json')
    await waitFor(() => expect(seenLocal('alice').market).toEqual({ status: 'skipped', at: expect.any(String) }))
    expect(seenLocal()).toEqual({})                             // 不写游客键
  })

  it('服务端说看过 → 不自动开始（换设备也只出现一次）', async () => {
    setCurrentAccount('alice')
    serverMock({ market: { status: 'done', at: '2026-10-01' } })
    render(<><Page /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(dialog()).toBeNull()
    expect(seenLocal('alice').market.status).toBe('done')
  })

  it('接口读失败：用本机缓存决定；本机也没有就照常开始', async () => {
    setCurrentAccount('alice')
    serverMock({}, { failGet: true })
    localStorage.setItem(`${LOCAL_KEY}:alice`, JSON.stringify({ app: { status: 'done', at: 'x' } }))
    render(<><Page id="app" anchors={APP} /><Page /><TourLayer /></>)
    await screen.findByRole('dialog')
    expect(title()).toBe('先搜一搜')                              // app 本机记着看过，market 没有
  })

  it('接口写失败：先记在本机（带待补交标记），下次接口通了补交', async () => {
    const user = userEvent.setup()
    setCurrentAccount('alice')
    serverMock({}, { failPut: true })
    const first = render(<><Page /><TourLayer /></>)
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: '跳过' }))
    await waitFor(() => expect(seenLocal('alice').market).toMatchObject({ status: 'skipped', local: true }))
    first.unmount()
    _resetController()
    _resetStoreCache()
    const calls = serverMock({})
    render(<><Page /><TourLayer /></>)
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && c.body.tour === 'market')).toBe(true))
    expect(dialog()).toBeNull()                                  // 本机记着看过，不重播
    await waitFor(() => expect(seenLocal('alice').market.local).toBeUndefined())
  })

  it('游客时看过的引导，登录后并入账号', async () => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ market: { status: 'done', at: 'x' } }))
    setCurrentAccount('bob')
    const calls = serverMock({})
    render(<><Page /><TourLayer /></>)
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ tour: 'market', status: 'done' }))
    expect(dialog()).toBeNull()
  })

  it('重置所有引导：PUT {reset:true}，清掉本机（账号与游客）记录，之后会再自动出现', async () => {
    setCurrentAccount('alice')
    const calls = serverMock({ market: { status: 'done', at: 'x' } })
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ market: { status: 'done', at: 'x' } }))
    const first = render(<><Page /><TourLayer /></>)
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(dialog()).toBeNull()
    let ok
    await act(async () => { ok = await resetAllTours() })
    expect(ok).toBe(true)
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { reset: true } })
    expect(seenLocal('alice')).toEqual({})
    expect(seenLocal()).toEqual({})
    first.unmount()
    render(<><Page /><TourLayer /></>)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('重置时接口失败：本机照样清，返回 false 让界面说明', async () => {
    setCurrentAccount('alice')
    serverMock({}, { failPut: true })
    let ok
    await act(async () => { ok = await resetAllTours() })
    expect(ok).toBe(false)
  })
})

describe('几何：高亮框与气泡位置', () => {
  const view = { vw: 1440, vh: 900 }
  const card = { w: 340, h: 180 }

  it('高亮框外扩并裁进视口；圆形目标保持圆形', () => {
    const hole = holeFor({ top: 100, left: 200, bottom: 140, right: 240, width: 40, height: 40 }, 1440, 900, 9999)
    expect(hole).toMatchObject({ top: 94, left: 194, width: 52, height: 52, radius: 26 })
    const big = holeFor({ top: -50, left: -10, bottom: 2000, right: 3000 }, 1440, 900)
    expect(big).toMatchObject({ top: 4, left: 4, width: 1432, height: 892 })
  })

  it('默认放目标下方；下面放不下放上面；指定方向优先；都放不下压在底部', () => {
    const low = { top: 800, left: 600, width: 200, height: 40, radius: 12 }
    expect(placeCard({ top: 100, left: 600, width: 200, height: 40 }, card, view)).toMatchObject({ mode: 'float', side: 'bottom', top: 152, left: 530 })
    expect(placeCard(low, card, view)).toMatchObject({ side: 'top', top: 800 - 12 - 180 })
    expect(placeCard({ top: 100, left: 20, width: 200, height: 600 }, card, view, 'right')).toMatchObject({ side: 'right', left: 232 })
    expect(placeCard({ top: 8, left: 8, width: 1424, height: 884 }, card, view)).toMatchObject({ side: 'over' })
    expect(placeCard(null, card, view)).toMatchObject({ side: 'center', top: 360, left: 550 })
    // 横向夹在视口里
    expect(placeCard({ top: 100, left: 1400, width: 30, height: 30 }, card, view).left).toBe(1440 - 340 - 16)
  })

  it('手机：底部卡片；目标在底部会被挡住时改到顶部', () => {
    const phone = { vw: 390, vh: 844 }
    expect(placeCard({ top: 200, left: 20, width: 300, height: 48 }, card, phone)).toEqual({ mode: 'sheet', side: 'bottom', top: 0, left: 0 })
    expect(placeCard({ top: 760, left: 20, width: 300, height: 60 }, card, phone)).toMatchObject({ mode: 'sheet', side: 'top' })
  })

  it('大半在视口外才滚动', () => {
    expect(needsScroll({ top: 100, bottom: 140, height: 40 }, 900)).toBe(false)
    expect(needsScroll({ top: 1200, bottom: 1240, height: 40 }, 900)).toBe(true)
    expect(needsScroll({ top: 0, bottom: 2000, height: 2000 }, 900)).toBe(false)
  })
})
