import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Admin from './Admin.jsx'
import TrendChart, { niceMax } from './TrendChart.jsx'

/* ---- 契约 §5 格式的假数据 ---- */
const NOW = new Date(2026, 9, 3, 15, 0, 0)   // 2026-10-03 周六 15:00
const iso = minutesAgo => new Date(NOW.getTime() - minutesAgo * 60000).toISOString()
const day = back => {
  const d = new Date(2026, 9, 3 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const quota = (calls, runs, source) => ({ daily_model_calls: calls, daily_flow_runs: runs, source })
const ACCOUNTS = [
  { user_id: 'u1', username: 'owner', role: 'Owner', platform: null, calls: 300, tokens: 720000, cost_yuan: 2.4, flow_runs: 20, flow_failures: 1,
    today: { calls: 40, flow_runs: 3 }, quota: quota(null, null, 'unlimited'), last_active_at: iso(3) },
  { user_id: 'u2', username: '小林', role: 'Member', platform: { name: '花店助理', icon: '🌸' }, calls: 500, tokens: 1200000, cost_yuan: 3.9, flow_runs: 60, flow_failures: 0,
    today: { calls: 88, flow_runs: 9 }, quota: quota(500, 120, 'custom'), last_active_at: iso(12) },
  { user_id: 'u3', username: 'amy', role: 'Member', platform: { name: '健身教练', icon: '🏋️' }, calls: 200, tokens: 480000, cost_yuan: 8.8, flow_runs: 10, flow_failures: 4,
    today: { calls: 300, flow_runs: 2 }, quota: quota(300, 100, 'default'), last_active_at: iso(60 * 30) },
  { user_id: 'u4', username: 'yuki', role: 'Member', platform: { name: '日语陪练', icon: '🗾' }, calls: 0, tokens: 0, cost_yuan: 0, flow_runs: 0, flow_failures: 0,
    today: { calls: 0, flow_runs: 0 }, quota: quota(300, 100, 'default'), last_active_at: null },
]
function usageFor(days, { empty = false } = {}) {
  const daily = Array.from({ length: days }, (_, i) => {
    const calls = empty ? 0 : 100 + i * 10
    return { day: day(days - 1 - i), calls, tokens: calls * 2400, cost_yuan: calls * 0.008, flow_runs: empty ? 0 : 10, flow_failures: empty ? 0 : 1 }
  })
  const sum = k => daily.reduce((s, d) => s + d[k], 0)
  return {
    range: { days },
    totals: { calls: sum('calls'), input_tokens: sum('tokens') * 0.8, output_tokens: sum('tokens') * 0.2, cost_yuan: sum('cost_yuan'),
      flow_runs: sum('flow_runs'), flow_failures: sum('flow_failures'), active_accounts: empty ? 0 : 3 },
    daily,
    by_kind: empty ? [] : [
      { kind: 'chat', label: '对话', calls: Math.round(sum('calls') * 0.6), tokens: 1, cost_yuan: 1 },
      { kind: 'flow', label: '流程', calls: Math.round(sum('calls') * 0.3), tokens: 1, cost_yuan: 1 },
      { kind: 'voice', label: '语音', calls: Math.round(sum('calls') * 0.1), tokens: 1, cost_yuan: 1 },
    ],
    accounts: ACCOUNTS,
    pricing: { input_per_m: 2, output_per_m: 8, note: '按每百万 token 输入 ¥2、输出 ¥8 估算' },
  }
}
const ALERTS = () => ({
  alerts: [
    { id: 'a1', kind: 'schedule_paused', title: '「早报」连续失败，已暂停定时', detail: '飞书没权限', owner: { id: 'u2', username: '小林' }, created_at: iso(18), read: false },
    { id: 'a2', kind: 'quota_exhausted', title: 'amy 今天的模型调用用完了', detail: '', owner: { id: 'u3', username: 'amy' }, created_at: iso(95), read: false },
    { id: 'a3', kind: 'channel_down', title: '飞书长连接断开', detail: '已重连', owner: null, created_at: iso(60 * 72), read: true },
  ],
  unread: 2,
})

/* ---- fetch 替身：按路径分发，可以按测试改写某个接口 ---- */
let calls
let routes
const ok = data => ({ ok: true, status: 200, json: async () => data })
const fail = (status, data = {}) => ({ ok: false, status, json: async () => data })
function setup(over = {}) {
  routes = {
    usage: days => ok(usageFor(days)),
    alerts: () => ok(ALERTS()),
    read: () => ok({ ok: true }),
    quota: (id, body) => ok({ quota: { ...body, source: body.daily_model_calls === null && body.daily_flow_runs === null ? 'default' : 'custom' } }),
    ...over,
  }
}
beforeEach(() => {
  calls = []
  setup()
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(url, 'http://localhost')
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path: u.pathname, search: u.search, method: init.method || 'GET', body })
    if (u.pathname === '/api/admin/usage') return routes.usage(Number(u.searchParams.get('days')))
    if (u.pathname === '/api/admin/alerts') return routes.alerts(Number(u.searchParams.get('limit')))
    if (u.pathname === '/api/admin/alerts/read') return routes.read(body)
    const q = u.pathname.match(/^\/api\/admin\/quotas\/(.+)$/)
    if (q) return routes.quota(decodeURIComponent(q[1]), body)
    return fail(404)
  })
  const store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: k => { store.delete(k) },
    clear: () => store.clear(),
  })
  document.body.className = ''
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.matchMedia
})

