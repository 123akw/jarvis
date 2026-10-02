import { lazy, Suspense, useEffect, useState } from 'react'
import { getSession } from './api.js'
import { migrateLegacy, setCurrentAccount } from './accountStorage.js'
import Hud from './Hud.jsx'
import Login from './Login.jsx'
import { clearPrefillParam, readPrefillUser, sameUser } from './loginParam.js'
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
  // 扫码 / 链接带来的 ?u= 与这台设备已登录的账号不一致：先让用户确认换号，不再悄悄进旧账号
  const [switchTo, setSwitchTo] = useState('')
  const route = useRoute()
  useEffect(() => {
    getSession().then(s => {
      if (!s?.authed) {
        migrateLegacy('')   // 没登录：旧版不分账号的本地数据无从判断归属，直接丢掉
        setSession(false)
        return
      }
      migrateLegacy(s.username)   // 旧版不分账号的本地数据是这台设备当前账号写的：迁到它名下
      const wanted = readPrefillUser()
      if (wanted && !sameUser(wanted, s.username)) setSwitchTo(wanted)
      else if (wanted) clearPrefillParam()   // 就是当前账号：直接进，顺手清掉 ?u=
      setSession(s)
    }).catch(() => setSession(false))
  }, [])
  // 本地按账号区分的存储与内存状态跟着当前账号走（换号即复位，见 accountStorage.js）
  setCurrentAccount(session ? session.username : '')
  const unauthenticate = reason => {
    setNotice(reason === 'password-changed' ? '口令已更新，请重新登录。' : '')
    setSession(false)
  }
  const authed = (next, meta) => {
    setNotice('')
    setSwitchTo('')
    setHandoff(meta?.handoff || null)
    setSession(next)
  }
  // 市场与平台入口未登录也能看：session 为 null=检查中、false=游客、对象=已登录，由页面自己决定怎么用
  if (route.name === 'market') {
    return <Suspense fallback={null}><Market session={session} onAuthed={setSession} /></Suspense>
  }
  if (route.name === 'platform') {
    return <Suspense fallback={null}><PlatformEntry slug={route.params.slug} session={session} onAuthed={setSession} /></Suspense>
  }
  if (session === null) return null
  if (session && switchTo) {
    // 登录页预填 ?u= 的账号；「继续使用」去掉 ?u= 回到当前账号；新账号登录成功即替换会话（服务端同时作废旧会话）
    return (
      <Login switchFrom={session.username} onAuthed={authed}
        onKeep={() => { clearPrefillParam(); setSwitchTo('') }} />
    )
  }
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
    : <Login notice={notice} onAuthed={authed} />
}
