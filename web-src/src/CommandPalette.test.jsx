import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from './CommandPalette.jsx'

const quickCmd = run => ({ id: 'quick', label: '速记…', hint: '待办或日程，写上时间就是日程', icon: 'plus', keywords: '速记 待办 日程', run })

describe('⌘K 速记', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 2, 10, 0))
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('没输入时列出「速记…」命令', () => {
    const run = vi.fn()
    render(<CommandPalette commands={[quickCmd(run)]} onQuick={vi.fn()} onPickThread={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('速记…'))
    expect(run).toHaveBeenCalled()
  })

  it('输入一句话：末尾出现「速记「…」」并预告解析结果，回车带草稿去今日板', () => {
    const onQuick = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette commands={[quickCmd(vi.fn()), { id: 'theme', label: '切换到亮色', icon: 'sun', run: vi.fn() }]}
      threads={[{ id: 'a', title: '周报怎么写' }]} onQuick={onQuick} onPickThread={vi.fn()} onClose={onClose} />)
    const input = screen.getByRole('combobox', { name: '搜索命令' })
    fireEvent.change(input, { target: { value: '明天下午3点 复盘' } })
    const option = screen.getByRole('option', { name: /速记「明天下午3点 复盘」/ })
    expect(option).toHaveTextContent('日程 · 明天 10月3日 周六 15:00')
    expect(option).toHaveAttribute('aria-selected', 'true')            // 没有别的匹配时它就是第一项
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onClose).toHaveBeenCalled()
    expect(onQuick).toHaveBeenCalledWith('明天下午3点 复盘')
  })

  it('有会话匹配时速记排在最后，回车仍然打开会话（不误写入）', () => {
    const onQuick = vi.fn()
    const onPickThread = vi.fn()
    render(<CommandPalette commands={[]} threads={[{ id: 'a', title: '写周报' }]} onQuick={onQuick}
      onPickThread={onPickThread} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: '搜索命令' })
    fireEvent.change(input, { target: { value: '周报' } })
    const options = screen.getAllByRole('option')
    expect(options.at(-1)).toHaveTextContent('速记「周报」待办')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPickThread).toHaveBeenCalledWith('a')
    expect(onQuick).not.toHaveBeenCalled()
  })

  it('搜「速记」本身时不重复出一条动态项', () => {
    render(<CommandPalette commands={[quickCmd(vi.fn())]} onQuick={vi.fn()} onPickThread={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox', { name: '搜索命令' }), { target: { value: '速记' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })
})
