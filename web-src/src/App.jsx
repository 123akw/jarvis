import { useEffect, useState } from 'react'
import { getSession } from './api.js'
import Hud from './Hud.jsx'
import Login from './Login.jsx'

export default function App() {
  const [authed, setAuthed] = useState(null) // null=检查中
  useEffect(() => {
    getSession().then(s => setAuthed(s.authed)).catch(() => setAuthed(false))
  }, [])
  if (authed === null) return null
  return authed
    ? <Hud onLogout={() => setAuthed(false)} />
    : <Login onAuthed={() => setAuthed(true)} />
}
