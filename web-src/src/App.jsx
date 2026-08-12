import { useEffect, useState } from 'react'
import { getSession } from './api.js'
import Hud from './Hud.jsx'
import Login from './Login.jsx'

export default function App() {
  const [session, setSession] = useState(null) // null=检查中或未登录
  useEffect(() => {
    getSession().then(s => setSession(s.authed ? s : false)).catch(() => setSession(false))
  }, [])
  if (session === null) return null
  return session
    ? <Hud session={session} onLogout={() => setSession(false)} />
    : <Login onAuthed={setSession} />
}
