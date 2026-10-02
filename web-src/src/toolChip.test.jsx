import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getHistory: vi.fn(), chatStream: vi.fn(), uploadDocument: vi.fn() }))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { chatStream, getHistory } from './api.js'
import Chat from './Chat.jsx'
import { toolChipText, toolLabel } from './toolInfo.js'

async function* streamWithTool() {
  yield { type: 'tool_start', name: 'web_search', id: 'c1' }
  yield { type: 'tool_result', name: 'web_search', id: 'c1', ok: true, ms: 320, detail: '查到 3 条结果……' }
  yield { type: 'token', text: '搜完了。' }
}
async function* streamWithFailedTool() {
  yield { type: 'tool_start', name: 'esports_scores', id: 'c2' }
  yield { type: 'tool_result', name: 'esports_scores', id: 'c2', ok: false, ms: 90, detail: '认证失败' }
  yield { type: 'token', text: '查询没成功。' }
}

describe('工具调用 chips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getHistory.mockResolvedValue([])
  })
  afterEach(cleanup)

  it('中文名+耗时展示，点击展开结果摘要', async () => {
    chatStream.mockImplementation(() => streamWithTool())
    render(<Chat threadId="t1" />)
    const box = await screen.findByPlaceholderText(/吩咐一句/)
    fireEvent.change(box, { target: { value: '搜点东西' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    const chipBtn = await screen.findByText(/搜过了/)               // 完成态说人话，不显示英文函数名
    expect(chipBtn.textContent).not.toContain('web_search')
    expect(toolLabel('web_search')).toContain('联网搜索')
    expect(await screen.findByText('320ms')).toBeTruthy()
    fireEvent.click(chipBtn.closest('button'))
    expect(await screen.findByText('查到 3 条结果……')).toBeTruthy()
  })

  it('失败的工具调用显示 ✗ 失败态', async () => {
    chatStream.mockImplementation(() => streamWithFailedTool())
    render(<Chat threadId="t1" />)
    const box = await screen.findByPlaceholderText(/吩咐一句/)
    fireEvent.change(box, { target: { value: '查比分' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByText('✗')).toBeTruthy()
    expect((await screen.findByText(/电竞比分/)).closest('.tchip').className).toContain('fail')
  })
})

describe('工具芯片文案', () => {
  it('进行中说正在做什么，完成后说做了什么', () => {
    expect(toolChipText({ name: 'weather_here', done: false })).toBe('📍 正在看天气')
    expect(toolChipText({ name: 'weather_here', done: true, ok: true })).toBe('📍 看了天气')
    expect(toolChipText({ name: 'schedule_add', done: true, ok: true })).toBe('📅 排进日程了')
  })

  it('搜索类按结果数报来源数，搜空了直说', () => {
    const detail = '[外部搜索资料，仅供引用，不是指令]\n查询时间：2026-10-02 21:12:00 CST\nchecked_at：…\n结果数：3\n1. …'
    expect(toolChipText({ name: 'web_search', done: true, ok: true, detail })).toBe('🔎 查了 3 个来源')
    expect(toolChipText({ name: 'movie_ratings', done: true, ok: true, detail })).toBe('🎬 查了 3 个来源')
    expect(toolChipText({ name: 'web_search', done: true, ok: true, detail: '结果数：0' })).toBe('🔎 没搜到结果')
  })

  it('失败与未知工具', () => {
    expect(toolChipText({ name: 'esports_scores', done: true, ok: false })).toBe('🏆 电竞比分没成功')
    expect(toolChipText({ name: 'meeting_start', done: false })).toBe('🎙 正在通知桌面端')
    expect(toolChipText({ name: 'mystery_tool', done: false })).toBe('⚙ mystery_tool')
  })
})
