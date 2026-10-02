import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopHandoffTicket } from './api.js'
import { summonDesktop, PROTOCOL_URL } from './desktopWake.js'
import Modal, { ModalHead } from './Modal.jsx'

const INSTALL_URL = 'https://github.com/123akw/jarvis/blob/main/docs/deployment.md#4-启动-macos-桌面悬浮窗'

/* jws:// 协议拉起：隐藏 iframe 不打断当前页面；没装桌面端就毫无反应。 */
function tryProtocol(url) {
  try {
    const frame = document.createElement('iframe')
    frame.style.display = 'none'
    frame.src = url || PROTOCOL_URL
    document.body.appendChild(frame)
    setTimeout(() => { try { document.body.removeChild(frame) } catch { /* 已移除 */ } }, 2000)
  } catch { /* 尽力而为 */ }
}

const PROGRESS_NOTE = {
  checking: '正在联系桌面悬浮窗…',
  'permission-prompt': '浏览器如果询问是否允许访问「此设备上的应用」，请点「允许」…',
  launching: '正在启动桌面悬浮窗…',
}

/** 网页端「桌面悬浮窗」联动：在跑→领票唤起并接管登录态；探不到→自动用 jws:// 拉起并等它起来；
 *  仍不行才弹指引（区分「浏览器拦截」与「没启动」）。
 *  入口在头像菜单 / ⌘K 命令面板，这里只提供行为（activate）与状态（note / guide）。 */
export function useDesktopHandoff({ summon = summonDesktop, openProtocol = tryProtocol } = {}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [guide, setGuide] = useState(null)   // null | { kind: 'not-running' | 'blocked', reason?, browser? }
  const timer = useRef()
  const busyRef = useRef(false)

  useEffect(() => () => clearTimeout(timer.current), [])

  function flash(text) {
    setNote(text)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setNote(''), 5000)
  }

  const activate = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNote(PROGRESS_NOTE.checking)
    try {
      const result = await summon({
        fetchTicket: desktopHandoffTicket,
        openProtocol,
        onProgress: step => { if (PROGRESS_NOTE[step]) setNote(PROGRESS_NOTE[step]) },
      })
      if (result.status === 'awakened') {
        flash((result.launched ? '已启动并亮出桌面悬浮窗' : '已在桌面亮出悬浮窗') + (result.loggedIn ? '' : '（登录态接管中…）'))
      } else if (result.status === 'blocked') {
        setNote('')
        setGuide({ kind: 'blocked', reason: result.reason, browser: result.browser })
      } else if (result.status === 'not-running') {
        setNote('')
        setGuide({ kind: 'not-running', permission: result.permission })
      } else if (result.status === 'ticket-failed') {
        flash('没能生成接管票据：登录状态可能已过期，请刷新页面重新登录后再试')
      } else {
        flash('联系到了悬浮窗，但这次没唤起成功，请稍后再试')
      }
    } catch {
      flash('桌面联动出了点问题，请稍后再试')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [summon, openProtocol])

  const closeGuide = useCallback(() => setGuide(null), [])
  return { activate, busy, note, guide, closeGuide }
}

function DeveloperWay() {
  return (
    <details className="wx-dev">
      <summary>开发者方式（源码运行）</summary>
      <p className="wx-hint">在仓库根目录执行 <code>cd desktop && npm install && npm start</code>；
        打包成「贾维斯.app」并注册 jws:// 协议：<code>cd desktop && npm run pack:mac && npm run install:mac</code>。</p>
    </details>
  )
}

/* 浏览器拦了本机连接：按浏览器给一句放行方法 */
function BlockedBody({ reason, browser }) {
  const safari = reason === 'mixed-content' || browser === 'safari'
  return (
    <>
      <p className="wx-lead">桌面端可能已经在运行，但浏览器没让本网站连接这台电脑上的应用。刚已改用系统方式唤起，<b>悬浮窗已出现</b>的话可以直接关掉本提示。</p>
      <ol className="wx-steps">
        {safari ? (
          <li><b>Safari</b>：不允许网页直接连接本机应用，只能由系统打开——弹出「是否允许此网页打开“贾维斯”」时点<b>允许</b>；想一键联动可改用 Chrome。</li>
        ) : browser === 'firefox' ? (
          <li><b>Firefox</b>：点地址栏左侧的权限图标，把<b>「设备上的应用和服务」</b>改为允许，然后刷新页面再点一次「桌面悬浮窗」。</li>
        ) : (
          <li><b>Chrome / Edge</b>：点地址栏左侧的网站设置图标，把<b>「此设备上的应用」</b>（旧版叫「本地网络访问」）改为<b>允许</b>，然后刷新页面再点一次「桌面悬浮窗」。</li>
        )}
        {safari ? null : <li><b>Safari</b> 不支持网页直连本机，会改用系统方式打开贾维斯，按提示点「允许」即可。</li>}
        <li>还没装桌面端？请先<a href={INSTALL_URL} target="_blank" rel="noreferrer">安装桌面端</a>，装好后打开「应用程序」里的<b>贾维斯</b>。</li>
      </ol>
    </>
  )
}

function NotRunningBody({ permission }) {
  return (
    <>
      <p className="wx-lead">刚才已尝试自动启动桌面端，但几秒内没等到它。请按下面任一方式打开：</p>
      <ol className="wx-steps">
        {permission === 'prompt' ? <li><b>浏览器询问过</b>是否允许访问「此设备上的应用」？请点<b>允许</b>（关掉了的话：点地址栏左侧的网站设置图标改为允许），再点一次「桌面悬浮窗」。</li> : null}
        <li><b>已安装</b>：打开「应用程序」里的<b>贾维斯</b>，悬浮球出现后回到这里再点一次「桌面悬浮窗」，会自动接管当前登录，无需再输密码。</li>
        <li><b>首次使用</b>：请先<a href={INSTALL_URL} target="_blank" rel="noreferrer">安装桌面端</a>。浏览器问是否打开「贾维斯」时点<b>打开</b>（可勾选始终允许）。</li>
        <li><b>开机自启</b>：悬浮窗「设置」里勾选开机自启，之后网页这边点一下就能唤起。</li>
      </ol>
    </>
  )
}

/** 自动唤起失败时的指引：kind=blocked（浏览器拦截）/ not-running（没启动或没安装） */
export function DesktopGuide({ onClose, kind = 'not-running', reason, browser, permission }) {
  const blocked = kind === 'blocked'
  return (
    <Modal label="桌面悬浮窗启动指引" onClose={onClose} size="sm">
      <ModalHead title={blocked ? '浏览器拦住了与桌面悬浮窗的连接' : '没能自动打开桌面悬浮窗'}
        subtitle="把贾维斯以悬浮球留在桌面，关掉网页也在" onClose={onClose} closeLabel="关闭启动指引" />
      <div className="jv-modal-body">
        {blocked ? <BlockedBody reason={reason} browser={browser} /> : <NotRunningBody permission={permission} />}
        <DeveloperWay />
      </div>
    </Modal>
  )
}
