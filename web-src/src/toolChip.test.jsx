import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getHistory: vi.fn(), chatStream: vi.fn(), uploadDocument: vi.fn() }))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { chatStream, getHistory } from './api.js'
import Chat from './Chat.jsx'
import { toolLabel } from './toolInfo.js'

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
    const chipBtn = await screen.findByText(/联网搜索/)
    expect(toolLabel('web_search')).toContain('联网搜索')  // 不再显示英文函数名
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
