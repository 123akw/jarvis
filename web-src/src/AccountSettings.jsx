import { useEffect, useState } from 'react'
import { changePassword, createUser, getUsers, updateUser } from './api.js'

function ErrorMessage({ children }) {
  return children ? <p className="account-error" role="alert">{children}</p> : null
}

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
  const expired = () => { setError('登录已失效，请重新登录。'); onReauth?.() }

  const loadUsers = async () => {
    if (!owner) return
    try { setUsers(await getUsers()) } catch (e) { if (e.message === '401') expired(); else setError('无法读取用户列表。') }
  }
  useEffect(() => { void loadUsers() }, [owner])

  async function submitPassword(event) {
    event.preventDefault()
    setError(''); setPasswordMessage('')
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword(''); setNewPassword('')
      setPasswordMessage('口令已更新，请重新登录。')
      onReauth?.('password-changed')
    } catch (e) { if (e.message === '401') expired(); else setError('无法更新口令。') }
  }

  async function submitUser(event) {
    event.preventDefault()
    setError('')
    try {
      await createUser({ username, password: initialPassword, role })
      setUsername(''); setInitialPassword(''); setRole('Member')
      await loadUsers()
    } catch (e) { if (e.message === '401') expired(); else setError('无法创建用户。') }
  }

  async function patchUser(id, patch) {
    setError('')
    try {
      await updateUser(id, patch)
      await loadUsers()
      return true
    } catch (e) { if (e.message === '401') expired(); else setError('无法更新用户。'); return false }
  }

  return (
    <section className="account-card" aria-label="账户设置">
      <div className="account-head"><div><b>{session?.username} · {session?.role}</b><small>账户设置</small></div>
        {onClose ? <button className="wx-x" onClick={onClose} aria-label="关闭账户设置">×</button> : null}</div>
      <form className="account-form" onSubmit={submitPassword}>
        <label>当前口令<input aria-label="当前口令" type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoComplete="current-password" required /></label>
        <label>新口令<input aria-label="新口令" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" required /></label>
        <button className="wx-btn" type="submit">更新口令</button>
      </form>
      {passwordMessage ? <p className="account-ok" role="status">{passwordMessage}</p> : null}
      <ErrorMessage>{error}</ErrorMessage>
      {owner ? <div className="user-manager"><button type="button" className="wx-btn ghost" onClick={() => setManagerOpen(v => !v)} aria-expanded={managerOpen}>用户管理</button>
        {managerOpen ? <>
        <form className="account-form" onSubmit={submitUser}>
          <label>新用户名<input aria-label="新用户名" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" required /></label>
          <label>初始口令<input aria-label="初始口令" type="password" value={initialPassword} onChange={e => setInitialPassword(e.target.value)} autoComplete="new-password" required /></label>
          <label>角色<select value={role} onChange={e => setRole(e.target.value)}><option>Member</option><option>Owner</option></select></label>
          <button className="wx-btn" type="submit">创建用户</button>
        </form>
        <div className="user-list" aria-label="用户列表">{users.map(user => <UserRow key={user.id} user={user} onPatch={patchUser} />)}</div>
        </> : null}
      </div> : null}
    </section>
  )
}

function UserRow({ user, onPatch }) {
  const [password, setPassword] = useState('')
  return <div className="user-row"><span className="user-name" title={user.username}>{user.username}</span>
    <select aria-label={`${user.username} 角色`} value={user.role} onChange={e => onPatch(user.id, { role: e.target.value })}><option>Member</option><option>Owner</option></select>
    <button type="button" onClick={() => onPatch(user.id, { active: !Boolean(user.active) })}>{user.active ? '停用' : '启用'}</button>
    <label className="sr-only">重置 {user.username} 口令</label><input aria-label={`重置 ${user.username} 口令`} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
    <button type="button" disabled={!password} onClick={async () => { if (await onPatch(user.id, { password })) setPassword('') }}>重置口令</button>
  </div>
}
