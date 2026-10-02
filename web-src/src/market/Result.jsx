import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { QrCode } from '../qr.jsx'
import { drawAccountCard } from './accountCard.js'
import { loginPath } from './model.js'   // = routes.js 的 loginHref(username)

function CopyButton({ text, label, wideLabel, onCopied, className = '' }) {
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
    <button type="button" className={`jvm-copy ${state ? `is-${state}` : ''} ${className}`.trim()} onClick={go} aria-label={label}>
      <Icon name={state === 'ok' ? 'check' : 'copy'} size={15} />
      <span>{state === 'ok' ? '已复制' : state === 'fail' ? '没复制成功' : (wideLabel || '复制')}</span>
    </button>
  )
}

/** 结果页：主角是账号 + 口令（只显示这一次），旁边列出装了哪些插件；「去登录」回到登录页并预填账号 */
export default function Result({ platform, plugins, secret, username, signedIn, onLogin, onHome, onReset }) {
  const name = platform?.name || '我的智能体'
  const account = secret?.username || username
  const mobileUrl = `${window.location.origin}${loginPath(account)}`
  const [note, setNote] = useState('')
  const [shot, setShot] = useState(null)   // 账号卡图片：dataURL；'' 表示这台设备画不出来
  const headRef = useRef(null)
  useEffect(() => { headRef.current?.focus({ preventScroll: true }) }, [])
  const copied = ok => setNote(ok ? '已复制到剪贴板' : '没复制成功，请长按手动复制')
  return (
    <section className="jvm-result" aria-labelledby="jvm-result-title" style={platform?.accent ? { '--pa': platform.accent } : undefined}>
      <div className="jvm-result-hero">
        <span className="jvm-result-icon" aria-hidden="true">{platform?.icon || '✨'}</span>
        <p className="jvm-eyebrow">你的智能体已生成</p>
        <h1 id="jvm-result-title" ref={headRef} tabIndex={-1} className="jvm-step-title">{name}</h1>
        {platform?.tagline ? <p className="jvm-step-sub">{platform.tagline}</p> : null}
      </div>

      <div className="jvm-result-grid">
        {secret ? (
          <section className="jvm-secret" aria-labelledby="jvm-secret-title">
            <header>
              <h2 id="jvm-secret-title">专属账号与口令</h2>
              <p className="jvm-secret-warn" role="note">只显示这一次，请保存</p>
            </header>
            <dl>
              <div><dt>账号</dt><dd className="mono">{secret.username}</dd>
                <CopyButton text={secret.username} label="复制账号" onCopied={copied} /></div>
              <div><dt>口令</dt><dd className="mono">{secret.password}</dd>
                <CopyButton text={secret.password} label="复制口令" onCopied={copied} /></div>
            </dl>
            <div className="jvm-secret-actions">
              <CopyButton className="is-wide" text={`账号：${secret.username}\n口令：${secret.password}`}
                label="复制账号和口令" wideLabel="复制账号和口令" onCopied={copied} />
              <button type="button" className="jvm-copy is-tall" onClick={() => setShot(drawAccountCard({
                name, icon: platform?.icon, accent: platform?.accent, username: secret.username, password: secret.password, url: mobileUrl,
              }))}>
                <Icon name="download" size={15} /><span>存成图片</span>
              </button>
            </div>
          </section>
        ) : (
          <section className="jvm-secret is-gone" aria-label="专属账号">
            {account ? <p>账号：<b className="mono">{account}</b></p> : null}
            <p>口令只在生成时显示一次。忘了的话，可以请管理员帮你重置。</p>
          </section>
        )}
        <section className="jvm-installed" aria-labelledby="jvm-installed-title">
          <h2 id="jvm-installed-title">装了这些插件<span>{plugins.length}</span></h2>
          {plugins.length ? (
            <ul>{plugins.map(p => <li key={p.id}><span aria-hidden="true">{p.icon}</span>{p.name}</li>)}</ul>
          ) : <p className="jvm-a2hs">插件清单稍后在主页里能看到。</p>}
          <p className="jvm-a2hs">登录后，智能体只用这些插件为你干活，随时能在主页里增减。</p>
        </section>
      </div>
      <p className="sr-only" aria-live="polite">{note}</p>

      <div className="jvm-result-actions">
        <button type="button" className="jvm-btn jvm-btn--hero" onClick={onLogin}>
          {signedIn ? '退出当前账号，去登录' : '去登录'}
        </button>
        {signedIn ? <button type="button" className="jvm-link" onClick={onHome}>回到我的智能体</button> : null}
        <button type="button" className="jvm-link" onClick={onReset}>再做一个</button>
      </div>

      {account ? (
        <section className="jvm-mobile" aria-labelledby="jvm-mobile-title">
          <div className="jvm-qr-wrap"><QrCode value={mobileUrl} size={104} label={`在手机上打开的二维码：${mobileUrl}`} /></div>
          <div>
            <h2 id="jvm-mobile-title">在手机上打开</h2>
            <p className="jvm-a2hs">扫码打开登录页，账号已经填好；登录后点浏览器的「分享 → 添加到主屏幕」，就像一个 App。</p>
          </div>
        </section>
      ) : null}

      {shot !== null ? (
        <Modal label="存成图片" size="sm" onClose={() => setShot(null)} className="jvm-sheet">
          <ModalHead title="存成图片" subtitle="账号和口令都在图上，存进相册就不会丢" onClose={() => setShot(null)} />
          <div className="jv-modal-body jvm-shot">
            {shot ? (
              <>
                <img src={shot} alt={`${name}的账号卡`} />
                <p>手机上长按图片即可保存到相册</p>
                <a className="jvm-btn jvm-btn--block" href={shot} download={`${name}-账号.png`} data-autofocus>下载图片</a>
              </>
            ) : <p>这台设备画不出图片，请直接截图保存。</p>}
          </div>
        </Modal>
      ) : null}
    </section>
  )
}
