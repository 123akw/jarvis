import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({
  getThreads: vi.fn(),
  deleteThread: vi.fn(),
  renameThread: vi.fn(),
  getHistory: vi.fn(),
}))

import { deleteThread, getHistory, getThreads, renameThread } from './api.js'
import Threads from './Threads.jsx'

const LIST = [
  { id: 'a', title: '深圳天气', updated: '2026-08-14 09:00' },
  { id: 'b', title: '写周报', updated: '2026-08-14 08:00' },
]

describe('会话管理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getThreads.mockResolvedValue(LIST)
  })
  afterEach(cleanup)

  it('搜索框按标题过滤会话', async () => {
    render(<Threads current="a" onSelect={() => {}} onNew={() => {}} refreshKey={0} />)
    await screen.findByText('深圳天气')
    fireEvent.change(screen.getByPlaceholderText('搜索对话…'), { target: { value: '周报' } })
    expect(screen.queryByText('深圳天气')).toBeNull()
    expect(screen.getByText('写周报')).toBeTruthy()
  })

  it('重命名：点 ✎ 出输入框，回车保存并调 PATCH', async () => {
    renameThread.mockResolvedValue({ ok: true, title: '天气专线' })
    render(<Threads current="a" onSelect={() => {}} onNew={() => {}} refreshKey={0} />)
    await screen.findByText('深圳天气')
    fireEvent.click(screen.getAllByTitle('重命名')[0])
    const input = screen.getByDisplayValue('深圳天气')
    fireEvent.change(input, { target: { value: '天气专线' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameThread).toHaveBeenCalledWith('a', '天气专线'))
    expect(await screen.findByText('天气专线')).toBeTruthy()
  })

  it('导出会话：点 ⤓ 拉取历史并触发 Markdown 下载', async () => {
    getHistory.mockResolvedValue([
      { role: 'user', content: '明天天气' },
      { role: 'assistant', content: '晴。' },
    ])
    const objectUrls = []
    global.URL.createObjectURL = vi.fn(blob => { objectUrls.push(blob); return 'blob:x' })
    global.URL.revokeObjectURL = vi.fn()
    render(<Threads current="a" onSelect={() => {}} onNew={() => {}} refreshKey={0} />)
    await screen.findByText('深圳天气')
    fireEvent.click(screen.getAllByTitle('导出为 Markdown')[0])
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith('a'))
    expect(objectUrls.length).toBe(1)
    expect(await objectUrls[0].text()).toContain('# 深圳天气')
  })

  it('删除需要二次确认：第一击不删，第二击才调 DELETE', async () => {
    deleteThread.mockResolvedValue({ ok: true })
    render(<Threads current="x" onSelect={() => {}} onNew={() => {}} refreshKey={0} />)
    await screen.findByText('深圳天气')
    const del = screen.getAllByTitle('删除')[0]
    fireEvent.click(del)
    expect(deleteThread).not.toHaveBeenCalled()       // 第一击只进确认态
    fireEvent.click(screen.getByTitle('再点一次确认删除'))
    await waitFor(() => expect(deleteThread).toHaveBeenCalledWith('a'))
  })
})
