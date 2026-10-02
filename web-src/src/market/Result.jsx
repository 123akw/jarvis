import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { QrCode } from '../qr.jsx'
import { drawAccountCard } from './accountCard.js'
import { loginPath } from './model.js'   // = routes.js 的 loginHref(username)
import './flow-pages.css'

/* 结果页（第十七轮「少即是多」）：
 * 主角是账号口令卡（大字、单项复制、整体复制 / 存成图片）→ 其次「去登录」主按钮 →
 * 底下两张小卡：装了哪些插件（一行图标串，可展开）、在手机上打开（小二维码）。 */

const ICON_STACK = 6

function CopyButton({ text, label, wideLabel = '', onCopied, className = '' }) {
  const [state, setState] = useState('')
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function go() {
    const ok = await copyText(text)
    setState(ok ? 'ok' : 'fail')
    onCopied?.(ok)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(''), 1800)
  }
  return (
    <button type="button" className={`jvm-rp-copy${state ? ` is-${state}` : ''}${wideLabel ? ' is-wide' : ''} ${className}`.trim()}
      onClick={go} aria-label={label} title={wideLabel ? undefined : label}>
      <Icon name={state === 'ok' ? 'check' : 'copy'} size={wideLabel ? 16 : 17} />
      {wideLabel ? <span>{state === 'ok' ? '已复制' : state === 'fail' ? '没复制成功' : wideLabel}</span> : null}
    </button>
  )
}

/** 结果页：主角是账号 + 口令（只显示这一次）；「去登录」回到登录页并预填账号 */
export default function Result({ platform, plugins, secret, username, signedIn, onLogin, onHome, onReset }) {
  const name = platform?.name || '我的智能体'
  const account = secret?.username || username
  const mobileUrl = `${window.location.origin}${loginPath(account)}`
  const [note, setNote] = useState('')
  const [shot, setShot] = useState(null)   // 账号卡图片：dataURL；'' 表示这台设备画不出来
  const [allPlugins, setAllPlugins] = useState(false)
  const headRef = useRef(null)
  useEffect(() => { headRef.current?.focus({ preventScroll: true }) }, [])
  const copied = ok => setNote(ok ? '已复制到剪贴板' : '没复制成功，请长按手动复制')
  const names = plugins.map(p => p.name).join('、')
  return (
    <section className="jvm-rp" aria-labelledby="jvm-result-title" style={platform?.accent ? { '--pa': platform.accent } : undefined}>
      <header className="jvm-rp-hero">
        <span className="jvm-rp-icon" aria-hidden="true">{platform?.icon || '✨'}</span>
        <p className="jvm-rp-eyebrow">你的智能体已生成</p>
        <h1 id="jvm-result-title" ref={headRef} tabIndex={-1} className="jvm-rp-title">{name}</h1>
        {platform?.tagline ? <p className="jvm-rp-tag">{platform.tagline}</p> : null}
      </header>

      {secret ? (
        <section className="jvm-rp-key" aria-labelledby="jvm-secret-title">
          <header className="jvm-rp-key-head">
            <h2 id="jvm-secret-title">专属账号与口令</h2>
            <p className="jvm-rp-warn" role="note">只显示这一次，请保存</p>
          </header>
          <dl className="jvm-rp-cred">
            <div>
              <dt>账号</dt><dd className="mono">{secret.username}</dd>
              <CopyButton text={secret.username} label="复制账号" onCopied={copied} />
            </div>
            <div>
              <dt>口令</dt><dd className="mono">{secret.password}</dd>
              <CopyButton text={secret.password} label="复制口令" onCopied={copied} />
            </div>
          </dl>
          <div className="jvm-rp-key-actions">
            <CopyButton text={`账号：${secret.username}\n口令：${secret.password}`} label="复制账号和口令" wideLabel="复制账号和口令" onCopied={copied} />
            <button type="button" className="jvm-rp-copy is-wide" onClick={() => setShot(drawAccountCard({
              name, icon: platform?.icon, accent: platform?.accent, username: secret.username, password: secret.password, url: mobileUrl,
            }))}>
              <Icon name="download" size={16} /><span>存成图片</span>
            </button>
          </div>
        </section>
      ) : (
        <section className="jvm-rp-key is-gone" aria-label="专属账号">
          {account ? <p className="jvm-rp-gone-account">账号<b className="mono">{account}</b></p> : null}
          <p>口令只在生成时显示一次。忘了的话，可以请管理员帮你重置。</p>
        </section>
      )}
      <p className="sr-only" aria-live="polite">{note}</p>

      <div className="jvm-rp-go">
        <button type="button" className="jvm-rp-login" onClick={onLogin}>
          {signedIn ? '退出当前账号，去登录' : '去登录'}<Icon name="chevron" size={16} />
        </button>
        <div className="jvm-rp-links">
          {signedIn ? <button type="button" onClick={onHome}>回到我的智能体</button> : null}
          <button type="button" onClick={onReset}>再做一个</button>
        </div>
      </div>

      <div className={`jvm-rp-cards${account ? '' : ' is-single'}`}>
        <section className="jvm-rp-card jvm-rp-plugins" aria-labelledby="jvm-installed-title">
          <h2 id="jvm-installed-title">装了这些插件</h2>
          {plugins.length ? (
            <>
              <div className="jvm-rp-stack-row">
                <span className="jvm-rp-stack" aria-hidden="true">
                  {plugins.slice(0, ICON_STACK).map(p => <i key={p.id}>{p.icon}</i>)}
                  {plugins.length > ICON_STACK ? <i className="is-more">+{plugins.length - ICON_STACK}</i> : null}
                </span>
                <span className="jvm-rp-count">{plugins.length} 个</span>
                <button type="button" className="jvm-rp-toggle" aria-expanded={allPlugins} aria-controls="jvm-rp-plugin-list"
                  onClick={() => setAllPlugins(o => !o)}>{allPlugins ? '收起' : '展开'}</button>
              </div>
              {allPlugins ? null : <p className="jvm-rp-names">{names}</p>}
              <ul id="jvm-rp-plugin-list" className="jvm-rp-list" hidden={!allPlugins}>
                {plugins.map(p => <li key={p.id}><span aria-hidden="true">{p.icon}</span>{p.name}</li>)}
              </ul>
            </>
          ) : <p className="jvm-rp-names">插件清单稍后在主页里能看到。</p>}
        </section>

        {account ? (
          <section className="jvm-rp-card jvm-rp-phone" aria-labelledby="jvm-mobile-title">
            <div className="jvm-rp-qr"><QrCode value={mobileUrl} size={72} label={`在手机上打开的二维码：${mobileUrl}`} /></div>
            <div>
              <h2 id="jvm-mobile-title">在手机上打开</h2>
              <p>扫码打开登录页，账号已填好。</p>
            </div>
          </section>
        ) : null}
      </div>

      {shot !== null ? (
        <Modal label="存成图片" size="sm" onClose={() => setShot(null)} className="jvm-sheet">
          <ModalHead title="存成图片" subtitle="账号和口令都在图上，存进相册就不会丢" onClose={() => setShot(null)} />
          <div className="jv-modal-body jvm-rp-shot">
            {shot ? (
              <>
                <img src={shot} alt={`${name}的账号卡`} />
                <p>手机上长按图片即可保存到相册</p>
                <a className="jvm-rp-dl" href={shot} download={`${name}-账号.png`} data-autofocus>
                  <Icon name="download" size={16} />下载图片
                </a>
              </>
            ) : <p>这台设备画不出图片，请直接截图保存。</p>}
          </div>
        </Modal>
      ) : null}
    </section>
  )
}
