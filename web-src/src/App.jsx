import { useEffect, useState } from 'react'
import { getSession } from './api.js'
import Hud from './Hud.jsx'
import Login from './Login.jsx'

export default function App() {
  const [session, setSession] = useState(null) // null=检查中或未登录
  const [notice, setNotice] = useState('')
  useEffect(() => {
    getSession().then(s => setSession(s.authed ? s : false)).catch(() => setSession(false))
  }, [])
  if (session === null) return null
  const unauthenticate = reason => {
    setNotice(reason === 'password-changed' ? '口令已更新，请重新登录。' : '')
    setSession(false)
  }
  return session
    ? <Hud session={session} onLogout={unauthenticate} />
    : <Login notice={notice} onAuthed={next => { setNotice(''); setSession(next) }} />
}
