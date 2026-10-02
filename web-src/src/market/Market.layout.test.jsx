import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadRecent, pushRecent, sentenceLike } from './Hero.jsx'
import Market from './Market.jsx'
import { normalizeCatalog } from './model.js'
import { keyBadge } from './PluginCard.jsx'

/* 第十七轮版面：首屏搜索建议、紧凑行卡的单一徽标，以及按拖拽契约的接线
 * （DndRoot 的 onAdd / canAdd / onReorder / onRemove、卡片与套装卡的 useDragSource、点「＋」的 flyToDock）。
 * 拖拽本身（指针 / 长按 / Dock）由 dnd/ 自己测；这里把 dnd 模块换成记录器，只测市场这边给它的判定与回调。 */

const dnd = vi.hoisted(() => ({ root: null, sources: new Map(), fly: [] }))
vi.mock('./dnd/index.jsx', async importOriginal => ({
  ...(await importOriginal()),
  DndRoot: props => { dnd.root = props; return props.children },
  useDragSource: arg => { dnd.sources.set(arg.id, arg); return { dragProps: { 'data-dnd': 'idle' }, isDragging: false } },
  flyToDock: (el, opts) => { dnd.fly.push({ el, opts }) },
}))

function memoryStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: k => { m.delete(k) }, clear: () => m.clear() }
}
const P = (id, name, icon, category, extra = {}) => ({
  id, name, icon, category, summary: `${name}的一句话`, kind: 'tool', tools: [], step: null, requires: [], tier: 'free', price: 0,
  examples: [], available: true, builtin: true, status: 'ok', reason: '', version: '1.0.0', source: { type: 'builtin' }, ...extra,
})
const CATALOG = {
  categories: [{ id: 'efficiency', name: '效率' }, { id: 'life', name: '生活' }],
  plugins: [
    P('schedule', '日程提醒', '📅', 'efficiency'),
    P('todo', '待办清单', '✅', 'efficiency'),
    P('memo', '随手记', '📝', 'efficiency'),
    P('weather', '查天气', '🌤️', 'life'),
    P('amap', '高德地图', '🗺️', 'life', { kind: 'mcp', status: 'needs_config', reason: '需要管理员填写高德 Key' }),
    P('broken', '坏掉的', '💥', 'life', { status: 'unavailable', reason: '缺少 Python 包' }),
  ],
  professions: [
    { id: 'shop_owner', name: '个体店主', icon: '🏪', plugins: ['memo', 'todo', 'weather', 'amap'], flows: [], home: {} },
    { id: 'student', name: '学生', icon: '🎒', plugins: ['schedule', 'todo'], flows: [], home: {} },
  ],
  signup: 'open',
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
function mockApi() {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase()
    const path = String(url).split('?')[0]
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    if (path === '/api/market/catalog') return json(CATALOG)
    if (path === '/api/market/recommend') return json({ plugins: ['memo'], flows: [], reason: '先记事。', source: 'model' })
    return json({ error: 'not mocked' }, 404)
  }))
  return calls
}
const recommendCalls = calls => calls.filter(c => c.method === 'POST' && c.path === '/api/market/recommend')
const picked = () => JSON.parse(sessionStorage.getItem('jv_market_draft') || '{}').picked || []

