import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PluginDetail, { needsOf, setupOf } from './PluginDetail.jsx'
import { normalizeCatalog } from './model.js'

/* 第十七轮：插件详情「少即是多」——一屏讲清是什么 / 能做什么 / 要不要配置，其余折叠或下移 */

const P = (id, name, extra = {}) => ({
  id, name, icon: '🧩', category: 'efficiency', summary: `${name}的一句话`, kind: 'tool', tools: [], requires: [], examples: [],
  available: true, builtin: true, status: 'ok', version: '1.0.0', author: 'JWS-Agent', license: 'MIT-0', ...extra,
})
const catalog = normalizeCatalog({
  categories: [{ id: 'efficiency', name: '效率' }],
  plugins: [
    P('many', '多面手', {
      tools: [{ name: 'a1', label: '查一' }, { name: 'a2', label: '查二' }, { name: 'a3', label: '查三' }, { name: 'a4', label: '查四' }, { name: 'a5', label: '查五' }],
      description: '这是一段比较长的介绍。'.repeat(12),
      examples: ['一', '二', '三', '四', '五'],
    }),
    P('skill', '周报写手', { kind: 'skill' }),
    P('feishu', '飞书', { kind: 'channel', requires: ['feishu_bound'] }),
    P('amap', '高德地图', { kind: 'mcp', hosts: ['mcp.amap.com'], status: 'needs_config', reason: '需要管理员填写高德 Key',
      config: [{ key: 'AMAP_KEY', label: '高德 Web 服务 Key', required: true, configured: false }] }),
    P('echo', '回声测试', { builtin: false, author: 'acme', source: { type: 'github', repo: 'acme/echo', ref: 'main' }, homepage: 'https://acme.dev' }),
  ],
  professions: [],
})

function open(id, props = {}) {
  const onToggle = vi.fn()
  const view = render(<PluginDetail catalog={catalog} pluginId={id} picked={[]} onToggle={onToggle} onOpen={vi.fn()} onClose={vi.fn()}
    onAskAI={vi.fn()} authed={false} toolboxCount={0} {...props} />)
  return { ...view, onToggle, dialog: screen.getByRole('dialog') }
}

