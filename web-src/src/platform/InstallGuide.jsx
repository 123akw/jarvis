import { useState } from 'react'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'

const isAndroid = () => typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '')
const inWeChat = () => typeof navigator !== 'undefined' && /micromessenger/i.test(navigator.userAgent || '')

const STEPS = {
  ios: [
    { icon: 'compose', text: <>用 <b>Safari</b> 打开平台链接</> },
    { icon: 'share', text: <>点底部中间的 <b>分享</b> 按钮</> },
    { icon: 'addbox', text: <>选 <b>添加到主屏幕</b>，再点右上角 <b>添加</b></> },
  ],
  android: [
    { icon: 'compose', text: <>用 <b>Chrome</b> 打开平台链接</> },
    { icon: 'more', text: <>点右上角的 <b>⋮</b> 菜单</> },
    { icon: 'addbox', text: <>选 <b>安装应用</b> 或 <b>添加到主屏幕</b></> },
  ],
}

/** 「装到手机主屏」图文指引：iPhone / 安卓两套步骤，默认按当前设备选；在微信里打开时先提示跳到浏览器。
 *  onInstall：浏览器给了一键安装（beforeinstallprompt）时传进来，显示成主按钮；bare：外面已有标题（弹窗里）时不再重复。 */
export default function InstallGuide({ onInstall = null, bare = false }) {
  const [os, setOs] = useState(isAndroid() ? 'android' : 'ios')
  return (
    <section className={`pf-install${bare ? ' bare' : ''}`} aria-label="装到手机主屏">
      <div className="pf-install-head">
        {bare ? null : <h3 className="pf-install-title">装到手机主屏</h3>}
        <div className="pf-seg" role="tablist" aria-label="手机系统">
          {[['ios', 'iPhone'], ['android', '安卓']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={os === id} className={os === id ? 'on' : ''}
              onClick={() => setOs(id)}>{label}</button>
          ))}
        </div>
      </div>
      <p className="pf-install-lead">像 App 一样一点就开，不用再找链接。</p>
      {inWeChat() ? (
        <p className="pf-install-wx">在微信里打开的话，先点右上角 <b>···</b>，选 <b>在浏览器打开</b>。</p>
      ) : null}
      <ol className="pf-steps" role="tabpanel" aria-label={os === 'ios' ? 'iPhone 步骤' : '安卓步骤'}>
        {STEPS[os].map((s, i) => (
          <li key={i} className="pf-step">
            <span className="pf-step-no" aria-hidden="true">{i + 1}</span>
            <span className="pf-step-text">{s.text}</span>
            <span className="pf-step-ico" aria-hidden="true"><Icon name={s.icon} size={18} /></span>
          </li>
        ))}
      </ol>
      {onInstall ? (
        <button type="button" className="jv-btn jv-btn--primary jv-btn--block pf-install-btn" onClick={onInstall}>
          <Icon name="addbox" size={17} />一键装到主屏
        </button>
      ) : null}
    </section>
  )
}

/** 单独弹出的指引（平台入口页底部「装到手机主屏」） */
export function InstallSheet({ onInstall = null, onClose }) {
  return (
    <Modal label="装到手机主屏" size="sm" onClose={onClose}>
      <ModalHead title="装到手机主屏" onClose={onClose} />
      <div className="jv-modal-body"><InstallGuide onInstall={onInstall} bare /></div>
    </Modal>
  )
}
