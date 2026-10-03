import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Approve, { POLL } from './Approve.jsx'

/* 「发送前确认」页（契约 docs/proposals/2026-10-round20-flows-ops.md §3.1）：接口用 fetch 替身按契约格式模拟 */

const HOUR = 3600e3
const APPROVAL = () => ({
  id: 'apv123', flow: { id: 'f1', name: '工作日早报' }, run_id: 'r1', node_id: 'ap', title: '发群前给我看看',
  preview: '今天北京晴…', status: 'pending', created_at: new Date(Date.now() - 600e3).toISOString(),
  expires_at: new Date(Date.now() + 23.5 * HOUR).toISOString(), content: '今天北京晴，18–26 度。\n上午 10 点周会。',
  editable: true, next: [{ title: '发到飞书', node_type: 'step' }, { title: '结束', node_type: 'end' }], source: 'schedule',
})

let api
function mockApi({ approval = APPROVAL(), getStatus = 200, postStatus = 200, postError = '', runs = [] } = {}) {
  const state = { approval, calls: [], runs: [...runs] }
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    state.calls.push({ url, method, body })
    if (url === '/api/approvals/apv123' && method === 'GET') {
      return getStatus === 200 ? res({ approval: state.approval }) : res({}, getStatus)
    }
    if (url === '/api/approvals/apv123' && method === 'POST') {
      if (postStatus !== 200) {
        if (state.after409) state.approval = { ...state.approval, ...state.after409 }
        return res(postError ? { error: postError } : {}, postStatus)
      }
      const status = body.decision === 'approve' ? 'approved' : 'rejected'
      state.approval = { ...state.approval, status, note: body.note || '' }
      return res({ approval: state.approval, run: { id: 'r1', status: status === 'approved' ? 'running' : 'rejected' } })
    }
    if (url === '/api/flows/f1/runs/r1') {
      const next = state.runs.length > 1 ? state.runs.shift() : state.runs[0]
      return res({ run: next || { id: 'r1', status: 'running' } })
    }
    return res({ error: 'not mocked' }, 404)
  })
  api = state
  return state
}
const calls = (url, method = 'GET') => api.calls.filter(c => c.url === url && c.method === method)

const fast = { ...POLL }
beforeEach(() => { POLL.fast = 20; POLL.slow = 20 })
afterEach(() => { cleanup(); vi.restoreAllMocks(); Object.assign(POLL, fast); window.history.replaceState({}, '', '/') })