const usageCalls = () => calls.filter(c => c.path === '/api/admin/usage').map(c => c.search)
const renderAdmin = (props = {}) => render(<Admin session={{ username: 'owner', role: 'Owner' }} onExpired={() => {}} now={NOW} {...props} />)
const tile = key => document.querySelector(`[data-tile=${key}]`)
const rowOf = name => document.querySelector(`[data-user="${name}"]`)

describe('管理后台：概览与范围', () => {
  it('默认近 7 天：概览六格、估算说明、按类别', async () => {
    renderAdmin()
    await waitFor(() => expect(tile('calls')).toHaveTextContent('910'))
    expect(usageCalls()).toEqual(['?days=7'])
    expect(screen.getByRole('heading', { level: 1, name: '管理后台' })).toBeInTheDocument()
    expect(tile('calls')).toHaveTextContent('日均 130 次')
    expect(tile('tokens')).toHaveTextContent('218 万其中输出 44 万')
    expect(tile('cost')).toHaveTextContent('¥7.28')
    expect(within(tile('cost')).getByRole('tooltip')).toHaveTextContent('按每百万 token 输入 ¥2、输出 ¥8 估算')
    expect(within(tile('cost')).getByRole('button', { name: '估算' })).toBeInTheDocument()
    expect(tile('runs')).toHaveTextContent('70')
    expect(tile('rate')).toHaveTextContent('10%')
    expect(tile('rate')).toHaveTextContent('偏高')
    expect(tile('active')).toHaveTextContent('共 4 个账号')
    const kinds = [...document.querySelectorAll('.ad-kind')].map(li => li.querySelector('.ad-kind-name').textContent)
    expect(kinds).toEqual(['对话', '流程', '一句话生成', '语音', '其他'])
    expect(document.querySelector('[data-kind=chat]')).toHaveTextContent('546 次 · 60%')
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('切换范围：重新取数并记住；今天不画一根柱子的图，给去看近 7 天的入口', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await waitFor(() => expect(tile('calls')).toHaveTextContent('910'))
    await user.click(screen.getByRole('button', { name: '近 30 天' }))
    await waitFor(() => expect(usageCalls()).toEqual(['?days=7', '?days=30']))
    await waitFor(() => expect(document.querySelectorAll('.ad-hit')).toHaveLength(30))
    expect(localStorage.getItem('jv-admin-range')).toBe('30d')
    expect(screen.getByRole('columnheader', { name: /近 30 天调用/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '今天' }))
    await waitFor(() => expect(usageCalls()).toContain('?days=1'))
    expect(await screen.findByText('今天到现在 · 估算 ¥0.80 · 流程 10 次')).toBeInTheDocument()
    expect(document.querySelector('.ad-trend-svg')).toBeNull()
    expect(tile('calls')).toHaveTextContent('今天零点起')
    await user.click(screen.getByRole('button', { name: '看近 7 天的趋势' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true'))
  })

  it('记住的范围下次直接用', async () => {
    localStorage.setItem('jv-admin-range', '30d')
    renderAdmin()
    await waitFor(() => expect(usageCalls()).toEqual(['?days=30']))
  })

  it('第一次加载给骨架；切换范围时保留旧数据、淡一点显示', async () => {
    let release
    setup({ usage: days => (days === 30 ? new Promise(r => { release = () => r(ok(usageFor(30))) }) : ok(usageFor(days))) })
    const user = userEvent.setup()
    localStorage.setItem('jv-admin-range', '7d')
    renderAdmin()
    expect(document.querySelectorAll('.ad-tile.ad-skel')).toHaveLength(6)
    await waitFor(() => expect(tile('calls')).toHaveTextContent('910'))
    await user.click(screen.getByRole('button', { name: '近 30 天' }))
    expect(document.querySelector('.ad-usage')).toHaveClass('is-stale')
    expect(tile('calls')).toHaveTextContent('910')   // 旧数据还在
    await act(async () => { release() })
    await waitFor(() => expect(document.querySelector('.ad-usage')).not.toHaveClass('is-stale'))
  })

  it('没有数据：趋势与类别都给空状态', async () => {
    setup({ usage: days => ok(usageFor(days, { empty: true })) })
    renderAdmin()
    expect(await screen.findByText('这段时间还没有模型调用，有人用了这里就会画出来')).toBeInTheDocument()
    expect(screen.getByText('这段时间还没有模型调用')).toBeInTheDocument()
    expect(tile('rate')).toHaveTextContent('—')
    expect(tile('rate')).toHaveTextContent('没有运行')
  })

  it('出错给重试；重试成功就恢复', async () => {
    let n = 0
    setup({ usage: days => (n++ === 0 ? fail(500, { error: '统计库忙' }) : ok(usageFor(days))) })
    const user = userEvent.setup()
    renderAdmin()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('用量没加载出来：统计库忙')
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(tile('calls')).toHaveTextContent('910'))
  })

  it('401：交给 onExpired 回登录页', async () => {
    setup({ usage: () => fail(401) })
    const onExpired = vi.fn()
    renderAdmin({ onExpired })
    await waitFor(() => expect(onExpired).toHaveBeenCalled())
  })

  it('套主题：浅色偏好在后台页也生效', async () => {
    localStorage.setItem('jws_theme', 'light')
    renderAdmin()
    await waitFor(() => expect(document.body).toHaveClass('light'))
  })
})

describe('管理后台：趋势图', () => {
  const DAILY = usageFor(7).daily

  it('每天一根柱、一条花费线；悬停 / 方向键看某一天', async () => {
    render(<TrendChart daily={DAILY} now={NOW} />)
    expect(document.querySelectorAll('.ad-bar')).toHaveLength(7)
    expect(document.querySelector('.ad-cost-line')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
    const hits = document.querySelectorAll('.ad-hit')
    fireEvent.pointerEnter(hits[2])
    const tip = screen.getByRole('status')
    expect(tip).toHaveTextContent('9月29日 周二')
    expect(tip).toHaveTextContent('120次调用')
    expect(tip).toHaveTextContent('¥0.96估算花费')
    expect(tip).toHaveTextContent('流程 10 次 · 失败 1')
    expect(document.querySelectorAll('.ad-bar.on')).toHaveLength(1)

    const canvas = screen.getByRole('group', { name: /用左右方向键逐天查看/ })
    fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    expect(screen.getByRole('status')).toHaveTextContent('9月30日 周三')
    fireEvent.keyDown(canvas, { key: 'End' })
    expect(screen.getByRole('status')).toHaveTextContent('10月3日 周六（今天）')
    fireEvent.keyDown(canvas, { key: 'Escape' })
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.focus(canvas)
    expect(screen.getByRole('status')).toHaveTextContent('（今天）')
    fireEvent.pointerLeave(canvas)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('「看数据」切成表格，同样的数都在', async () => {
    const user = userEvent.setup()
    render(<TrendChart daily={DAILY} now={NOW} />)
    await user.click(screen.getByRole('button', { name: '看数据' }))
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(8)
    expect(within(table).getByRole('rowheader', { name: '10月3日 周六（今天）' })).toBeInTheDocument()
    expect(table).toHaveTextContent('¥1.28')
    await user.click(screen.getByRole('button', { name: '看图' }))
    expect(document.querySelector('.ad-trend-svg')).toBeInTheDocument()
  })

  it('窄容器放不下 30 天：图横向滚，纵轴与格标题钉在左边', () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 320 } })
    try {
      render(<TrendChart daily={usageFor(30).daily} now={NOW} />)
      const svg = document.querySelector('.ad-trend-canvas .ad-trend-svg')
      expect(Number(svg.getAttribute('width'))).toBeGreaterThan(320)
      const pinned = document.querySelector('.ad-trend-axis')
      expect(pinned).toHaveTextContent('模型调用（次）')
      expect(svg.querySelector('.ad-ax-title')).toBeNull()
      expect(document.querySelectorAll('.ad-bar')).toHaveLength(30)
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', desc)
      else delete HTMLElement.prototype.clientWidth
    }
  })

  it('纵轴取好读的整刻度', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(1125)).toBe(1200)
    expect(niceMax(640)).toBe(800)
    expect(niceMax(8.9)).toBe(10)
    expect(niceMax(0.42)).toBe(0.5)
  })
})

