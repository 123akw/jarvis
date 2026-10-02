import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const panelProps = []
const chatProps = []
vi.mock('./Chat.jsx', () => ({
  default: props => {
    chatProps.push(props)
    return <section aria-label="chat" data-thread={props.threadId} data-injected={props.injected?.text ?? ''} />
  },
}))
vi.mock('./Panels.jsx', () => ({
  default: props => {
    panelProps.push(props)
    return (
      <div aria-label="panels" data-active={String(props.active)} data-seed={props.quickSeed?.text ?? ''}>
        <button type="button" onClick={() => props.onOpenMemory?.([4, 5])}>查看昨晚的记忆</button>
      </div>
    )
  },
}))
vi.mock('./Threads.jsx', () => ({ default: () => <nav aria-label="threads" /> }))
vi.mock('./MemoryPanel.jsx', () => ({
  default: ({ highlight }) => <div role="dialog" aria-label="记忆与人设" data-highlight={highlight.join(',')} />,
}))

import Hud from './Hud.jsx'

function setWidth(value) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value })
}

describe('HUD：速记与记忆提示的入口', () => {
  beforeEach(() => {
    panelProps.length = 0
    chatProps.length = 0
    setWidth(1440)   // regular：今日是浮层，默认收起
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(k => (store.has(k) ? store.get(k) : null)),
      setItem: vi.fn((k, v) => store.set(k, String(v))),
      removeItem: vi.fn(k => store.delete(k)),
    })
    global.fetch = vi.fn().mockResolvedValue({ status: 503, ok: false, json: async () => ({ error: '离线' }) })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setWidth(1024)
  })

  it('⌘K 输入一句话回车 → 关掉面板，把这句话发进当前对话（复用注入链路）', async () => {
    const user = userEvent.setup()
    render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={() => {}} />)
    await user.keyboard('{Meta>}k{/Meta}')
    const input = screen.getByRole('combobox', { name: '搜索命令' })
    fireEvent.change(input, { target: { value: '帮我查下明天深圳的天气' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull()
    expect(screen.getByLabelText('chat')).toHaveAttribute('data-injected', '帮我查下明天深圳的天气')
    expect(screen.getByLabelText('panels')).toHaveAttribute('data-active', 'false')   // 不再绕去今日板
  })

  it('⌘K「加到日程」直接写入，顶部 toast 可撤销', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 2, 10, 0))
    const calls = []
    global.fetch = vi.fn(async (url, init = {}) => {
      calls.push([init.method || 'GET', String(url), init.body])
      if (String(url) === '/api/schedule' && init.method === 'POST') return { status: 200, ok: true, json: async () => ({ id: 7 }) }
      if (String(url) === '/api/schedule/7') return { status: 200, ok: true, json: async () => ({ ok: true }) }
      return { status: 503, ok: false, json: async () => ({ error: '离线' }) }
    })
    try {
      const user = userEvent.setup()
      render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={() => {}} />)
      await user.keyboard('{Meta>}k{/Meta}')
      const input = screen.getByRole('combobox', { name: '搜索命令' })
      fireEvent.change(input, { target: { value: '明天下午3点 复盘' } })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })
      const toast = await screen.findByText('已添加日程：明天 15:00 复盘')
      expect(calls).toContainEqual(['POST', '/api/schedule', JSON.stringify({ title: '复盘', when: '2026-10-03 15:00' })])
      expect(screen.getByLabelText('chat')).toHaveAttribute('data-injected', '')   // 不走模型
      fireEvent.click(within(toast.closest('.jv-toast')).getByRole('button', { name: '撤销' }))
      expect(await screen.findByText('已撤销')).toBeInTheDocument()
      expect(calls).toContainEqual(['DELETE', '/api/schedule/7', undefined])
    } finally {
      vi.useRealTimers()
    }
  })

  it('⌘K「历史对话」命中 → 切到那个会话并让对话区定位到那条消息', async () => {
    global.fetch = vi.fn(async url => (String(url).startsWith('/api/history/search')
      ? { status: 200, ok: true, json: async () => ({ items: [{ thread_id: 't9', title: '周末去哪吃', role: 'assistant', pos: 3, at: '2026-09-21T12:00:00+00:00', snippet: '推荐「鮨 心」，在静安寺附近', marks: [[10, 13]] }] }) }
      : { status: 503, ok: false, json: async () => ({ error: '离线' }) }))
    const user = userEvent.setup()
    render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={() => {}} />)
    await user.keyboard('{Meta>}k{/Meta}')
    fireEvent.change(screen.getByRole('combobox', { name: '搜索命令' }), { target: { value: '静安寺' } })
    await user.click(await screen.findByRole('option', { name: /鮨 心/ }))
    await waitFor(() => expect(screen.getByLabelText('chat')).toHaveAttribute('data-thread', 't9'))
    expect(chatProps.at(-1).locate).toMatchObject({ threadId: 't9', pos: 3 })
  })

  it('⌘K「速记…」命令：空草稿打开今日', async () => {
    const user = userEvent.setup()
    render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={() => {}} />)
    await user.keyboard('{Meta>}k{/Meta}')
    await user.click(screen.getByText('速记…'))
    expect(screen.getByLabelText('panels')).toHaveAttribute('data-active', 'true')
    expect(panelProps.at(-1).quickSeed).toMatchObject({ text: '' })
  })

  it('今日板「查看」昨晚整理的记忆 → 打开记忆面板并带上要高亮的条目', async () => {
    const user = userEvent.setup()
    render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={() => {}} />)
    await user.click(screen.getByRole('button', { name: '查看昨晚的记忆' }))
    expect(screen.getByRole('dialog', { name: '记忆与人设' })).toHaveAttribute('data-highlight', '4,5')
  })
})
