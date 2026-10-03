import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { endTour, getActive, subscribe } from './controller.js'
import { holeFor, needsScroll, placeCard, radiusOf } from './geometry.js'
import { tourSteps } from './tours.js'
import './tour.css'

/* 引导层（挂在 main.jsx，整站一份）：聚光灯 + 气泡卡。
 *  - 压暗层挡住页面点击；高亮框用超大 box-shadow 把四周压暗、自己挖空，外圈一道柔和描边；
 *  - 目标不在视野里先平滑滚过去；窗口缩放 / 任意容器滚动都重新定位；
 *  - 目标暂时不存在等最多 1.5 秒，仍没有就跳过这一步；一开始所有目标都找不到就不弹（也不记录）；
 *  - Esc = 跳过，← → 翻页，Tab 只在卡片里转；结束后焦点还给打开前的控件；
 *  - 手机（<640px）气泡是底部卡片；prefers-reduced-motion 时不做位移动画（CSS 里处理）。 */

export const WAIT_MS = 1500
const POLL_MS = 100
const RECHECK_MS = 300

const isJsdom = () => {
  try { return /jsdom/i.test(navigator.userAgent || '') } catch { return false }
}

function visible(el) {
  if (!el?.isConnected || el.closest('[hidden],[inert]')) return false
  if (typeof el.getClientRects !== 'function') return true
  return el.getClientRects().length > 0 || isJsdom()   // jsdom 不做布局：只看是否在文档里、没被隐藏
}

/** 页面上第一个可见的 data-tour="<name>" */
export function findTarget(name) {
  if (!name || typeof document === 'undefined') return null
  const sel = `[data-tour="${String(name).replace(/["\\]/g, '\\$&')}"]`
  for (const el of document.querySelectorAll(sel)) if (visible(el)) return el
  return null
}

const reducedMotion = () => {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true } catch { return false }
}

function bring(el) {
  try {
    const r = el.getBoundingClientRect()
    if (!needsScroll(r, window.innerHeight)) return
    el.scrollIntoView?.({ block: r.height >= window.innerHeight - 32 ? 'start' : 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
  } catch { /* 滚不动就原地高亮 */ }
}

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])'

function sameGeo(a, b) {
  if (!a || !b) return a === b
  const h1 = a.hole; const h2 = b.hole
  const holeSame = (!h1 && !h2) || (h1 && h2 && ['top', 'left', 'width', 'height', 'radius'].every(k => Math.abs(h1[k] - h2[k]) < 0.5))
  return holeSame && a.card.mode === b.card.mode && a.card.side === b.card.side
    && Math.abs(a.card.top - b.card.top) < 0.5 && Math.abs(a.card.left - b.card.left) < 0.5
}