describe('管理后台：账号表与配额', () => {
  const names = () => [...document.querySelectorAll('tbody tr')].map(tr => tr.dataset.user)

  it('每行：账号、智能体、今天用量 / 配额、调用、花费、流程、最近活跃；Owner 不给改', async () => {
    renderAdmin()
    await waitFor(() => expect(rowOf('小林')).toBeInTheDocument())
    expect(names()).toEqual(['小林', 'owner', 'amy', 'yuki'])   // 默认按用量
    const lin = rowOf('小林')
    expect(lin).toHaveTextContent('花店助理')
    expect(lin).toHaveTextContent('调用88/ 500')
    expect(lin).toHaveTextContent('流程9/ 120')
    expect(lin).toHaveTextContent('¥3.90')
    expect(lin).toHaveTextContent('12 分钟前')
    expect(within(lin).getByRole('progressbar', { name: '小林 今天模型调用' })).toHaveAttribute('aria-valuenow', '88')
    expect(rowOf('amy')).toHaveTextContent('已用完')
    expect(rowOf('amy')).toHaveTextContent('失败 4')
    expect(rowOf('yuki')).toHaveTextContent('还没用过')
    expect(rowOf('yuki')).toHaveTextContent('日语陪练')
    const owner = rowOf('owner')
    expect(owner).toHaveTextContent('管理员不限')
    expect(owner).toHaveTextContent('调用40不限')
    expect(within(owner).queryByRole('button', { name: /改.*配额/ })).toBeNull()
    expect(within(owner).queryByRole('progressbar')).toBeNull()
  })

  it('搜索（账号名或智能体名）与排序', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await waitFor(() => expect(rowOf('小林')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: '花费' }))
    expect(names()).toEqual(['amy', '小林', 'owner', 'yuki'])
    expect(screen.getByRole('columnheader', { name: '估算花费' })).toHaveAttribute('aria-sort', 'descending')
    await user.click(screen.getByRole('button', { name: '失败' }))
    expect(names()).toEqual(['amy', 'owner', '小林', 'yuki'])
    await user.click(screen.getByRole('button', { name: '最近活跃' }))
    expect(names()).toEqual(['owner', '小林', 'amy', 'yuki'])
    await user.type(screen.getByRole('searchbox', { name: '搜索账号' }), '花店')
    expect(names()).toEqual(['小林'])
    await user.clear(screen.getByRole('searchbox', { name: '搜索账号' }))
    await user.type(screen.getByRole('searchbox', { name: '搜索账号' }), 'zzz')
    expect(screen.getByText('没有找到「zzz」')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(names()).toHaveLength(4)
  })

  it('改配额：三种模式回填；改成「用默认 / 自定义」保存走 PUT，行里跟着变', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await user.click(await screen.findByRole('button', { name: '改 小林 的配额' }))
    const dialog = screen.getByRole('dialog', { name: '调整每日配额' })
    expect(dialog).toHaveTextContent('小林 · 花店助理')
    const calls1 = within(dialog).getByRole('group', { name: /每天的模型调用/ })
    const runs1 = within(dialog).getByRole('group', { name: /每天的流程运行/ })
    expect(calls1).toHaveTextContent('今天已用 88 次')
    expect(within(calls1).getByRole('radio', { name: /自定义/ })).toBeChecked()
    expect(within(calls1).getByRole('spinbutton')).toHaveValue(500)
    expect(within(calls1).getByRole('radio', { name: /用默认/ })).toHaveAccessibleName(/每天 300 次/)
    expect(within(calls1).getByRole('radio', { name: /不限/ })).toBeInTheDocument()

    await user.click(within(calls1).getByRole('radio', { name: /用默认/ }))
    const runsInput = within(runs1).getByRole('spinbutton')
    await user.clear(runsInput)
    await user.type(runsInput, '50')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const put = calls.find(c => c.method === 'PUT')
    expect(put).toMatchObject({ path: '/api/admin/quotas/u2', body: { daily_model_calls: null, daily_flow_runs: 50 } })
    expect(screen.getByRole('status')).toHaveTextContent('已更新 小林 的每日配额')
    expect(rowOf('小林')).toHaveTextContent('流程9/ 50')
  })

  it('改配额：选「不限」传 -1；自定义填得不对先拦下、不发请求', async () => {
    const user = userEvent.setup()
    setup({ quota: (id, body) => ok({ quota: { ...body, source: 'unlimited' } }) })
    renderAdmin()
    await user.click(await screen.findByRole('button', { name: '改 amy 的配额' }))
    const dialog = screen.getByRole('dialog', { name: '调整每日配额' })
    const callsGroup = within(dialog).getByRole('group', { name: /每天的模型调用/ })
    const runsGroup = within(dialog).getByRole('group', { name: /每天的流程运行/ })
    expect(within(callsGroup).getByRole('radio', { name: /用默认/ })).toBeChecked()
    await user.click(within(runsGroup).getByRole('radio', { name: /自定义/ }))
    await user.type(within(runsGroup).getByRole('spinbutton'), '0')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(within(runsGroup).getByRole('alert')).toHaveTextContent('填 1 到 100000 之间的整数')
    expect(calls.some(c => c.method === 'PUT')).toBe(false)

    await user.click(within(callsGroup).getByRole('radio', { name: /不限/ }))
    await user.click(within(runsGroup).getByRole('radio', { name: /不限/ }))
    expect(within(runsGroup).queryByRole('alert')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.find(c => c.method === 'PUT').body).toEqual({ daily_model_calls: -1, daily_flow_runs: -1 })
    expect(rowOf('amy')).toHaveTextContent('调用300不限')
  })

  it('改配额：服务端拒绝时留在弹层里说原因；取消不发请求', async () => {
    const user = userEvent.setup()
    setup({ quota: () => fail(400, { error: '这个账号已经停用了' }) })
    renderAdmin()
    await user.click(await screen.findByRole('button', { name: '改 amy 的配额' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('这个账号已经停用了')
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('窄屏：账号表换成卡片', async () => {
    window.matchMedia = q => ({ matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} })
    renderAdmin()
    await waitFor(() => expect(document.querySelector('.ad-acct-cards')).toBeInTheDocument())
    expect(document.querySelector('.ad-table')).toBeNull()
    const cards = within(screen.getByRole('list', { name: '账号' })).getAllByRole('listitem')
    expect(cards).toHaveLength(4)
    expect(cards[0]).toHaveTextContent('近 7 天调用')
    expect(within(cards[0]).getByRole('button', { name: '改 小林 的配额' })).toBeInTheDocument()
  })
})

describe('管理后台：告警', () => {
  const alertItem = id => document.querySelector(`[data-alert=${id}]`)

  it('未读高亮；单条标已读、全部已读', async () => {
    const user = userEvent.setup()
    renderAdmin()
    await waitFor(() => expect(alertItem('a1')).toBeInTheDocument())
    expect(alertItem('a1')).toHaveClass('is-unread')
    expect(alertItem('a3')).not.toHaveClass('is-unread')
    expect(alertItem('a1')).toHaveTextContent('定时流程')
    expect(alertItem('a1')).toHaveTextContent('小林')
    expect(alertItem('a1')).toHaveTextContent('18 分钟前')
    expect(screen.getByRole('button', { name: '2 条未读告警' })).toBeInTheDocument()

    await user.click(within(alertItem('a1')).getByRole('button', { name: /标为已读/ }))
    expect(calls.find(c => c.path === '/api/admin/alerts/read').body).toEqual({ ids: ['a1'] })
    expect(alertItem('a1')).not.toHaveClass('is-unread')
    expect(screen.getByRole('button', { name: '1 条未读告警' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '全部标为已读' }))
    expect(calls.filter(c => c.path === '/api/admin/alerts/read').at(-1).body).toEqual({ all: true })
    expect(document.querySelectorAll('.ad-alert.is-unread')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /条未读告警/ })).toBeNull()
    expect(screen.getByRole('button', { name: '全部标为已读' })).toBeDisabled()
  })

  it('标已读失败：退回原样并说明', async () => {
    const user = userEvent.setup()
    setup({ read: () => fail(500, { error: '数据库忙' }) })
    renderAdmin()
    await waitFor(() => expect(alertItem('a2')).toBeInTheDocument())
    await user.click(within(alertItem('a2')).getByRole('button', { name: /标为已读/ }))
    await waitFor(() => expect(alertItem('a2')).toHaveClass('is-unread'))
    expect(screen.getByText('没标上已读：数据库忙')).toBeInTheDocument()
  })

  it('没有告警：一切正常', async () => {
    setup({ alerts: () => ok({ alerts: [], unread: 0 }) })
    renderAdmin()
    expect(await screen.findByText('一切正常')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部标为已读' })).toBeDisabled()
  })

  it('告警没加载出来：单独重试，不影响用量', async () => {
    let n = 0
    setup({ alerts: () => (n++ === 0 ? fail(503) : ok(ALERTS())) })
    const user = userEvent.setup()
    renderAdmin()
    await waitFor(() => expect(tile('calls')).toHaveTextContent('910'))
    const box = await screen.findByRole('alert')
    expect(box).toHaveTextContent('服务暂时不可用')
    await user.click(within(box).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(alertItem('a1')).toBeInTheDocument())
  })
})
