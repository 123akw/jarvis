import { useState } from 'react'
import Modal, { ModalHead } from '../Modal.jsx'

const TITLES = {
  closed: ['市场注册暂未开放', '管理员登录后可以直接帮你生成。'],
  invite: ['凭邀请码开通', '填上邀请码，马上给你开一套专属账号。'],
}

function LoginForm({ busy, onLogin }) {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const submit = e => {
    e.preventDefault()
    if (!u.trim() || !p || busy) return
    onLogin(u.trim(), p)
  }
  return (
    <form className="jvm-gate-form" onSubmit={submit} aria-label="管理员登录">
      <label className="jvm-field">
        <span className="jvm-field-label">管理员用户名</span>
        <input value={u} onChange={e => setU(e.target.value)} autoComplete="username" spellCheck={false} data-autofocus />
      </label>
      <label className="jvm-field">
        <span className="jvm-field-label">口令</span>
        <input type="password" value={p} onChange={e => setP(e.target.value)} autoComplete="current-password" />
      </label>
      <button type="submit" className="jvm-btn jvm-btn--block" disabled={busy || !u.trim() || !p}>
        {busy ? '请稍候…' : '登录并生成'}
      </button>
    </form>
  )
}

function InviteForm({ busy, onInvite }) {
  const [code, setCode] = useState('')
  const submit = e => {
    e.preventDefault()
    if (!code.trim() || busy) return
    onInvite(code.trim())
  }
  return (
    <form className="jvm-gate-form" onSubmit={submit} aria-label="邀请码">
      <label className="jvm-field">
        <span className="jvm-field-label">邀请码</span>
        <input value={code} onChange={e => setCode(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus />
      </label>
      <button type="submit" className="jvm-btn jvm-btn--block" disabled={busy || !code.trim()}>
        {busy ? '正在生成…' : '开通并生成'}
      </button>
    </form>
  )
}

/** 游客生成前的拦路口：注册关闭（只能管理员登录后生成）/ 要邀请码（也可管理员登录） */
export default function Gate({ mode, message, busy, onClose, onInvite, onLogin }) {
  const [adminLogin, setAdminLogin] = useState(mode !== 'invite')
  const [title, sub] = TITLES[mode] || TITLES.closed
  const close = busy ? undefined : onClose
  return (
    <Modal label={title} size="sm" onClose={close} dismissOnBackdrop={false} className="jvm-sheet">
      <ModalHead title={title} subtitle={adminLogin && mode === 'invite' ? '管理员登录后可以直接帮你生成。' : sub} onClose={close} />
      <div className="jv-modal-body jvm-gate">
        {message ? <p className="jvm-alert" role="alert">{message}</p> : null}
        {adminLogin ? <LoginForm busy={busy} onLogin={onLogin} /> : <InviteForm busy={busy} onInvite={onInvite} />}
        {mode === 'invite' ? (
          <button type="button" className="jvm-link jvm-gate-switch" onClick={() => setAdminLogin(a => !a)}>
            {adminLogin ? '我有邀请码' : '管理员登录后直接生成'}
          </button>
        ) : null}
      </div>
    </Modal>
  )
}
