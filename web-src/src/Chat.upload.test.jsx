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

  it('解析失败时给出人话错误提示，不发消息', async () => {
    uploadDocument.mockRejectedValue(new Error('只支持 PDF、Word（.docx）、TXT 和 Markdown 文件'))
    render(<Chat threadId="t1" />)
    const picker = await screen.findByLabelText('选择文档')
    fireEvent.change(picker, { target: { files: [new File(['x'], 'v.exe')] } })
    expect(await screen.findByText(/只支持 PDF/)).toBeTruthy()
    expect(chatStream).not.toHaveBeenCalled()
  })
})
