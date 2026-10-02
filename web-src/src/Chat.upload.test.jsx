import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ getHistory: vi.fn(), chatStream: vi.fn(), uploadDocument: vi.fn() }))
vi.mock('./VoiceCall.jsx', () => ({ default: () => null }))

import { chatStream, getHistory, uploadDocument } from './api.js'
import Chat from './Chat.jsx'

async function* streamOk() {
  yield { type: 'token', text: '总结好了。' }
}

describe('文档上传', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getHistory.mockResolvedValue([])
    chatStream.mockImplementation(() => streamOk())
  })
  afterEach(cleanup)

  it('选择文档后解析并作为消息发出（含总结指令与正文）', async () => {
    uploadDocument.mockResolvedValue({
      ok: true, name: '纪要.txt', chars: 9, truncated: false, text: '决议：周五上线',
    })
    render(<Chat threadId="t1" />)
    const picker = await screen.findByLabelText('选择文档')
    const file = new File(['决议：周五上线'], '纪要.txt', { type: 'text/plain' })
    fireEvent.change(picker, { target: { files: [file] } })
    await waitFor(() => expect(uploadDocument).toHaveBeenCalled())
    expect(uploadDocument.mock.calls[0][0]).toBe('纪要.txt')
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    const message = chatStream.mock.calls[0][0]
    expect(message).toContain('《纪要.txt》')
    expect(message).toContain('【文档开始】')
    expect(message).toContain('决议：周五上线')
  })

  it('解析期间显示「正在读取《文件名》…」，完成后消失', async () => {
    let resolve
    uploadDocument.mockImplementation(() => new Promise(r => { resolve = r }))
    render(<Chat threadId="t1" />)
    const picker = await screen.findByLabelText('选择文档')
    fireEvent.change(picker, { target: { files: [new File(['x'], '季度报告.pdf', { type: 'application/pdf' })] } })
    expect(await screen.findByText('正在读取《季度报告.pdf》…')).toBeTruthy()
    await waitFor(() => expect(uploadDocument).toHaveBeenCalled())
    resolve({ ok: true, kind: 'document', name: '季度报告.pdf', chars: 1, truncated: false, text: 'x' })
    await waitFor(() => expect(screen.queryByText('正在读取《季度报告.pdf》…')).toBeNull())
  })

  it('解析失败时给出人话错误提示，不发消息', async () => {
    uploadDocument.mockRejectedValue(new Error('只支持 PDF、Word（.docx）、TXT 和 Markdown 文件'))
    render(<Chat threadId="t1" />)
    const picker = await screen.findByLabelText('选择文档')
    fireEvent.change(picker, { target: { files: [new File(['x'], 'v.exe')] } })
    expect(await screen.findByText(/只支持 PDF/)).toBeTruthy()
    expect(chatStream).not.toHaveBeenCalled()
  })
})

describe('图片 / 视频上传', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getHistory.mockResolvedValue([])
    chatStream.mockImplementation(async function* () { yield { type: 'done' } })
  })
  afterEach(cleanup)

  it('图片走视觉识别：自动发出带图片描述的消息', async () => {
    uploadDocument.mockResolvedValue({ ok: true, kind: 'image', name: '现场.jpg', chars: 20, truncated: false, text: '一间会议室，白板上写着方案 A。' })
    render(<Chat threadId="web" />)
    const input = document.querySelector('input[type=file]')
    fireEvent.change(input, { target: { files: [new File(['fake-jpg'], '现场.jpg', { type: 'image/jpeg' })] } })
    await waitFor(() => expect(uploadDocument).toHaveBeenCalled())
    await waitFor(() => expect(chatStream).toHaveBeenCalled())
    const message = chatStream.mock.calls[0][0]
    expect(message).toContain('图片《现场.jpg》')
    expect(message).toContain('白板上写着方案 A')
  })

  it('视频描述模板注明无声音', async () => {
    uploadDocument.mockResolvedValue({ ok: true, kind: 'video', name: 'demo.mp4', chars: 10, truncated: false, text: '演示了产品首页滚动。' })
    render(<Chat threadId="web" />)
    const input = document.querySelector('input[type=file]')
    fireEvent.change(input, { target: { files: [new File(['fake-mp4'], 'demo.mp4', { type: 'video/mp4' })] } })
    await waitFor(() => expect(chatStream).toHaveBeenCalled())
    expect(chatStream.mock.calls[0][0]).toContain('视频《demo.mp4》')
    expect(chatStream.mock.calls[0][0]).toContain('无声音')
  })
})
