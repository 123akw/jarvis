import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { QrCode } from '../qr.jsx'
import { drawAccountCard } from './accountCard.js'
import { loginPath } from './model.js'   // = routes.js 的 loginHref(username)
import './flow-pages.css'

/* 结果页（第十七轮「少即是多」，对齐 docs/design/2026-10-market-references.md §5）：单列、单一焦点。
 * 图标 + 「<名字> 已就绪」→ 账号卡（账号 / 口令两行等宽大字，每行一个复制钮；卡内一句警示；卡底全宽主按钮「去登录」）
 * → 次要操作一行文字按钮（复制账号和口令 · 存成图片 · 再做一个）→ 两条折叠：装了哪些插件（叠放图标）、在手机上打开（二维码）。 */

const ICON_STACK = 8

function CopyIcon({ text, label, onCopied }) {
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
    <button type="button" className={`jvm-rp-copy${state ? ` is-${state}` : ''}`} onClick={go} aria-label={label} title={label}>
      <Icon name={state === 'ok' ? 'check' : 'copy'} size={16} />
    </button>
  )
}

/** 一行折叠：标题 + 摘要 + ›，展开后显示内容 */
function Fold({ id, label, title, peek = null, open, onToggle, children }) {
  return (
    <section className={`jvm-rp-fold${open ? ' is-open' : ''}`} aria-label={label}>
      <h2 id={`${id}-h`} className="jvm-rp-fold-h">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          {peek}<span className="jvm-rp-fold-title">{title}</span><Icon name="chevron" size={15} />
        </button>
      </h2>
      <div id={id} className="jvm-rp-fold-body" hidden={!open}>{children}</div>
    </section>
  )
}

/** 结果页：主角是账号 + 口令（只显示这一次）；「去登录」回到登录页并预填账号 */
export default function Result({ platform, plugins, secret, username, signedIn, onLogin, onHome, onReset }) {
  const name = platform?.name || '我的智能体'
  const account = secret?.username || username
  const mobileUrl = `${window.location.origin}${loginPath(account)}`
  const [note, setNote] = useState('')
  const [shot, setShot] = useState(null)   // 账号卡图片：dataURL；'' 表示这台设备画不出来
  const [copiedAll, setCopiedAll] = useState('')
  const [openPlugins, setOpenPlugins] = useState(false)
  const [openPhone, setOpenPhone] = useState(false)
  const headRef = useRef(null)
  const allTimer = useRef(0)
  useEffect(() => { headRef.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => () => clearTimeout(allTimer.current), [])
  const copied = ok => setNote(ok ? '已复制到剪贴板' : '没复制成功，请长按手动复制')
  async function copyAll() {
    const ok = await copyText(`账号：${secret.username}\n口令：${secret.password}`)
    copied(ok)
    setCopiedAll(ok ? 'ok' : 'fail')
    clearTimeout(allTimer.current)
    allTimer.current = setTimeout(() => setCopiedAll(''), 1800)
  }
  const saveImage = () => setShot(drawAccountCard({
    name, icon: platform?.icon, accent: platform?.accent, username: secret.username, password: secret.password, url: mobileUrl,
  }))
  const login = (
    <button type="button" className="jvm-rp-login" onClick={onLogin}>{signedIn ? '退出当前账号，去登录' : '去登录'}</button>
  )

  return (
    <section className="jvm-rp" aria-labelledby="jvm-result-title" style={platform?.accent ? { '--pa': platform.accent } : undefined}>
      <header className="jvm-rp-hero">
        <span className="jvm-rp-icon" aria-hidden="true">{platform?.icon || '✨'}</span>
        <h1 id="jvm-result-title" ref={headRef} tabIndex={-1} className="jvm-rp-title">{name} 已就绪</h1>
        {platform?.tagline ? <p className="jvm-rp-tag">{platform.tagline}</p> : null}
      </header>

      {secret ? (
        <section className="jvm-rp-key" aria-labelledby="jvm-secret-title">
          <h2 id="jvm-secret-title" className="sr-only">专属账号与口令</h2>
          <dl className="jvm-rp-cred">
            <div><dt>账号</dt><dd className="mono">{secret.username}</dd><CopyIcon text={secret.username} label="复制账号" onCopied={copied} /></div>
            <div><dt>口令</dt><dd className="mono">{secret.password}</dd><CopyIcon text={secret.password} label="复制口令" onCopied={copied} /></div>
          </dl>
          <p className="jvm-rp-warn" role="note">口令只显示这一次，请保存好</p>
          {login}
        </section>
      ) : (
        <section className="jvm-rp-key is-gone" aria-label="专属账号">
          <p className="jvm-rp-gone">
            {account ? <>账号 <b className="mono">{account}</b> · </> : null}口令只在生成时显示一次，忘了可以请管理员重置。
          </p>
          {login}
        </section>
      )}
      <p className="sr-only" aria-live="polite">{note}</p>

      <div className="jvm-rp-links">
        {secret ? (
          <>
            <button type="button" onClick={copyAll}>
              {copiedAll === 'ok' ? '已复制' : copiedAll === 'fail' ? '没复制成功' : '复制账号和口令'}
            </button>
            <button type="button" onClick={saveImage}>存成图片</button>
          </>
        ) : null}
        {signedIn ? <button type="button" onClick={onHome}>回到我的智能体</button> : null}
        <button type="button" onClick={onReset}>再做一个</button>
      </div>

      <div className="jvm-rp-folds">
        {plugins.length ? (
          <Fold id="jvm-rp-plugins" label="装了这些插件" title={`查看 ${plugins.length} 个插件`} open={openPlugins} onToggle={() => setOpenPlugins(o => !o)}
            peek={(
              <span className="jvm-rp-stack" aria-hidden="true">
                {plugins.slice(0, ICON_STACK).map(p => <i key={p.id}>{p.icon}</i>)}
                {plugins.length > ICON_STACK ? <i className="is-more">+{plugins.length - ICON_STACK}</i> : null}
              </span>
            )}>
            <ul className="jvm-rp-list">
              {plugins.map(p => <li key={p.id}><span aria-hidden="true">{p.icon}</span>{p.name}</li>)}
            </ul>
          </Fold>
        ) : null}
        {account ? (
          <Fold id="jvm-rp-phone" label="在手机上打开" title="在手机上打开" open={openPhone} onToggle={() => setOpenPhone(o => !o)}
            peek={<span className="jvm-rp-fold-icon" aria-hidden="true"><Icon name="share" size={16} /></span>}>
            <div className="jvm-rp-phone">
              <div className="jvm-rp-qr"><QrCode value={mobileUrl} size={120} label={`在手机上打开的二维码：${mobileUrl}`} /></div>
              <p>扫码打开登录页，账号已经填好。</p>
            </div>
          </Fold>
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
