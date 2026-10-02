import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopHandoffTicket } from './api.js'
import { summonDesktop, PROTOCOL_URL } from './desktopWake.js'
import Modal, { ModalHead } from './Modal.jsx'

const README_URL = 'https://github.com/123akw/jarvis#快速开始'

/* jws:// 协议 best-effort 拉起：隐藏 iframe 不打断当前页面；没装桌面端就毫无反应。 */
function tryProtocol(url) {
  try {
    const frame = document.createElement('iframe')
    frame.style.display = 'none'
    frame.src = url || PROTOCOL_URL
    document.body.appendChild(frame)
    setTimeout(() => { try { document.body.removeChild(frame) } catch { /* 已移除 */ } }, 2000)
  } catch { /* 尽力而为 */ }
}

/** 网页端「桌面悬浮窗」联动：在跑→领票唤起并接管登录态；没在跑→jws:// 尝试 + 启动指引。
 *  入口挪进了头像菜单 / ⌘K 命令面板，所以这里只提供行为（activate）与状态（note / guide）。 */
export function useDesktopHandoff() {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [guide, setGuide] = useState(false)
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
    setNote('正在联系桌面悬浮窗…')
    try {
      const result = await summonDesktop({ fetchTicket: desktopHandoffTicket })
      if (result.status === 'awakened') {
        flash('已在桌面亮出悬浮窗' + (result.loggedIn ? '' : '（登录态接管中…）'))
      } else if (result.status === 'not-running') {
        tryProtocol(result.protocolUrl)
        setNote('')
        setGuide(true)
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
  }, [])

  const closeGuide = useCallback(() => setGuide(false), [])
  return { activate, busy, note, guide, closeGuide }
}

/** 桌面端没在跑时的启动指引 */
export function DesktopGuide({ onClose }) {
  return (
    <Modal label="桌面悬浮窗启动指引" onClose={onClose} size="sm">
      <ModalHead title="桌面悬浮窗未启动" subtitle="把贾维斯以悬浮球留在桌面，关掉网页也在" onClose={onClose} closeLabel="关闭启动指引" />
      <div className="jv-modal-body">
        <p className="wx-lead">刚试着通过 <b>jws://</b> 协议拉起桌面端（装过才会有反应）。如果悬浮球没出现，请按下面方式启动：</p>
        <ol className="wx-steps">
          <li>启动命令（macOS，源码方式）：<br /><code>cd desktop && npm install && npm start</code></li>
          <li>开机自启：悬浮窗展开后进「设置」勾选<b>开机自启</b>，之后每次开机贾维斯都自动待命，网页这边点一下就能唤起。</li>
          <li>详细说明见 <a href={README_URL} target="_blank" rel="noreferrer">GitHub README · 快速开始</a>。启动后回到这里再点一次「桌面悬浮窗」即可自动接管当前登录态，无需再输密码。</li>
        </ol>
      </div>
    </Modal>
  )
}
