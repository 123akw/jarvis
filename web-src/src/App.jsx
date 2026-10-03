import { lazy, Suspense, useEffect, useState } from 'react'
import { getSession } from './api.js'
import { migrateLegacy, setCurrentAccount } from './accountStorage.js'
import Hud from './Hud.jsx'
import Login from './Login.jsx'
import { clearPrefillParam, readNextParam, readPrefillUser, sameUser } from './loginParam.js'
import { PresenceBloom } from './Presence.jsx'
import { APP_PATH, LOGIN_PATH, loginHref, navigate, pageTitle, useRoute } from './routes.js'

// 顶层页面按需加载，不进主应用首屏包（路由规则见 routes.js）
const Market = lazy(() => import('./market/Market.jsx'))
const PlatformEntry = lazy(() => import('./platform/PlatformEntry.jsx'))
const Flows = lazy(() => import('./flows/Flows.jsx'))
const Approve = lazy(() => import('./consent/ConsentPage.jsx'))   // 第二十一轮：通用的「关键动作同意」页
const Admin = lazy(() => import('./admin/Admin.jsx'))

/** 渲染即跳转（地址栏原地替换，不留历史）：未登录访问 /app、/flows → /login?next=…；已登录打开 /login → next 或 /app */
function Redirect({ to }) {
  useEffect(() => { navigate(to, { replace: true }) }, [to])
  return null
}

/** 登录成功 / 已登录时该去哪：?next= 指的本站页面，否则主应用 */
const afterLogin = () => readNextParam() || APP_PATH

export default function App() {
  const [session, setSession] = useState(null) // null=检查中、false=游客、对象=已登录
  const [notice, setNotice] = useState('')
  const [handoff, setHandoff] = useState(null) // 登录成功的光晕交接：下一页在这层光后面出现
  const route = useRoute()
  useEffect(() => {
    getSession().then(s => {
      if (!s?.authed) {
        migrateLegacy('')   // 没登录：旧版不分账号的本地数据无从判断归属，直接丢掉
        setSession(false)
        return
      }
      migrateLegacy(s.username)   // 旧版不分账号的本地数据是这台设备当前账号写的：迁到它名下
      setSession(s)
    }).catch(() => setSession(false))
  }, [])
  // 市场、登录页、主应用的标题由这里管；流程页、平台入口自己设（pageTitle 返回 ''）
  useEffect(() => {
    const title = pageTitle(route.name)
    if (title) document.title = title
  }, [route.name])
  // 本地按账号区分的存储与内存状态跟着当前账号走（换号即复位，见 accountStorage.js）
  setCurrentAccount(session ? session.username : '')
  // 登出、401、会话过期、改了口令：一律回登录页
  const unauthenticate = reason => {
    setNotice(reason === 'password-changed' ? '口令已更新，请重新登录。' : '')
    setSession(false)
    navigate(LOGIN_PATH, { replace: true })
  }
  const authed = (next, meta) => {
    setNotice('')
    setHandoff(meta?.handoff || null)
    setSession(next)
    navigate(afterLogin(), { replace: true })
  }
  const bloom = handoff ? <PresenceBloom origin={handoff} onDone={() => setHandoff(null)} /> : null

  // 市场与平台入口未登录也能看：session 为 null=检查中、false=游客、对象=已登录，由页面自己决定怎么用
  if (route.name === 'market') {
    return <><Suspense fallback={null}><Market session={session} onAuthed={setSession} /></Suspense>{bloom}</>
  }
  if (route.name === 'platform') {
    return <Suspense fallback={null}><PlatformEntry slug={route.params.slug} session={session} onAuthed={setSession} /></Suspense>
  }
  if (session === null) return null
  if (route.name === 'login') {
    if (!session) return <Login notice={notice} onAuthed={authed} />
    const wanted = readPrefillUser()
    if (wanted && !sameUser(wanted, session.username)) {
      // 扫码 / 链接带来的 ?u= 与这台设备已登录的账号不一致：先让用户确认换号，不再悄悄进旧账号。
      // 「继续使用」去掉 ?u= 去 next 或主应用；新账号登录成功即替换会话（服务端同时作废旧会话）
      return (
        <Login switchFrom={session.username} onAuthed={authed}
          onKeep={() => { clearPrefillParam(); navigate(afterLogin(), { replace: true }) }} />
      )
    }
    return <Redirect to={afterLogin()} />
  }
  // 以下都要登录：/app、/flows、/approve/<id>、/admin
  if (!session) return <Redirect to={loginHref('', window.location.pathname + window.location.search)} />
  if (route.name === 'flows') {
    return <><Suspense fallback={null}><Flows session={session} onExpired={() => unauthenticate()} /></Suspense>{bloom}</>
  }
  if (route.name === 'approve') {
    return <Suspense fallback={null}><Approve id={route.params.id} session={session} onExpired={() => unauthenticate()} /></Suspense>
  }
  if (route.name === 'admin') {   // 仅 Owner；其他账号回主应用
    if (session.role !== 'Owner') return <Redirect to={APP_PATH} />
    return <Suspense fallback={null}><Admin session={session} onExpired={() => unauthenticate()} /></Suspense>
  }
  return <><Hud session={session} onLogout={unauthenticate} />{bloom}</>
}
