import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WeakPasswordNotice from './WeakPasswordNotice.jsx'

describe('WeakPasswordNotice', () => {
  beforeEach(() => { sessionStorage.clear() })
  afterEach(() => { cleanup() })

  it('口令不弱时不出现', () => {
    render(<WeakPasswordNotice weak={false} onFix={() => {}} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('弱口令时提醒，并能一键去修改', async () => {
    const onFix = vi.fn()
    render(<WeakPasswordNotice weak onFix={onFix} />)
    expect(screen.getByRole('alert')).toHaveTextContent('口令过于简单')
    await userEvent.click(screen.getByRole('button', { name: '去修改' }))
    expect(onFix).toHaveBeenCalledTimes(1)
  })

  it('「稍后」本次会话内不再出现', async () => {
    const { unmount } = render(<WeakPasswordNotice weak onFix={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: '稍后' }))
    expect(screen.queryByRole('alert')).toBeNull()
    unmount()
    render(<WeakPasswordNotice weak onFix={() => {}} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('sessionStorage 不可用时不崩，只在当前页隐藏', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    render(<WeakPasswordNotice weak onFix={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: '稍后' }))
    expect(screen.queryByRole('alert')).toBeNull()
    vi.restoreAllMocks()
  })
})