describe('确认页', () => {
  it('待确认：流程名、哪一步、来源、还剩多久；内容可改（恢复原文）；接下来会做什么；同意带上改过的内容 → 接着在跑 → 跑完给结果', async () => {
    mockApi({ runs: [
      { id: 'r1', status: 'running', nodes: [{ node_id: 'f', title: '发到飞书', status: 'running' }] },
      { id: 'r1', status: 'ok', output_text: '**已发到飞书群**', page_url: '/r/tok', links: [{ label: '飞书消息', url: 'https://feishu.cn/x' }] },
    ] })
    render(<Approve id="apv123" onExpired={vi.fn()} />)
    expect(await screen.findByRole('heading', { level: 1, name: '工作日早报' })).toBeInTheDocument()
    expect(screen.getByText(/停在「/)).toHaveTextContent('停在「发群前给我看看」这一步 · 定时运行')
    expect(screen.getByText(/等你确认 · 还剩 23 小时/)).toBeInTheDocument()
    expect(document.title).toBe('确认：工作日早报 · 贾维斯')
    const box = screen.getByRole('textbox', { name: '要发出去的内容' })
    expect(box).toHaveValue('今天北京晴，18–26 度。\n上午 10 点周会。')
    const next = screen.getByRole('region', { name: '同意后接下来会' })
    expect(within(next).getAllByRole('listitem').map(li => li.textContent)).toEqual(['🧱发到飞书', '🏁结束'])
    expect(screen.getByRole('link', { name: /我的流程/ })).toHaveAttribute('href', '/flows')
    fireEvent.change(box, { target: { value: '今天北京晴。' } })
    expect(screen.getByText(/改过了，同意后按改好的发/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复原文' }))
    expect(box).toHaveValue('今天北京晴，18–26 度。\n上午 10 点周会。')
    fireEvent.change(box, { target: { value: '今天北京晴。周会改到下午。' } })
    fireEvent.click(screen.getByRole('button', { name: '按改好的同意' }))
    await waitFor(() => expect(calls('/api/approvals/apv123', 'POST')).toHaveLength(1))
    expect(calls('/api/approvals/apv123', 'POST')[0].body).toEqual({ decision: 'approve', content: '今天北京晴。周会改到下午。' })
    expect(await screen.findByRole('heading', { name: '你同意了，接着在跑' })).toBeInTheDocument()
    expect(screen.getByText('你同意了', { selector: '.fa-eyebrow' })).toBeInTheDocument()
    const done = await screen.findByRole('heading', { name: '跑完了' })
    await waitFor(() => expect(done).toHaveFocus())
    const card = done.closest('section')
    expect(card.querySelector('strong')).toHaveTextContent('已发到飞书群')
    expect(within(card).getByRole('link', { name: /打开结果网页/ })).toHaveAttribute('href', 'http://localhost/r/tok')
    expect(within(card).getByRole('link', { name: '飞书消息' })).toHaveAttribute('href', 'https://feishu.cn/x')
    const asked = calls('/api/flows/f1/runs/r1').length
    expect(asked).toBeGreaterThanOrEqual(2)
    await new Promise(r => setTimeout(r, 80))
    expect(calls('/api/flows/f1/runs/r1')).toHaveLength(asked)   // 跑完就不问了
    fireEvent.click(within(card).getByRole('link', { name: '打开这个流程' }))
    expect(window.location.pathname).toBe('/flows/f1')
  })

  it('不能改的：只读显示，同意只发决定；内容空的不让同意', async () => {
    mockApi({ approval: { ...APPROVAL(), editable: false, content: '**周报**已写好' } })
    render(<Approve id="apv123" />)
    expect(await screen.findByText('这一步设成了不能改：只能同意或拒绝。')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '要发出去的内容' })).toBeNull()
    expect(document.querySelector('.fa-readonly strong')).toHaveTextContent('周报')
    fireEvent.click(screen.getByRole('button', { name: '同意，接着跑' }))
    await waitFor(() => expect(calls('/api/approvals/apv123', 'POST')).toHaveLength(1))
    expect(calls('/api/approvals/apv123', 'POST')[0].body).toEqual({ decision: 'approve' })
    cleanup()
    mockApi()
    render(<Approve id="apv123" />)
    fireEvent.change(await screen.findByRole('textbox', { name: '要发出去的内容' }), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '按改好的同意' }))
    expect(screen.getByRole('alert')).toHaveTextContent('内容是空的')
    expect(calls('/api/approvals/apv123', 'POST')).toHaveLength(0)
  })

  it('拒绝：可以填原因（也能算了不拒）；拒绝后说清楚后面的步骤没跑', async () => {
    mockApi()
    render(<Approve id="apv123" />)
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }))
    const why = screen.getByRole('textbox', { name: /为什么不发/ })
    await waitFor(() => expect(why).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: '算了' }))
    expect(screen.queryByRole('textbox', { name: /为什么不发/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    fireEvent.change(screen.getByRole('textbox', { name: /为什么不发/ }), { target: { value: '数据不对' } })
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }))
    expect(await screen.findByRole('heading', { name: '这一步你已经拒绝了' })).toBeInTheDocument()
    expect(calls('/api/approvals/apv123', 'POST')[0].body).toEqual({ decision: 'reject', note: '数据不对' })
    expect(screen.getByText(/后面的步骤没跑。你写的原因：数据不对/)).toBeInTheDocument()
    expect(screen.getByText('你已经拒绝了', { selector: '.fa-eyebrow' })).toBeInTheDocument()
  })

  it('别处已经处理过（409）：重新读一下，显示现在的状态和服务端的话', async () => {
    const s = mockApi({ postStatus: 409, postError: '这一步已经在飞书里同意过了' })
    s.after409 = { status: 'approved' }
    render(<Approve id="apv123" />)
    fireEvent.click(await screen.findByRole('button', { name: '同意，接着跑' }))
    expect(await screen.findByRole('heading', { name: '这一步你已经同意了' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('这一步已经在飞书里同意过了')
    expect(calls('/api/approvals/apv123')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '看看跑得怎么样了' }))
    expect(await screen.findByRole('heading', { name: '你同意了，接着在跑' })).toBeInTheDocument()
  })

  it('已过期（服务端标了，或时间已过还没清）、找不到、登录过期', async () => {
    mockApi({ approval: { ...APPROVAL(), status: 'expired' } })
    render(<Approve id="apv123" />)
    expect(await screen.findByRole('heading', { name: '这条确认已经过期了' })).toBeInTheDocument()
    expect(screen.getByText(/过了时间没处理，后面的步骤没跑/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /同意/ })).toBeNull()
    cleanup()
    mockApi({ approval: { ...APPROVAL(), expires_at: new Date(Date.now() - HOUR).toISOString() } })
    render(<Approve id="apv123" />)
    expect(await screen.findByRole('heading', { name: '这条确认已经过期了' })).toBeInTheDocument()
    cleanup()
    mockApi({ getStatus: 404 })
    render(<Approve id="apv123" />)
    expect(await screen.findByRole('heading', { name: '找不到这条确认' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到我的流程' })).toHaveAttribute('href', '/flows')
    cleanup()
    mockApi({ getStatus: 401 })
    const onExpired = vi.fn()
    render(<Approve id="apv123" onExpired={onExpired} />)
    await waitFor(() => expect(onExpired).toHaveBeenCalled())
  })

  it('同意后没跑通：说人话；文案不出现技术字眼', async () => {
    mockApi({ runs: [{ id: 'r1', status: 'error', error: '「发到飞书」没发出去：飞书还没绑定' }] })
    const { container } = render(<Approve id="apv123" />)
    fireEvent.click(await screen.findByRole('button', { name: '同意，接着跑' }))
    expect(await screen.findByRole('heading', { name: '没跑通' })).toBeInTheDocument()
    expect(screen.getByText('「发到飞书」没发出去：飞书还没绑定')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/apv123|\br1\b|json|token/i)
  })
})
