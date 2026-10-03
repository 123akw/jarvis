import { lazy, Suspense, useCallback, useEffect, useRef } from 'react'
import { flowHref, navigate, useRoute } from '../routes.js'
import { applyTheme, currentTheme } from '../theme.js'
import { blankDraft, clearDraft, readDraft } from './flowkit.js'
import Home from './Home.jsx'
import './flows.css'

/* 流程页外壳（第十八轮，契约 docs/proposals/2026-10-round18-flows.md §5.2）：
 *   /flows        「我的流程」首页（Home.jsx）；
 *   /flows/<id>   画布编辑器（canvas/Editor.jsx，懒加载：@xyflow/react 只在这里进来）。
 * 草稿交接：首页把草稿写进 sessionStorage['jvf-draft'] 再去 /flows/new，这里读出来当 initial 传给画布并清掉；
 * 新建的流程第一次保存后把地址原地换成 /flows/<新 id>，画布不重新挂载（撤销记录、选中状态都还在）。 */

const Editor = lazy(() => import('./canvas/Editor.jsx'))

function EditorLoading() {
  return <div className="fh-editor-loading" role="status"><span className="fh-spark" aria-hidden="true" />正在打开画布…</div>
}

export default function Flows({ session, onExpired }) {
  const route = useRoute()
  const id = route.params?.id || ''

  // 流程页不挂 Hud，主题自己套；读不到存储（隐私模式）按暗色
  useEffect(() => {
    let theme = 'dark'
    try { theme = currentTheme() } catch { /* 存储不可用 */ }
    applyTheme(theme)
  }, [])

  // App 每次渲染都给新的 onExpired：放进 ref，传给子组件的是稳定的函数
  const expiredRef = useRef(onExpired)
  expiredRef.current = onExpired
  const expired = useCallback(() => expiredRef.current?.(), [])

  /* 画布实例的 key：换了流程就重新挂载；「新建 → 保存后换成真 id」沿用同一个实例。
   * slot 在渲染里按 id 推进（同一个 id 重复渲染是幂等的）。 */
  const slot = useRef({ id: '', key: 0, adopt: '', initial: undefined })
  const s = slot.current
  if (id && s.id !== id) {
    if (!(s.adopt && s.adopt === id)) {
      s.key += 1
      s.initial = id === 'new' ? (readDraft() || blankDraft()) : undefined
    }
    s.adopt = ''
    s.id = id
  } else if (!id && s.id) {
    s.id = ''
    s.adopt = ''
  }
  const editorKey = s.key
  useEffect(() => { if (id === 'new') clearDraft() }, [id, editorKey])

  const onSaved = useCallback(flow => {
    if (!flow?.id) return
    if (slot.current.id === 'new') {
      slot.current.adopt = String(flow.id)
      navigate(flowHref(flow.id), { replace: true })
    }
  }, [])
  const onBack = useCallback(() => navigate(flowHref()), [])

  if (!id) return <Home onExpired={expired} />
  return (
    <Suspense fallback={<EditorLoading />}>
      <Editor key={editorKey} flowId={id} initial={s.initial} session={session}
        onSaved={onSaved} onBack={onBack} onExpired={expired} />
    </Suspense>
  )
}
