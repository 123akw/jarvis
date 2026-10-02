import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { prefersReducedMotion } from '../Presence.jsx'
import { flyToDock, useDragSource } from './dnd/index.jsx'

/* 「精选套装」：按职业预设好的一整套插件（含推荐流程用到的积木），一键整套加入，也能整张拖进工具箱。
 * 只占一行货架：桌面一排 3 张、多的横滑（翻页箭头悬停才露）；手机露 1.15 张暗示可滑（scroll-snap）。
 * 卡片只留：图标、标题、一行「适合谁」、叠放的 5 个小图标、一个次按钮「加入 N 个」（元信息并进按钮文案）。
 * 色调只做左上角一团柔光，边框不着色；不同套装取固定的柔和色，不随主题跳。 */

const TINTS = ['#FF9F0A', '#5E5CE6', '#30B0C7', '#34C759', '#FF375F', '#0A84FF']
const STACK = 5

/** 宽屏货架左右翻页：到头 / 到尾时对应按钮置灰 */
function useShelf(ref, count) {
  const [edge, setEdge] = useState({ start: true, end: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const sync = () => setEdge({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 })
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    return () => { el.removeEventListener('scroll', sync); window.removeEventListener('resize', sync) }
  }, [ref, count])
  const page = dir => ref.current?.scrollBy?.({ left: dir * ref.current.clientWidth * 0.9, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  return [edge, page]
}

function BundleCard({ bundle: b, tint, pickedSet, onAdd }) {
  const ref = useRef(null)
  const left = b.ids.filter(id => !pickedSet.has(id)).length
  const all = !left
  const { dragProps, isDragging } = useDragSource({ id: `bundle:${b.id}`, ids: b.ids, kind: 'bundle' })
  const { className: dragClass = '', ref: dragRef, ...drag } = dragProps || {}
  const setRef = useCallback(el => {
    ref.current = el
    if (typeof dragRef === 'function') dragRef(el)
    else if (dragRef && typeof dragRef === 'object') dragRef.current = el
  }, [dragRef])
  return (
    <li className={`jvm-bundle${all ? ' is-in' : ''}`} style={{ '--tint': tint }}>
      <article {...drag} ref={setRef} data-bundle={b.id} aria-labelledby={`jvm-b-${b.id}`}
        className={`${isDragging ? 'is-dragging' : ''} ${dragClass}`.trim() || undefined}>
        <span className="jvm-bundle-icon" aria-hidden="true">{b.icon}</span>
        <div className="jvm-bundle-titles">
          <h3 id={`jvm-b-${b.id}`}>{b.title}</h3>
          <p className="jvm-bundle-who" title={b.summary || undefined}>{b.who}</p>
        </div>
        <div className="jvm-bundle-foot">
          <span className="jvm-bundle-stack" role="img" aria-label={`包含 ${b.ids.length} 个插件：${b.plugins.map(p => p.name).join('、')}`}>
            {b.plugins.slice(0, STACK).map(p => <i key={p.id}>{p.icon}</i>)}
            {b.ids.length > STACK ? <span>+{b.ids.length - STACK}</span> : null}
          </span>
          <button type="button" className={`jvm-bundle-add${all ? ' is-on' : ''}`} disabled={all}
            onPointerDown={e => e.stopPropagation()}
            onClick={() => { flyToDock(ref.current, { icon: b.icon }); onAdd(b) }}
            aria-label={all ? `${b.title}已全部加入` : `整套加入：${b.title}（${left} 个）`}>
            {all ? <><Icon name="check" size={14} />已加入</> : `加入 ${left} 个`}
          </button>
        </div>
      </article>
    </li>
  )
}

export default function Featured({ bundles, picked, onAdd }) {
  const shelf = useRef(null)
  const [edge, page] = useShelf(shelf, bundles.length)
  if (!bundles.length) return null
  const pickedSet = new Set(picked)
  return (
    <section className="jvm-featured" aria-labelledby="jvm-featured-title">
      <header className="jvm-section-head">
        <h2 id="jvm-featured-title" className="jvm-section-title">精选套装</h2>
        <div className="jvm-shelf-nav">
          <button type="button" className="is-prev" onClick={() => page(-1)} disabled={edge.start} aria-label="上一组套装"><Icon name="chevron" size={16} /></button>
          <button type="button" onClick={() => page(1)} disabled={edge.end} aria-label="下一组套装"><Icon name="chevron" size={16} /></button>
        </div>
      </header>
      <ul className="jvm-bundles" ref={shelf}>
        {bundles.map((b, i) => <BundleCard key={b.id} bundle={b} tint={TINTS[i % TINTS.length]} pickedSet={pickedSet} onAdd={onAdd} />)}
      </ul>
    </section>
  )
}
