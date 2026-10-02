import { lazy, Suspense, useEffect, useState } from 'react'
import { getSession } from './api.js'
import Hud from './Hud.jsx'
import Login from './Login.jsx'
import { PresenceBloom } from './Presence.jsx'
import { useRoute } from './routes.js'

// 顶层页面按需加载，不进主应用首屏包（路由规则见 routes.js）
const Market = lazy(() => import('./market/Market.jsx'))
const PlatformEntry = lazy(() => import('./platform/PlatformEntry.jsx'))
const Flows = lazy(() => import('./flows/Flows.jsx'))

export default function App() {
  const [session, setSession] = useState(null) // null=检查中或未登录
  const [notice, setNotice] = useState('')
  const [handoff, setHandoff] = useState(null) // 登录成功的光晕交接：主界面在这层光后面出现
  const route = useRoute()
  useEffect(() => {
    getSession().then(s => setSession(s.authed ? s : false)).catch(() => setSession(false))
  }, [])
  const unauthenticate = reason => {
    setNotice(reason === 'password-changed' ? '口令已更新，请重新登录。' : '')
    setSession(false)
  }
  // 市场与平台入口未登录也能看：session 为 null=检查中、false=游客、对象=已登录，由页面自己决定怎么用
  if (route.name === 'market') {
    return <Suspense fallback={null}><Market session={session} onAuthed={setSession} /></Suspense>
  }
  if (route.name === 'platform') {
    return <Suspense fallback={null}><PlatformEntry slug={route.params.slug} session={session} onAuthed={setSession} /></Suspense>
  }
  if (session === null) return null
  if (route.name === 'flows' && session) {
    return <Suspense fallback={null}><Flows session={session} onExpired={() => unauthenticate()} /></Suspense>
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
