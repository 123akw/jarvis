import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import WeChatConnect from './WeChatConnect.jsx'

describe('WeChatConnect', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the live QR returned by the bridge after connect', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ state: 'idle', qr_uri: '', error: '', since: '' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          state: 'waiting',
          qr_uri: 'data:image/svg+xml,qr',
          error: '',
          since: '13:30:00',
        }),
      })
    const user = userEvent.setup()
    render(<WeChatConnect onClose={() => {}} onExpired={() => {}} />)

    await user.click(await screen.findByRole('button', { name: '生成二维码，开始接入' }))

    const qr = await screen.findByRole('img', { name: '微信登录二维码' })
    expect(qr).toHaveAttribute('src', 'data:image/svg+xml,qr')
    expect(global.fetch).toHaveBeenNthCalledWith(
      2, '/api/wechat/connect', { method: 'POST', headers: {} })
  })

  it('reports expired authentication and clears polling on unmount', async () => {
    const expired = vi.fn()
    const clear = vi.spyOn(global, 'clearInterval')
    global.fetch = vi.fn().mockResolvedValue({ status: 401 })
    const view = render(
      <WeChatConnect onClose={() => {}} onExpired={expired} />,
    )

    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1))
    view.unmount()

    expect(clear).toHaveBeenCalled()
  })

  it('returns to a retryable error state when QR generation fails', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ state: 'idle', qr_uri: '', error: '', since: '' }),
      })
      .mockRejectedValueOnce(new TypeError('network down'))
    const user = userEvent.setup()
    render(<WeChatConnect onClose={() => {}} onExpired={() => {}} />)

    await user.click(await screen.findByRole('button', { name: '生成二维码，开始接入' }))

    expect(await screen.findByText('⚠ 连不上微信桥，请稍后重试'))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成二维码，开始接入' }))
      .toBeInTheDocument()
  })

  it('cancels a waiting QR session and returns to the connect action', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          state: 'waiting', qr_uri: 'data:image/svg+xml,qr', error: '', since: '13:40:00',
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ state: 'idle', qr_uri: '', error: '', since: '' }),
      })
    const user = userEvent.setup()
    render(<WeChatConnect onClose={() => {}} onExpired={() => {}} />)

    await user.click(await screen.findByRole('button', { name: '取消本次扫码' }))

    expect(await screen.findByRole('button', { name: '生成二维码，开始接入' }))
      .toBeInTheDocument()
    expect(global.fetch).toHaveBeenNthCalledWith(
      2, '/api/wechat/disconnect', { method: 'POST', headers: {} })
  })
})
