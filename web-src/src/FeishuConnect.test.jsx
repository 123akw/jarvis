import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./Chat.jsx', () => ({ default: () => <section aria-label="chat" /> }))
vi.mock('./Panels.jsx', () => ({ default: () => <div aria-label="panels" /> }))
vi.mock('./Threads.jsx', () => ({
  default: function ThreadsMock({ onLoaded }) { useEffect(() => { onLoaded?.([]) }, []); return <nav aria-label="threads" /> },
}))

import { createFeishuBindCode, getFeishuStatus, login, unbindFeishu } from './api.js'
import FeishuConnect from './FeishuConnect.jsx'
import Hud from './Hud.jsx'

const ok = data => ({ ok: true, status: 200, json: async () => data })
const STATUS = { state: 'connected', error: '', since: '2026-10-02 10:00:00', configured: true, bot_name: '贾维斯助手', streaming_card: true, bound: false }

/** 按 URL 路由的 fetch 假实现；返回 calls 便于断言 */
function routeFetch(routes) {
  const calls = []
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({ url, opts })
    const key = `${opts.method || 'GET'} ${String(url).split('?')[0]}`
    const r = routes[key]
    if (!r) return { ok: false, status: 404, json: async () => ({ error: 'nf' }) }
    return typeof r === 'function' ? r(opts) : r
  })
  return calls
}

describe('飞书 API', () => {
  afterEach(() => vi.restoreAllMocks())

  it('领绑定码 / 解绑带 CSRF（与微信接口一致）', async () => {
    const calls = routeFetch({
      'POST /api/login': { ok: true },
      'GET /api/session': ok({ authed: true, csrf_token: 'csrf-fs' }),
      'GET /api/feishu/status': ok(STATUS),
      'POST /api/feishu/bind-code': ok({ code: '123456', expires_in: 600, command: '绑定 123456' }),
      'POST /api/feishu/unbind': ok({ ok: true, removed: 1 }),
    })
    await login('owner', 'pw')
    expect(await getFeishuStatus()).toMatchObject({ configured: true })
    expect(await createFeishuBindCode()).toMatchObject({ code: '123456' })
    expect(await unbindFeishu()).toMatchObject({ removed: 1 })
    const writes = calls.filter(c => c.opts.method === 'POST' && c.url.startsWith('/api/feishu/'))
    expect(writes.map(c => c.opts.headers['X-JWS-CSRF'])).toEqual(['csrf-fs', 'csrf-fs'])
  })
})