describe('插件详情：信息层级', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('头部：名称、一句话、作者 · 来源，主按钮「加入工具箱」就在头部', async () => {
    const user = userEvent.setup()
    const { dialog, onToggle } = open('many')
    const head = dialog.querySelector('header.jvm-pd-head')
    expect(within(head).getByRole('heading', { level: 2, name: '多面手' })).toBeInTheDocument()
    expect(head).toHaveTextContent('多面手的一句话')
    expect(head).toHaveTextContent('JWS-Agent')
    expect(head).toHaveTextContent('官方')
    await user.click(within(head).getByRole('button', { name: '加入工具箱：多面手' }))
    expect(onToggle).toHaveBeenCalledWith('many')
    // 整个详情里只有这一个「加入」按钮（不再在底部重复一条）
    expect(within(dialog).getAllByRole('button', { name: /工具箱：多面手/ })).toHaveLength(1)
  })

  it('信息条只留四格：类型、能力、设置、价格', () => {
    const { dialog } = open('many')
    const strip = within(dialog).getByLabelText('概览')
    expect([...strip.querySelectorAll('dt')].map(x => x.textContent)).toEqual(['类型', '能力', '设置', '价格'])
    expect(strip).toHaveTextContent('5 个工具')
    expect(strip).toHaveTextContent('开箱即用')
    expect(strip).toHaveTextContent('免费')
  })

  it('它能做什么先露 3 条，「全部」展开；介绍默认三行，「更多」展开', async () => {
    const user = userEvent.setup()
    const { dialog } = open('many')
    const can = within(dialog).getByRole('region', { name: '它能做什么' })
    expect(within(can).getAllByRole('listitem')).toHaveLength(3)
    const all = within(can).getByRole('button', { name: '全部 5 项' })
    expect(all).toHaveAttribute('aria-expanded', 'false')
    await user.click(all)
    expect(within(can).getAllByRole('listitem')).toHaveLength(5)
    expect(within(can).getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')

    const more = within(dialog).getByRole('button', { name: '更多' })
    expect(more.closest('.jvm-pd-desc')).toHaveClass('is-clamped')
    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(more).toHaveTextContent('收起')
    expect(more.closest('.jvm-pd-desc')).not.toHaveClass('is-clamped')
  })

  it('试试这样问是 chip，最多 4 个；没有要配置的就不出「需要什么」', () => {
    const { dialog } = open('many')
    const tryIt = within(dialog).getByRole('region', { name: '试试这样问' })
    expect(within(tryIt).getAllByRole('button', { name: /^复制：/ })).toHaveLength(4)
    expect(within(dialog).queryByRole('region', { name: '需要什么' })).toBeNull()
  })

  it('需要配置 / 需要绑定：信息条写明，「需要什么」列出原因；技能的「不运行代码」进信息表', async () => {
    const user = userEvent.setup()
    let { dialog } = open('amap')
    expect(dialog.querySelector('.jvm-pd-strip .is-warn')).toHaveTextContent('需要配置')
    const needs = within(dialog).getByRole('region', { name: '需要什么' })
    expect(needs).toHaveTextContent('联网：mcp.amap.com')
    expect(needs).toHaveTextContent('需要配置：高德 Web 服务 Key')
    expect(within(dialog).getByRole('button', { name: '加入工具箱：高德地图' })).toBeDisabled()
    cleanup()

    ;({ dialog } = open('feishu'))
    expect(dialog.querySelector('.jvm-pd-strip .is-warn')).toHaveTextContent('需要绑定')
    expect(within(dialog).getByRole('region', { name: '需要什么' })).toHaveTextContent('需绑定飞书')
    cleanup()

    ;({ dialog } = open('skill'))
    expect(within(dialog).queryByRole('region', { name: '需要什么' })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: /^信息/ }))
    expect(within(dialog).getByText('运行方式').nextSibling).toHaveTextContent('不运行代码')
  })

  it('来源链接常驻在「信息」下方，社区插件写明运行方式', async () => {
    const user = userEvent.setup()
    const { dialog } = open('echo')
    const links = within(dialog).getByRole('list', { name: '来源链接' })
    expect(within(links).getByRole('link', { name: /源代码 @main/ })).toHaveAttribute('href', 'https://github.com/acme/echo/tree/main')
    expect(within(links).getByRole('link', { name: /主页/ })).toHaveAttribute('href', 'https://acme.dev')
    expect(dialog.querySelector('.jvm-pd-by')).toHaveTextContent('社区')
    await user.click(within(dialog).getByRole('button', { name: /^信息/ }))
    expect(within(dialog).getByText('运行方式').nextSibling).toHaveTextContent('独立子进程')
  })

  it('头部滚出视野后，顶栏浮出小图标 + 名字 + 小「加入」按钮', () => {
    let fire = null
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb) { fire = cb }
      observe() {}
      disconnect() {}
    })
    const { dialog } = open('many', { picked: ['many'], toolboxCount: 3 })
    expect(within(dialog).getAllByRole('button', { name: '移出工具箱：多面手' })).toHaveLength(1)
    expect(dialog).toHaveTextContent('工具箱里共 3 个')
    act(() => fire([{ isIntersecting: false }]))
    const bar = dialog.querySelector('.jvm-pd-bar')
    expect(bar).toHaveClass('is-stuck')
    expect(within(bar).getByRole('button', { name: '移出工具箱：多面手' })).toHaveAttribute('aria-pressed', 'true')
    act(() => fire([{ isIntersecting: true }]))
    expect(dialog.querySelector('.jvm-pd-bar')).not.toHaveClass('is-stuck')
  })

  it('needsOf / setupOf：去重、技能不算「需要」', () => {
    const byId = id => catalog.plugins.find(p => p.id === id)
    expect(needsOf(byId('skill'))).toEqual([])
    expect(setupOf(byId('skill')).text).toBe('开箱即用')
    expect(setupOf(byId('amap'))).toEqual({ text: '需要配置', tone: 'warn' })
    const dup = { ...byId('amap'), hosts: ['x.com'], permissions: [{ key: 'net', label: '联网：x.com', level: 'info' }] }
    expect(needsOf(dup).filter(n => n.title === '联网：x.com')).toHaveLength(1)
  })
})