function TourRunner({ run }) {
  const steps = tourSteps(run.id)
  const [index, setIndex] = useState(-1)          // -1：刚开始，还在找第一个目标（这时什么都不画）
  const [phase, setPhase] = useState('seek')      // 'seek' 找目标中 | 'show'
  const [target, setTarget] = useState(null)
  const [geo, setGeo] = useState(null)
  const [nonce, setNonce] = useState(0)           // 目标在展示中途丢了：重新找
  const skipped = useRef(new Set())
  const dir = useRef(1)
  const shown = useRef(false)
  const cardRef = useRef(null)
  const primaryRef = useRef(null)
  const ids = useId()
  const step = index >= 0 ? steps[index] : null

  const finish = useCallback(status => endTour(status, run.key), [run.key])

  // 打开前的焦点：结束后还回去
  useEffect(() => {
    const back = document.activeElement
    return () => {
      if (back && back !== document.body && back.isConnected && typeof back.focus === 'function') {
        try { back.focus({ preventScroll: true }) } catch { /* 焦点还不回去也不影响 */ }
      }
    }
  }, [])

  /** 从 from 往 d 方向找下一个没被跳过的步骤；越界返回 -1 / steps.length */
  const nextFrom = useCallback((from, d) => {
    let i = from + d
    while (i >= 0 && i < steps.length && skipped.current.has(i)) i += d
    return i
  }, [steps.length])

  const goto = useCallback((from, d) => {
    dir.current = d
    let i = nextFrom(from, d)
    if (i < 0) { dir.current = 1; i = nextFrom(-1, 1) }       // 往回没有了：停在最前面能看的一步
    if (i >= steps.length) { if (shown.current) finish('done'); else finish('closed'); return }
    if (i === from) { setNonce(n => n + 1); return }
    setIndex(i)
  }, [finish, nextFrom, steps.length])

  // 开头：同时找所有步骤的目标，最多 1.5 秒；第一步在就从第一步开始，否则从第一个找得到的开始；一个都没有就不弹
  useEffect(() => {
    if (index !== -1) return undefined
    const t0 = Date.now()
    let timer = 0
    const tick = () => {
      const found = steps.map(s => !s.target || Boolean(findTarget(s.target)))
      if (found[0]) { setIndex(0); return }
      if (Date.now() - t0 >= WAIT_MS) {
        const first = found.indexOf(true)
        if (first < 0) { finish('closed'); return }
        for (let i = 0; i < first; i++) skipped.current.add(i)
        setIndex(first)
        return
      }
      timer = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => clearTimeout(timer)
  }, [index, steps, finish])

  // 每一步：找目标（最多等 1.5 秒）→ 滚进视野 → 展示；仍找不到就按刚才翻页的方向跳过
  // （布局阶段做：换步时新目标在绘制前就位，不会先在旧位置闪一下新文案）
  useLayoutEffect(() => {
    if (index < 0) return undefined
    const s = steps[index]
    if (!s.target) { setTarget(null); setPhase('show'); shown.current = true; return undefined }
    const t0 = Date.now()
    let timer = 0
    const tick = () => {
      const el = findTarget(s.target)
      if (el) {
        bring(el)
        setTarget(el)
        setPhase('show')
        shown.current = true
        return
      }
      setPhase('seek')
      if (Date.now() - t0 >= WAIT_MS) {
        skipped.current.add(index)
        goto(index, dir.current)
        return
      }
      timer = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => clearTimeout(timer)
  }, [index, nonce, steps, goto])

  // 定位：步骤 / 目标变化、窗口缩放、任意容器滚动、目标或卡片尺寸变化都重新量；另每 300ms 兜底量一次（布局动画）
  const measure = useCallback(() => {
    if (phase !== 'show' || !step) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    let hole = null
    if (step.target) {
      if (!target?.isConnected) {
        const again = findTarget(step.target)
        if (again) setTarget(again)
        else setNonce(n => n + 1)
        return
      }
      hole = holeFor(target.getBoundingClientRect(), vw, vh, radiusOf(target))
    }
    const card = cardRef.current
    const next = {
      hole,
      card: placeCard(hole, { w: card?.offsetWidth || 340, h: card?.offsetHeight || 180 }, { vw, vh }, step.placement),
    }
    setGeo(prev => (sameGeo(prev, next) ? prev : next))
  }, [phase, step, target])

  useLayoutEffect(() => { measure() }, [measure])

  useEffect(() => {
    if (phase !== 'show') return undefined
    let raf = 0
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; measure() })
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const timer = setInterval(measure, RECHECK_MS)
    let ro = null
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(schedule)
      if (target) ro.observe(target)
      if (cardRef.current) ro.observe(cardRef.current)
    }
    return () => {
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      clearInterval(timer)
      ro?.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [phase, measure, target])

  // 每一步展示时把焦点放到主按钮上（卡片里的说明由 aria-live 读出）
  useEffect(() => {
    if (phase === 'show' && index >= 0) {
      try { primaryRef.current?.focus({ preventScroll: true }) } catch { /* 忽略 */ }
    }
  }, [phase, index])

  const visibleSteps = steps.map((_, i) => i).filter(i => !skipped.current.has(i))
  const pos = visibleSteps.indexOf(index)
  const isFirst = pos <= 0
  const isLast = index >= 0 && nextFrom(index, 1) >= steps.length

  const next = useCallback(() => { if (index >= 0) goto(index, 1) }, [goto, index])
  const prev = useCallback(() => { if (index >= 0 && !isFirst) goto(index, -1) }, [goto, index, isFirst])

  // 键盘：Esc 跳过、← → 翻页、Tab 只在卡片里转（捕获阶段处理，不让页面上的快捷键同时响应）
  useEffect(() => {
    if (index < 0) return undefined
    const onKey = e => {
      if (e.isComposing) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('skipped') }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); if (phase === 'show') next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); if (phase === 'show') prev() }
      else if (e.key === 'Tab') {
        const card = cardRef.current
        if (!card) return
        const items = [...card.querySelectorAll(FOCUSABLE)]
        if (!items.length) return
        const i = items.indexOf(document.activeElement)
        e.preventDefault()
        e.stopPropagation()
        const to = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i < 0 || i >= items.length - 1 ? 0 : i + 1)
        items[to].focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, phase, next, prev, finish])

  if (index < 0 || !step) return null
  const ready = phase === 'show' && geo
  const hole = geo?.hole || null                 // 换步找目标时高亮框留在原处，找到后再滑过去
  const card = ready ? geo.card : null
  const cardStyle = card && card.mode === 'float' ? { top: `${card.top}px`, left: `${card.left}px` } : undefined
  const cardCls = ['jv-tour-card', card ? `is-${card.mode}` : 'is-float', card ? `side-${card.side}` : '', ready ? 'is-on' : ''].filter(Boolean).join(' ')
  const ringStyle = hole ? {
    top: `${hole.top}px`, left: `${hole.left}px`, width: `${hole.width}px`, height: `${hole.height}px`, borderRadius: `${hole.radius}px`,
  } : undefined

  return (
    <div className="jv-tour" data-tour-id={run.id} data-tour-step={index}>
      {/* 挡住页面点击；没有目标（居中说明卡）或正在找目标时整片压暗 */}
      <div className={`jv-tour-block${hole ? '' : ' is-dim'}`} aria-hidden="true" />
      {hole ? <div className="jv-tour-ring" style={ringStyle} aria-hidden="true" /> : null}
      <div ref={cardRef} className={cardCls} style={cardStyle} role="dialog" aria-modal="true"
        aria-labelledby={`${ids}-t`} aria-describedby={`${ids}-b`} data-step={index}>
        <div className="jv-tour-head">
          <span className="jv-tour-dots" aria-hidden="true">
            {visibleSteps.map(i => <i key={i} className={i === index ? 'on' : ''} />)}
          </span>
          <span className="jv-tour-count mono" aria-hidden="true">{pos + 1} / {visibleSteps.length}</span>
        </div>
        <div aria-live="polite">
          <span className="sr-only">第 {pos + 1} 步，共 {visibleSteps.length} 步：</span>
          <h2 id={`${ids}-t`} className="jv-tour-title">{step.title}</h2>
          <p id={`${ids}-b`} className="jv-tour-body">{step.body}</p>
        </div>
        <div className="jv-tour-actions">
          {!isLast ? <button type="button" className="jv-tour-skip" onClick={() => finish('skipped')}>跳过</button> : <span />}
          <span className="jv-tour-nav">
            {!isFirst ? <button type="button" className="jv-tour-btn-ghost" onClick={prev}>上一步</button> : null}
            <button ref={primaryRef} type="button" className="jv-tour-btn-primary" onClick={next}>
              {isLast ? '完成' : '下一步'}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

/** 整站一份的引导层：有引导在播时渲染到 body 末尾 */
export default function TourLayer() {
  const run = useSyncExternalStore(subscribe, getActive, getActive)
  if (!run || typeof document === 'undefined') return null
  return createPortal(<TourRunner key={run.key} run={run} />, document.body)
}
