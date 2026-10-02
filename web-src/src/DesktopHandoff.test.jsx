import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ desktopHandoffTicket: vi.fn() }))
import { desktopHandoffTicket } from './api.js'
import { DesktopGuide, useDesktopHandoff } from './DesktopHandoff.jsx'

function Harness({ summon, openProtocol }) {
  const desktop = useDesktopHandoff({ summon, openProtocol })
  return <>
    <button onClick={() => void desktop.activate()}>桌面悬浮窗</button>
    <p role="status">{desktop.note}</p>
    {desktop.guide ? <DesktopGuide {...desktop.guide} onClose={desktop.closeGuide} /> : null}
  </>
}

async function click(summon, openProtocol = vi.fn()) {
  render(<Harness summon={summon} openProtocol={openProtocol} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '桌面悬浮窗' })) })
  return openProtocol
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('网页「桌面悬浮窗」入口', () => {
  it('把领票、jws:// 打开方式与进度回调交给唤起逻辑；自动拉起成功就不弹指引', async () => {
    const summon = vi.fn(async ({ onProgress }) => {
      onProgress('launching')
      return { status: 'awakened', loggedIn: true, launched: true }
    })
    const openProtocol = await click(summon)
    const options = summon.mock.calls[0][0]
    expect(options.fetchTicket).toBe(desktopHandoffTicket)
    expect(options.openProtocol).toBe(openProtocol)
    expect(screen.getByRole('status').textContent).toBe('已启动并亮出桌面悬浮窗')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('没启动：指引首选「应用程序」里的贾维斯与安装桌面端，npm 命令收进「开发者方式」', async () => {
    await click(vi.fn(async () => ({ status: 'not-running', protocolUrl: 'jws://handoff' })))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('没能自动打开桌面悬浮窗')
    expect(dialog.textContent).toContain('打开「应用程序」里的贾维斯')
    expect(screen.getByRole('link', { name: '安装桌面端' })).toBeTruthy()
    const dev = dialog.querySelector('details')
    expect(dev.open).toBe(false)
    expect(dev.querySelector('summary').textContent).toBe('开发者方式（源码运行）')
    expect(dev.textContent).toContain('npm start')
    // npm 命令只出现在折叠区里
    const outside = Array.from(dialog.querySelectorAll('code')).filter(code => !dev.contains(code))
    expect(outside).toHaveLength(0)
    // 面向普通用户的正文不出现协议名 / 命令行
    const plain = dialog.textContent.replace(dev.textContent, '')
    expect(plain).not.toContain('jws://')
    expect(plain).not.toContain('npm')
  })

  it('授权弹窗被关掉（仍待询问）：没启动的指引里补一句去点「允许」', async () => {
    await click(vi.fn(async () => ({ status: 'not-running', protocolUrl: 'jws://handoff', permission: 'prompt' })))
    expect(screen.getByRole('dialog').textContent).toContain('是否允许访问「此设备上的应用」')
  })

  it('Chrome 拒绝过授权：说明是浏览器拦截，并给出放行「此设备上的应用」的方法', async () => {
    await click(vi.fn(async () => ({ status: 'blocked', reason: 'denied', browser: 'chrome', protocolUrl: 'jws://handoff?ticket=t' })))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('浏览器拦住了与桌面悬浮窗的连接')
    expect(dialog.textContent).toContain('此设备上的应用')
    expect(dialog.textContent).toContain('Safari')
    expect(dialog.textContent).not.toContain('没能自动打开')
  })

  it('Safari：说明只能由系统打开，点「允许」', async () => {
    await click(vi.fn(async () => ({ status: 'blocked', reason: 'mixed-content', browser: 'safari', protocolUrl: 'jws://handoff' })))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('是否允许此网页打开“贾维斯”')
    expect(dialog.textContent).not.toContain('此设备上的应用')
  })

  it('等授权弹窗时提示点「允许」；领票失败提示重新登录', async () => {
    let finish
    const summon = vi.fn(({ onProgress }) => new Promise(resolve => { onProgress('permission-prompt'); finish = resolve }))
    await click(summon)
    expect(screen.getByRole('status').textContent).toContain('请点「允许」')
    await act(async () => { finish({ status: 'ticket-failed' }) })
    expect(screen.getByRole('status').textContent).toContain('重新登录')
  })
})
