import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ login: vi.fn() }))
vi.mock('./Moss.jsx', () => ({ default: ({ spinup }) => <div aria-label="MOSS 3D" data-spinup={String(spinup)} /> }))

import { login } from './api.js'
import { INTRO_DONE_EVENT, setIntroPlaying } from './intro/registry.js'
import Login, { LOGIN_FORM_KEY } from './Login.jsx'

// 本 jsdom 环境不带 localStorage，按仓库惯例 stub 一个内存版
function memoryStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: k => { m.delete(k) },
    clear: () => m.clear(),
  }
}

describe('登录页形态切换', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    login.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.classList.remove('light')
  })

  it('默认是 J.A.R.V.I.S. 光球形态，不加载 MOSS', () => {
    render(<Login onAuthed={() => {}} />)
    expect(screen.getByRole('radio', { name: 'J.A.R.V.I.S.' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('img', { name: /贾维斯/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('MOSS 3D')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /MOSS 语音/ })).not.toBeInTheDocument()
  })

  it('切到 MOSS：记住选择，3D 机头、语音开关回来；再切回光球', async () => {
    const user = userEvent.setup()
    render(<Login onAuthed={() => {}} />)
    await user.click(screen.getByRole('radio', { name: 'MOSS' }))
    expect(localStorage.getItem(LOGIN_FORM_KEY)).toBe('moss')
    expect(await screen.findByLabelText('MOSS 3D')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /MOSS 语音/ })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /贾维斯/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'J.A.R.V.I.S.' }))
    expect(localStorage.getItem(LOGIN_FORM_KEY)).toBe('orb')
    expect(screen.getByRole('img', { name: /贾维斯/ })).toBeInTheDocument()
  })

  it('上次选了 MOSS 就直接以 MOSS 形态打开，且固定暗色', async () => {
    localStorage.setItem(LOGIN_FORM_KEY, 'moss')
    localStorage.setItem('jws_theme', 'light')
    render(<Login onAuthed={() => {}} />)
    expect(await screen.findByLabelText('MOSS 3D')).toBeInTheDocument()
    expect(document.body.classList.contains('light')).toBe(false)
  })

  it('光球形态跟随用户主题（亮色）', () => {
    localStorage.setItem('jws_theme', 'light')
    render(<Login onAuthed={() => {}} />)
    expect(document.body.classList.contains('light')).toBe(true)
  })

  it('localStorage 不可用（隐私模式抛错）时照常渲染、照常切换', async () => {
    const deny = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: deny, setItem: deny, removeItem: deny, clear: deny })
    const user = userEvent.setup()
    render(<Login onAuthed={() => {}} />)
    expect(screen.getByRole('radio', { name: 'J.A.R.V.I.S.' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'MOSS' }))
    expect(await screen.findByLabelText('MOSS 3D')).toBeInTheDocument()
  })
})

describe('登录流程', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    login.mockReset()
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('成功：光球扩散过渡后进入主界面，并把扩散中心交给主界面做光晕交接', async () => {
    const session = { authed: true, username: 'owner' }
    login.mockResolvedValue(session)
    const onAuthed = vi.fn()
    const user = userEvent.setup()
    render(<Login onAuthed={onAuthed} />)
    await user.type(screen.getByLabelText('用户名'), 'owner')
    await user.type(screen.getByLabelText('口令'), 'pw')
    await user.click(screen.getByRole('button', { name: '接入系统' }))
    expect(login).toHaveBeenCalledWith('owner', 'pw')
    expect(onAuthed).not.toHaveBeenCalled() // 先播过渡
    expect(screen.getByRole('button', { name: '正在接入…' })).toBeDisabled()
    await waitFor(() => expect(document.querySelector('.jv-bloom.is-in')).toBeInTheDocument())
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(onAuthed.mock.calls[0][0]).toBe(session)
    expect(onAuthed.mock.calls[0][1]).toHaveProperty('handoff')
  })

  it('失败：提示重试、卡片抖动、不进入主界面；网络异常同样按失败处理', async () => {
    login.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'))
    const onAuthed = vi.fn()
    const user = userEvent.setup()
    render(<Login onAuthed={onAuthed} />)
    await user.type(screen.getByLabelText('用户名'), 'owner')
    await user.type(screen.getByLabelText('口令'), 'wrong')
    await user.click(screen.getByRole('button', { name: '接入系统' }))
    expect(await screen.findByText('身份未确认，请重试')).toBeInTheDocument()
    expect(document.querySelector('.jvl-card')).toHaveClass('shake')
    await user.type(screen.getByLabelText('口令'), 'wrong-again')
    await user.click(screen.getByRole('button', { name: '接入系统' }))
    await waitFor(() => expect(login).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: '接入系统' })).toBeEnabled()
    expect(onAuthed).not.toHaveBeenCalled()
  })
})

describe('登录页与进场动画的交接', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()) })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    setIntroPlaying(false)
  })

  it('没有进场动画：照常立刻入场', () => {
    const { container } = render(<Login onAuthed={() => {}} />)
    expect(container.querySelector('.jv-login')).not.toHaveClass('intro-hold')
    expect(container.querySelector('.jv-login')).not.toHaveClass('after-intro')
  })

  it('进场动画播放中：问候语和登录卡先不入场，收到 jv:intro-done 再入场', () => {
    setIntroPlaying(true)
    const { container } = render(<Login onAuthed={() => {}} />)
    const root = container.querySelector('.jv-login')
    expect(root).toHaveClass('intro-hold')
    act(() => {
      setIntroPlaying(false)
      window.dispatchEvent(new Event(INTRO_DONE_EVENT))
    })
    expect(root).not.toHaveClass('intro-hold')
    expect(root).toHaveClass('after-intro')
  })
})
