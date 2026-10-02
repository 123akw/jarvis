import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { QrCode } from '../qr.jsx'
import InstallGuide from './InstallGuide.jsx'
import { platformLink } from './platform.js'
import { useInstallPrompt } from './usePlatform.js'
import './platform.css'

/** 分享我的平台：大二维码 + 链接一键复制 + 系统分享（有 navigator.share 时）+ 装到主屏指引。手机上是底部抽屉（Modal 自带）。 */
export default function ShareSheet({ platform, onClose }) {
  const url = platformLink(platform)
  const [copied, setCopied] = useState('')
  const timer = useRef(0)
  const install = useInstallPrompt()
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    const ok = await copyText(url)
    setCopied(ok ? 'ok' : 'fail')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(''), 1800)
  }
  async function share() {
    try {
      await navigator.share({ title: platform.name, text: platform.tagline || `来用我的平台「${platform.name}」`, url })
    } catch { /* 用户取消分享 */ }
  }

  return (
    <Modal label="分享我的平台" size="sm" onClose={onClose} className="pf-share">
      <ModalHead title="分享我的平台" subtitle="扫码就能打开，装到主屏就是一个 App" onClose={onClose} />
      <div className="jv-modal-body pf-share-body">
        <figure className="pf-qr-card">
          <div className="pf-qr-brand">
            <span className="pf-tile sm" aria-hidden="true">{platform.icon || '✨'}</span>
            <span className="pf-qr-name">{platform.name}</span>
          </div>
          <div className="pf-qr-frame">
            <QrCode value={url} size={232} label={`「${platform.name}」的二维码`} />
          </div>
          <figcaption className="pf-qr-tip">用手机相机或微信扫一扫</figcaption>
        </figure>
        <div className="pf-link-row">
          <span className="pf-link" title={url}>{url}</span>
          <button type="button" className={`jv-btn jv-btn--sm pf-copy${copied === 'ok' ? ' done' : ''}`} onClick={() => void copy()}>
            <Icon name={copied === 'ok' ? 'check' : 'copy'} size={15} />
            {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制链接'}
          </button>
        </div>
        <span className="sr-only" role="status">{copied === 'ok' ? '链接已复制' : copied === 'fail' ? '复制失败，请长按链接手动复制' : ''}</span>
        {canShare ? (
          <button type="button" className="jv-btn jv-btn--block pf-sys-share" onClick={() => void share()}>
            <Icon name="share" size={17} />发给朋友…
          </button>
        ) : null}
        <InstallGuide onInstall={install} />
      </div>
    </Modal>
  )
}
