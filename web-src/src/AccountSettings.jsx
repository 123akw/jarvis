import { useEffect, useState } from 'react'
import { changePassword, createUser, getUsers, updateUser } from './api.js'
import { ModalHead } from './Modal.jsx'

const MIN_PASSWORD = 8
const tooShort = pw => pw.length < MIN_PASSWORD

function ErrorMessage({ children }) {
  return children ? <p className="account-error" role="alert">{children}</p> : null
}

/** 服务端给了具体原因就用它（parse() 把 {error} 放进 message），否则用兜底文案 */
const reason = (e, fallback) => (e?.message && e.message !== '请求失败' ? e.message : fallback)

export default function AccountSettings({ session, onReauth, onClose }) {
  const owner = session?.role === 'Owner'
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordMessage, setPasswordMessage] = useState('')
  const [error, setError] = useState('')
  const [users, setUsers] = useState([])
  const [username, setUsername] = useState('')
  const [initialPassword, setInitialPassword] = useState('')
  const [role, setRole] = useState('Member')
  const [managerOpen, setManagerOpen] = useState(false)
  const [userMessage, setUserMessage] = useState('')
  const [busy, setBusy] = useState('')   // 'password' | 'create'：提交中禁用按钮，防连点
  const expired = () => { setError('登录已失效，请重新登录。'); onReauth?.() }

  const loadUsers = async () => {
    if (!owner) return
    try { setUsers(await getUsers()) } catch (e) { if (e.message === '401') expired(); else setError('无法读取用户列表。') }
  }
  useEffect(() => { void loadUsers() }, [owner])

  async function submitPassword(event) {
    event.preventDefault()
    setError(''); setPasswordMessage(''); setUserMessage('')
    if (tooShort(newPassword)) { setError(`新口令至少 ${MIN_PASSWORD} 位。`); return }
    setBusy('password')
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword(''); setNewPassword('')
      setPasswordMessage('口令已更新，请重新登录。')
      onReauth?.('password-changed')
    } catch (e) {
      if (e.message === '401') expired(); else setError(`${reason(e, '无法更新口令')}。`.replace(/。。$/, '。'))
    } finally {
      setBusy('')
    }
  }

  async function submitUser(event) {
    event.preventDefault()
    setError(''); setUserMessage('')
    if (tooShort(initialPassword)) { setError(`初始口令至少 ${MIN_PASSWORD} 位。`); return }
    const name = username.trim()
    setBusy('create')
    try {
      await createUser({ username, password: initialPassword, role })
      setUsername(''); setInitialPassword(''); setRole('Member')
      setUserMessage(`已创建用户 ${name}`)
      await loadUsers()
    } catch (e) {
      // 服务端对重名等情况只回「无法创建用户」，补一句最常见的原因
      if (e.message === '401') expired(); else setError(`${reason(e, '无法创建用户，请稍后重试')}。`.replace(/。。$/, '。'))
    } finally {
      setBusy('')
    }
  }

  async function patchUser(user, patch, done) {
    setError(''); setUserMessage('')
    if (patch.password !== undefined && tooShort(patch.password)) { setError(`口令至少 ${MIN_PASSWORD} 位。`); return false }
    try {
      await updateUser(user.id, patch)
      await loadUsers()
      if (done) setUserMessage(done)
      return true
    } catch (e) { if (e.message === '401') expired(); else setError(`${reason(e, '无法更新用户')}。`.replace(/。。$/, '。')); return false }
  }

  return (
    <section className="jv-sheet account-sheet" aria-label="账户设置">
      <ModalHead title="账户设置" subtitle={<>{session?.username} · {session?.role}</>}
        onClose={onClose} closeLabel="关闭账户设置" />
      <div className="jv-modal-body">
        <h3 className="jv-section-title">修改口令</h3>
        <form className="account-form" onSubmit={submitPassword}>
          <label>当前口令<input aria-label="当前口令" type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoComplete="current-password" required /></label>
          <label>新口令<input aria-label="新口令" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" required
            placeholder={`至少 ${MIN_PASSWORD} 位`} /></label>
          <div className="jv-actions"><button className="jv-btn jv-btn--primary" type="submit" disabled={busy === 'password'}>
            {busy === 'password' ? '更新中…' : '更新口令'}</button></div>
        </form>
        {passwordMessage ? <p className="account-ok" role="status">{passwordMessage}</p> : null}
        <ErrorMessage>{error}</ErrorMessage>
        {owner ? <div className="user-manager">
          <button type="button" className="jv-disclosure" onClick={() => setManagerOpen(v => !v)} aria-expanded={managerOpen}>用户管理</button>
          {managerOpen ? <>
            <form className="account-form" onSubmit={submitUser}>
              <label>新用户名<input aria-label="新用户名" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" required /></label>
              <label>初始口令<input aria-label="初始口令" type="password" value={initialPassword} onChange={e => setInitialPassword(e.target.value)} autoComplete="new-password" required
                placeholder={`至少 ${MIN_PASSWORD} 位`} /></label>
              <label>角色<select value={role} onChange={e => setRole(e.target.value)}><option>Member</option><option>Owner</option></select></label>
              <div className="jv-actions"><button className="jv-btn jv-btn--primary" type="submit" disabled={busy === 'create'}>
                {busy === 'create' ? '创建中…' : '创建用户'}</button></div>
            </form>
            {userMessage ? <p className="account-ok" role="status">{userMessage}</p> : null}
            <div className="user-list" aria-label="用户列表">{users.map(user => <UserRow key={user.id} user={user} onPatch={patchUser} />)}</div>
          </> : null}
        </div> : null}
      </div>
    </section>
  )
}

function UserRow({ user, onPatch }) {
  const [password, setPassword] = useState('')
  return <div className="user-row"><span className="user-name" title={user.username}>{user.username}</span>
    <select aria-label={`${user.username} 角色`} value={user.role} onChange={e => onPatch(user, { role: e.target.value }, `已把 ${user.username} 设为 ${e.target.value}`)}><option>Member</option><option>Owner</option></select>
    <button type="button" className="jv-btn jv-btn--sm" onClick={() => onPatch(user, { active: !user.active }, `已${user.active ? '停用' : '启用'} ${user.username}`)}>{user.active ? '停用' : '启用'}</button>
    <input aria-label={`重置 ${user.username} 口令`} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"
      placeholder="新口令（至少 8 位）" />
    <button type="button" className="jv-btn jv-btn--sm" disabled={!password} onClick={async () => { if (await onPatch(user, { password }, `已重置 ${user.username} 的口令`)) setPassword('') }}>重置口令</button>
  </div>
}
