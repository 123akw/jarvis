import { useEffect, useState } from 'react'
import { getSession } from './api.js'
import Hud from './Hud.jsx'
import Login from './Login.jsx'
import { PresenceBloom } from './Presence.jsx'

export default function App() {
  const [session, setSession] = useState(null) // null=检查中或未登录
  const [notice, setNotice] = useState('')
  const [handoff, setHandoff] = useState(null) // 登录成功的光晕交接：主界面在这层光后面出现
  useEffect(() => {
    getSession().then(s => setSession(s.authed ? s : false)).catch(() => setSession(false))
  }, [])
  if (session === null) return null
  const unauthenticate = reason => {
    setNotice(reason === 'password-changed' ? '口令已更新，请重新登录。' : '')
    setSession(false)
  }
  return session
    ? (
      <>
        <Hud session={session} onLogout={unauthenticate} />
        {handoff ? <PresenceBloom origin={handoff} onDone={() => setHandoff(null)} /> : null}
      </>
    )
    : (
      <Login notice={notice} onAuthed={(next, meta) => {
        setNotice('')
        setHandoff(meta?.handoff || null)
        setSession(next)
      }} />
    )
}
