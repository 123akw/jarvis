import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const panelProps = []
vi.mock('./Chat.jsx', () => ({ default: () => <section aria-label="chat" /> }))
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

  it('⌘K 输入一句话 → 打开今日并把草稿交给速记输入框（不在面板里直接写入）', async () => {
    const user = userEvent.setup()
    render(<Hud session={{ username: 'owner', role: 'Owner' }} onLogout={() => {}} />)
    expect(screen.getByLabelText('panels')).toHaveAttribute('data-active', 'false')
    await user.keyboard('{Meta>}k{/Meta}')
    const input = screen.getByRole('combobox', { name: '搜索命令' })
    fireEvent.change(input, { target: { value: '明天下午3点 复盘' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const panels = screen.getByLabelText('panels')
    expect(panels).toHaveAttribute('data-active', 'true')
    expect(panels).toHaveAttribute('data-seed', '明天下午3点 复盘')
    expect(screen.getByRole('button', { name: '今日' })).toHaveAttribute('aria-expanded', 'true')
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