describe('FeishuConnect 面板', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('未绑定：生成绑定码后醒目显示 6 位码、倒计时，一键复制「绑定 123456」', async () => {
    const calls = routeFetch({
      'GET /api/feishu/status': ok(STATUS),
      'POST /api/feishu/bind-code': ok({ code: '123456', expires_in: 600, command: '绑定 123456' }),
    })
    const user = userEvent.setup()
    render(<FeishuConnect onClose={() => {}} onExpired={() => {}} />)
    expect(await screen.findByText('已连接')).toBeInTheDocument()
    expect(screen.getByText('未绑定')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '生成绑定码' }))
    const code = await screen.findByLabelText('绑定码')
    expect(code).toHaveTextContent('123456')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /复制「绑定 123456」/ }))
    expect(document.querySelector('.fs-issued .wx-lead')).toHaveTextContent('在飞书里私聊机器人「贾维斯助手」，发送这句话')
    expect(screen.getByText(/10:00|9:5\d/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /复制「绑定 123456」/ }))
    expect(await navigator.clipboard.readText()).toBe('绑定 123456')   // user-event 自带的剪贴板桩
    expect(await screen.findByRole('button', { name: /已复制/ })).toBeInTheDocument()
    expect(calls.some(c => c.url === '/api/feishu/bind-code' && c.opts.method === 'POST')).toBe(true)
  })

  it('绑定码到期后提示过期并可重新生成', async () => {
    routeFetch({
      'GET /api/feishu/status': ok(STATUS),
      'POST /api/feishu/bind-code': ok({ code: '654321', expires_in: 1, command: '绑定 654321' }),
    })
    const user = userEvent.setup()
    render(<FeishuConnect onClose={() => {}} onExpired={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '生成绑定码' }))
    await screen.findByLabelText('绑定码')
    expect(await screen.findByText('绑定码已过期', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新生成绑定码' })).toBeInTheDocument()
  })

  it('发出绑定码后轮询状态，绑定成功自动切到「已绑定」', async () => {
    let bound = false
    routeFetch({
      'GET /api/feishu/status': () => ok({ ...STATUS, bound }),
      'POST /api/feishu/bind-code': ok({ code: '123456', expires_in: 600, command: '绑定 123456' }),
    })
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<FeishuConnect onClose={() => {}} onExpired={() => {}} onChange={onChange} pollMs={50} />)
    await user.click(await screen.findByRole('button', { name: '生成绑定码' }))
    await screen.findByLabelText('绑定码')
    bound = true
    expect(await screen.findByText('飞书已绑定')).toBeInTheDocument()
    expect(screen.queryByLabelText('绑定码')).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ bound: true }))
  })

  it('已绑定：解绑需二次确认，取消不发请求，确认后调 unbind', async () => {
    let bound = true
    const calls = routeFetch({
      'GET /api/feishu/status': () => ok({ ...STATUS, bound }),
      'POST /api/feishu/unbind': () => { bound = false; return ok({ ok: true, removed: 1 }) },
    })
    const user = userEvent.setup()
    render(<FeishuConnect onClose={() => {}} onExpired={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '解绑飞书' }))
    expect(screen.getByText(/解绑后/)).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))   // 破坏性操作默认落在「取消」
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(calls.some(c => c.url === '/api/feishu/unbind')).toBe(false)
    await user.click(screen.getByRole('button', { name: '解绑飞书' }))
    await user.click(screen.getByRole('button', { name: '确认解绑' }))
    await waitFor(() => expect(calls.some(c => c.url === '/api/feishu/unbind')).toBe(true))
    expect(await screen.findByText('未绑定')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成绑定码' })).toBeInTheDocument()
  })

  it('连接异常时说明情况（Owner 能看到错误细节）', async () => {
    routeFetch({ 'GET /api/feishu/status': ok({ ...STATUS, state: 'error', error: '凭据无效' }) })
    render(<FeishuConnect onClose={() => {}} onExpired={() => {}} />)
    expect(await screen.findByText('连接异常')).toBeInTheDocument()
    expect(screen.getByText(/凭据无效/)).toBeInTheDocument()
  })

  it('登录失效走 onExpired', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
    const expired = vi.fn()
    render(<FeishuConnect onClose={() => {}} onExpired={expired} />)
    await waitFor(() => expect(expired).toHaveBeenCalled())
  })
})

describe('HUD 飞书入口', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  async function menuNames(user) {
    await user.click(screen.getByRole('button', { name: '账户与设置' }))
    return within(screen.getByRole('menu')).getAllByRole('menuitem').map(el => el.textContent)
  }

  it('飞书已配置：头像菜单出现「接入飞书」并能打开面板', async () => {
    routeFetch({ 'GET /api/feishu/status': ok(STATUS) })
    const user = userEvent.setup()
    render(<Hud session={{ username: 'm', role: 'Member' }} onLogout={() => {}} />)
    await act(async () => {})
    const names = await menuNames(user)
    expect(names.some(n => n.includes('接入飞书'))).toBe(true)
    await user.click(screen.getByRole('menuitem', { name: /接入飞书/ }))
    expect(await screen.findByRole('dialog', { name: '接入飞书' })).toBeInTheDocument()
  })

  it('飞书未配置：不出现入口', async () => {
    routeFetch({ 'GET /api/feishu/status': ok({ ...STATUS, configured: false, state: 'disabled' }) })
    const user = userEvent.setup()
    render(<Hud session={{ username: 'm', role: 'Member' }} onLogout={() => {}} />)
    await act(async () => {})
    const names = await menuNames(user)
    expect(names.some(n => n.includes('飞书'))).toBe(false)
  })
})