describe('第十七轮版面', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    window.history.replaceState({}, '', '/')
    dnd.root = null
    dnd.sources.clear()
    dnd.fly.length = 0
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('拖拽接线：卡片与套装卡都是拖拽源；canAdd 拒绝需要配置 / 不可用 / 已在工具箱；放下即加入，整套拖入记上职业', async () => {
    mockApi()
    render(<Market session={false} />)
    await screen.findByRole('article', { name: '查天气' })
    expect(dnd.sources.get('weather')).toEqual({ id: 'weather', ids: ['weather'], kind: 'plugin', icon: '🌤️', label: '查天气' })
    // 套装只收能加入的插件（高德地图需要配置，不在套装里）；药丸上扇形叠放前 3 个图标
    expect(dnd.sources.get('bundle:shop_owner')).toEqual({
      id: 'bundle:shop_owner', ids: ['memo', 'todo', 'weather'], kind: 'bundle', icon: '🏪', icons: ['📝', '✅', '🌤️'], label: '店主套装',
    })
    expect(screen.getByRole('article', { name: '查天气' })).toHaveAttribute('data-dnd', 'idle')   // dragProps 展开在卡片根元素上

    const { canAdd } = dnd.root
    expect(canAdd('weather')).toBe('')
    expect(canAdd('amap')).toBe('需要管理员先配置：需要管理员填写高德 Key')
    expect(canAdd('broken')).toBe('暂不可用：缺少 Python 包')
    expect(canAdd('nope')).toBe('插件不存在')

    act(() => dnd.root.onAdd(['weather']))
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('已选 1 个')
    expect(dnd.root.canAdd('weather')).toBe('已在工具箱里了')   // 带「已在」：Dock 显示成灰色的「已在」态
    act(() => dnd.root.onAdd(['amap', 'broken', 'nope']))   // 不能加的跳过
    expect(picked()).toEqual(['weather'])
    act(() => dnd.root.onAdd(['schedule', 'todo']))          // 没有 meta：照常去重追加，不记职业
    expect(picked()).toEqual(['weather', 'schedule', 'todo'])
    expect(JSON.parse(sessionStorage.getItem('jv_market_draft')).profession).toBe('')

    // 整套拖进来（meta.kind === 'bundle'）：按套装加，顺手记上职业
    act(() => dnd.root.onAdd(['memo', 'todo', 'weather'], { id: 'bundle:shop_owner', kind: 'bundle', label: '店主套装' }))
    expect(picked()).toEqual(['weather', 'schedule', 'todo', 'memo'])
    expect(JSON.parse(sessionStorage.getItem('jv_market_draft')).profession).toBe('shop_owner')
    expect(screen.getByText('已把「店主套装」的 1 个插件放进工具箱')).toBeInTheDocument()

    // 工具箱里「撤销移除」也走 onAdd：被移除的能加回来（之后 dnd 再调 onReorder 挪回原位）
    act(() => dnd.root.onRemove('schedule'))
    act(() => dnd.root.onAdd(['schedule'], { id: 'schedule', kind: 'plugin', restore: true, index: 1 }))
    act(() => dnd.root.onReorder(3, 1))
    expect(picked()).toEqual(['weather', 'schedule', 'todo', 'memo'])
  })

  it('拖拽接线：工具箱里拖动排序（越界不动）、拖出即移除', async () => {
    mockApi()
    render(<Market session={false} />)
    await screen.findByRole('article', { name: '查天气' })
    act(() => dnd.root.onAdd(['schedule']))
    act(() => dnd.root.onAdd(['todo']))
    act(() => dnd.root.onAdd(['weather']))
    act(() => dnd.root.onReorder(2, 0))
    expect(picked()).toEqual(['weather', 'schedule', 'todo'])
    act(() => dnd.root.onReorder(0, 1))
    expect(picked()).toEqual(['schedule', 'weather', 'todo'])
    act(() => dnd.root.onReorder(1, 9))
    act(() => dnd.root.onReorder(-1, 0))
    expect(picked()).toEqual(['schedule', 'weather', 'todo'])
    act(() => dnd.root.onRemove('weather'))
    expect(picked()).toEqual(['schedule', 'todo'])
    expect(screen.getByRole('region', { name: '工具箱' })).toHaveTextContent('已选 2 个')
  })

  it('点「＋」加入：从按钮所在的卡片飞进工具箱（移出时不飞）；整套加入也飞；不可用的「＋」禁用并给读屏原因', async () => {
    mockApi()
    const user = userEvent.setup()
    render(<Market session={false} />)
    const card = await screen.findByRole('article', { name: '查天气' })
    const plusBtn = within(card).getByRole('button', { name: '加入工具箱：查天气' })
    await user.click(plusBtn)
    expect(dnd.fly).toHaveLength(1)
    expect(dnd.fly[0].el).toBe(plusBtn)   // flyToDock 从它所在卡片的图标起飞
    expect(dnd.fly[0].opts).toEqual({ icon: '🌤️' })
    expect(within(card).getByRole('button', { name: '移出工具箱：查天气' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(card).getByRole('button', { name: '移出工具箱：查天气' }))
    expect(dnd.fly).toHaveLength(1)

    const featured = screen.getByRole('region', { name: '精选套装' })
    await user.click(within(featured).getByRole('button', { name: '整套加入：店主套装（3 个）' }))
    expect(dnd.fly).toHaveLength(2)
    expect(dnd.fly[1].opts).toEqual({ icon: '🏪' })
    expect(within(featured).getByRole('button', { name: '店主套装已全部加入' })).toHaveTextContent('已加入')

    const amap = screen.getByRole('article', { name: '高德地图' })
    const plus = within(amap).getByRole('button', { name: '加入工具箱：高德地图' })
    expect(plus).toBeDisabled()
    expect(plus).toHaveAccessibleDescription('需要管理员配置后才能加入：需要管理员填写高德 Key')
  })

  it('搜索建议：空着获焦给最近搜索与按行当（↑↓ + 回车选中）；一句话回车即 AI 推荐并记进最近搜索；Esc 先收起建议', async () => {
    const calls = mockApi()
    localStorage.setItem('jvm_recent_searches', JSON.stringify(['天气']))
    const user = userEvent.setup()
    render(<Market session={false} />)
    await screen.findByRole('article', { name: '查天气' })
    const box = screen.getByRole('searchbox', { name: '搜索插件' })
    await user.click(box)
    const list = screen.getByRole('listbox', { name: '搜索建议' })
    expect(within(list).getByRole('group', { name: '最近搜索' })).toHaveTextContent('天气')
    expect(within(within(list).getByRole('group', { name: '按行当推荐' })).getAllByRole('option').map(o => o.textContent))
      .toEqual(['🏪个体店主', '🎒学生'])

    // ↓ 第一项是最近搜索「天气」，回车 = 搜它
    await user.keyboard('{ArrowDown}')
    expect(box).toHaveAttribute('aria-activedescendant', 'jvm-sg-0')
    await user.keyboard('{Enter}')
    expect(box).toHaveValue('天气')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('heading', { name: /“天气” 的结果/ })).toHaveTextContent('1 个')

    // 清空后再选「学生」：按职业推荐，推荐面板就地展开
    await user.clear(box)
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
    await waitFor(() => expect(recommendCalls(calls)).toHaveLength(1))
    expect(recommendCalls(calls)[0].body).toEqual({ profession: 'student' })
    expect(await screen.findByRole('region', { name: '为你推荐' })).toHaveTextContent('按职业：学生')

    // 一句话：下拉第一行「让 AI 按这句推荐一套」，Esc 只收起建议、不清空
    await user.click(box)
    await user.type(box, '帮我管店里的订单')
    expect(screen.getByRole('option', { name: /让 AI 按这句推荐一套/ })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box).toHaveValue('帮我管店里的订单')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(recommendCalls(calls)).toHaveLength(2))
    expect(recommendCalls(calls)[1].body).toEqual({ profession: 'student', description: '帮我管店里的订单' })
    expect(loadRecent()).toEqual(['帮我管店里的订单', '天气'])
  })

  it('卡片最多一个徽标：需要配置 > 暂不可用 > 专业版 > MCP > 社区 / 插件源；官方与类型不标', () => {
    const base = normalizeCatalog({ plugins: [{ id: 'x', name: 'X' }] }).plugins[0]
    const with_ = extra => ({ ...base, ...extra })
    expect(keyBadge(with_({ status: 'needs_config', tier: 'pro', kind: 'mcp' }))?.label).toBe('需要配置')
    expect(keyBadge(with_({ status: 'unavailable', tier: 'pro' }))?.label).toBe('暂不可用')
    expect(keyBadge(with_({ tier: 'pro', kind: 'mcp' }))?.label).toBe('专业版')
    expect(keyBadge(with_({ kind: 'mcp', builtin: false }))?.label).toBe('MCP')
    expect(keyBadge(with_({ builtin: false }))?.label).toBe('社区')
    expect(keyBadge(with_({ builtin: false, source: { type: 'github', marketplace: 'm' } }))?.label).toBe('插件源')
    expect(keyBadge(with_({ kind: 'skill', requires: ['feishu_bound'] }))).toBeNull()
    expect(keyBadge(base)).toBeNull()
  })

  it('最近搜索与「像一句话」的判定', () => {
    expect(sentenceLike('天气')).toBe(false)
    expect(sentenceLike('火星移民')).toBe(false)
    expect(sentenceLike('我开奶茶店想管')).toBe(true)
    expect(sentenceLike('订单，排班')).toBe(true)
    let list = []
    for (const q of ['a', 'b', 'c', 'd', 'e', 'f', 'b', ' ']) list = pushRecent(list, q)
    expect(list).toEqual(['b', 'f', 'e', 'd', 'c'])
    expect(loadRecent()).toEqual(['b', 'f', 'e', 'd', 'c'])
    localStorage.setItem('jvm_recent_searches', '{坏数据')
    expect(loadRecent()).toEqual([])
  })
})
