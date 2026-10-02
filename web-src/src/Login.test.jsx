import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ login: vi.fn() }))

import { login } from './api.js'
import { INTRO_DONE_EVENT, setIntroPlaying } from './intro/registry.js'
import Login from './Login.jsx'

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

describe('登录页形态', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    login.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.classList.remove('light')
  })

  it('只有 J.A.R.V.I.S. 光球形态：没有形态开关，也没有 MOSS 语音', () => {
    render(<Login onAuthed={() => {}} />)
    expect(screen.getByRole('img', { name: /贾维斯/ })).toBeInTheDocument()
    expect(screen.getByText('J.A.R.V.I.S.')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.queryByText(/MOSS/)).not.toBeInTheDocument()
  })

  it('旧数据里存过 MOSS 形态也照常打开光球，并跟随用户主题', () => {
    localStorage.setItem('jv_login_form', 'moss')
    localStorage.setItem('jws_theme', 'light')
    render(<Login onAuthed={() => {}} />)
    expect(screen.getByRole('img', { name: /贾维斯/ })).toBeInTheDocument()
    expect(screen.queryByText(/MOSS/)).not.toBeInTheDocument()
    expect(document.body.classList.contains('light')).toBe(true)
  })

  it('光球形态跟随用户主题（亮色）', () => {
    localStorage.setItem('jws_theme', 'light')
    render(<Login onAuthed={() => {}} />)
    expect(document.body.classList.contains('light')).toBe(true)
  })

  it('localStorage 不可用（隐私模式抛错）时照常渲染', () => {
    const deny = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: deny, setItem: deny, removeItem: deny, clear: deny })
    render(<Login onAuthed={() => {}} />)
    expect(screen.getByRole('img', { name: /贾维斯/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '接入系统' })).toBeEnabled()
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

describe('地址栏 ?u= 预填用户名', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    login.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
  })

  it('只预填用户名、光标落到口令框；登录成功后从地址栏清掉 ?u=，其余参数保留', async () => {
    window.history.replaceState(null, '', '/?intro=off&u=%E9%99%88%E6%80%BB#top')
    const session = { authed: true, username: '陈总' }
    login.mockResolvedValue(session)
    const onAuthed = vi.fn()
    const user = userEvent.setup()
    render(<Login onAuthed={onAuthed} />)
    expect(screen.getByLabelText('用户名')).toHaveValue('陈总')
    expect(screen.getByLabelText('口令')).toHaveValue('')
    expect(screen.getByLabelText('口令')).toHaveFocus()
    await user.keyboard('pw')
    await user.click(screen.getByRole('button', { name: '接入系统' }))
    expect(login).toHaveBeenCalledWith('陈总', 'pw')
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(window.location.search).toBe('?intro=off')
    expect(window.location.hash).toBe('#top')
  })

  it('登录失败时 ?u= 留在地址栏；没有 ?u= 时照旧光标在用户名', async () => {
    window.history.replaceState(null, '', '/?u=owner')
    login.mockResolvedValue(null)
    const user = userEvent.setup()
    render(<Login onAuthed={() => {}} />)
    await user.keyboard('wrong')
    await user.click(screen.getByRole('button', { name: '接入系统' }))
    expect(await screen.findByText('身份未确认，请重试')).toBeInTheDocument()
    expect(window.location.search).toBe('?u=owner')
    cleanup()
    window.history.replaceState(null, '', '/')
    render(<Login onAuthed={() => {}} />)
    expect(screen.getByLabelText('用户名')).toHaveValue('')
    expect(screen.getByLabelText('用户名')).toHaveFocus()
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
