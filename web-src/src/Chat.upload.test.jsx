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

describe('办公文件附件：存进文件空间并在消息里带附件标记', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getHistory.mockResolvedValue([])
    chatStream.mockImplementation(() => streamOk())
  })
  afterEach(cleanup)

  async function pick(name, type = '') {
    render(<Chat threadId="t1" />)
    const picker = await screen.findByLabelText('选择文档')
    fireEvent.change(picker, { target: { files: [new File(['x'], name, { type })] } })
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    return chatStream.mock.calls[0][0]
  }

  it('选择框接受 Excel / CSV / Word / PDF', async () => {
    render(<Chat threadId="t1" />)
    const accept = (await screen.findByLabelText('选择文档')).getAttribute('accept')
    for (const ext of ['.pdf', '.docx', '.xlsx', '.csv', '.xls']) expect(accept).toContain(ext)
  })

  it('Excel：表格模板 + 附件标记 + 表格文字', async () => {
    uploadDocument.mockResolvedValue({
      ok: true, kind: 'table', name: '报销.xlsx', chars: 30, truncated: false,
      text: '## 工作表：明细\n\n| 部门 | 金额 |\n| --- | --- |\n| 销售部 | 1200 |',
      file: { id: 'AbC123xyz', name: '报销.xlsx', url: '/api/files/AbC123xyz', marker: '［附件：报销.xlsx · file_id=AbC123xyz］' },
    })
    const message = await pick('报销.xlsx')
    expect(message).toContain('这份表格《报销.xlsx》')
    expect(message).toContain('［附件：报销.xlsx · file_id=AbC123xyz］')
    expect(message).toContain('【表格开始】')
    expect(message).toContain('| 销售部 | 1200 |')
    expect(message.indexOf('［附件')).toBeLessThan(message.indexOf('【表格开始】'))   // 标记在前，折叠时也看得见
  })

  it('PDF：文档模板照旧并带附件标记', async () => {
    uploadDocument.mockResolvedValue({
      ok: true, kind: 'document', name: '合同.pdf', chars: 4, truncated: false, text: '甲方乙方',
      file: { id: 'PdF987abc', name: '合同.pdf', url: '/api/files/PdF987abc', marker: '［附件：合同.pdf · file_id=PdF987abc］' },
    })
    const message = await pick('合同.pdf', 'application/pdf')
    expect(message).toContain('请通读这份文档《合同.pdf》')
    expect(message).toContain('［附件：合同.pdf · file_id=PdF987abc］')
    expect(message).toContain('【文档开始】\n甲方乙方\n【文档结束】')
  })

  it('读不出文字的 PDF（扫描件）：仍发出附件标记，说明原因', async () => {
    uploadDocument.mockResolvedValue({
      ok: true, kind: 'document', name: '扫描件.pdf', chars: 0, truncated: false, text: '',
      note: '没有从文档里读到文字（可能是纯图片扫描件）',
      file: { id: 'ScAn12345', name: '扫描件.pdf', url: '/api/files/ScAn12345', marker: '［附件：扫描件.pdf · file_id=ScAn12345］' },
    })
    const message = await pick('扫描件.pdf')
    expect(message).toContain('没能读出文字')
    expect(message).toContain('file_id=ScAn12345')
    expect(message).not.toContain('【文档开始】')
  })

  it('文件空间满了：文字照发，另外提示原文件没保存', async () => {
    uploadDocument.mockResolvedValue({
      ok: true, kind: 'table', name: '名单.csv', chars: 5, truncated: false, text: '| 姓名 |', file: null,
      file_error: '文件空间已满（每个账号 200MB），请先删掉一些不用的文件再试（这次只读取了文字，原文件没有保存）',
    })
    const message = await pick('名单.csv')
    expect(message).not.toContain('［附件')
    expect(await screen.findByText(/原文件没有保存/)).toBeTruthy()
  })

  it('老版 .xls 的人话错误直接展示', async () => {
    uploadDocument.mockRejectedValue(new Error('暂不支持老版 Excel（.xls）：请在 Excel 或 WPS 里「另存为」.xlsx 后再上传'))
    render(<Chat threadId="t1" />)
    const picker = await screen.findByLabelText('选择文档')
    fireEvent.change(picker, { target: { files: [new File(['x'], '老表.xls')] } })
    expect(await screen.findByText(/另存为」.xlsx/)).toBeTruthy()
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
