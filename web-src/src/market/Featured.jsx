import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { prefersReducedMotion } from '../Presence.jsx'

/* 「精选套装」：按职业预设好的一整套插件（含推荐流程用到的积木），一键整套加入工具箱。
 * 手机上横向滑动（吸附），宽屏三列大卡。每张卡的底色取一个固定的柔和色，不随主题跳。 */

const TINTS = ['#FF9F0A', '#5E5CE6', '#30B0C7', '#34C759', '#FF375F', '#0A84FF']

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

export default function Featured({ bundles, picked, onAdd, onOpen }) {
  const shelf = useRef(null)
  const [edge, page] = useShelf(shelf, bundles.length)
  if (!bundles.length) return null
  const pickedSet = new Set(picked)
  return (
    <section className="jvm-featured" aria-labelledby="jvm-featured-title">
      <header className="jvm-section-head">
        <h2 id="jvm-featured-title" className="jvm-section-title">精选套装</h2>
        <p className="jvm-section-sub">按行当配好的一整套，一键放进工具箱，之后还能增减。</p>
        <div className="jvm-shelf-nav">
          <button type="button" className="is-prev" onClick={() => page(-1)} disabled={edge.start} aria-label="上一组套装"><Icon name="chevron" size={16} /></button>
          <button type="button" onClick={() => page(1)} disabled={edge.end} aria-label="下一组套装"><Icon name="chevron" size={16} /></button>
        </div>
      </header>
      <ul className="jvm-bundles" ref={shelf}>
        {bundles.map((b, i) => {
          const left = b.ids.filter(id => !pickedSet.has(id)).length
          const all = !left
          const flows = b.flows.length
          return (
            <li key={b.id} className={`jvm-bundle${all ? ' is-in' : ''}`} style={{ '--tint': TINTS[i % TINTS.length] }}>
              <article aria-labelledby={`jvm-b-${b.id}`}>
                <div className="jvm-bundle-top">
                  <span className="jvm-bundle-icon" aria-hidden="true">{b.icon}</span>
                  <div className="jvm-bundle-titles">
                    <h3 id={`jvm-b-${b.id}`}>{b.title}</h3>
                    <p className="jvm-bundle-who">{b.who}</p>
                  </div>
                </div>
                {b.summary ? <p className="jvm-bundle-sum">{b.summary}</p> : null}
                <ul className="jvm-bundle-items" aria-label={`${b.title}包含`}>
                  {b.plugins.slice(0, 5).map(p => (
                    <li key={p.id}>
                      <button type="button" className="jvm-bundle-item" onClick={() => onOpen(p.id)} title={p.name}
                        aria-label={`查看插件：${p.name}`}>
                        <span aria-hidden="true">{p.icon}</span>
                      </button>
                    </li>
                  ))}
                  {b.plugins.length > 5 ? <li className="jvm-bundle-more" aria-label={`还有 ${b.plugins.length - 5} 个`}>+{b.plugins.length - 5}</li> : null}
                </ul>
                <div className="jvm-bundle-foot">
                  <span className="jvm-bundle-meta">{b.ids.length} 个插件{flows ? ` · ${flows} 条流程` : ''}</span>
                  <button type="button" className={`jvm-bundle-add${all ? ' is-on' : ''}`} disabled={all}
                    onClick={() => onAdd(b)} aria-label={all ? `${b.title}已全部加入` : `整套加入：${b.title}（${left} 个）`}>
                    {all ? <><Icon name="check" size={15} />已全部加入</> : <><Icon name="plus" size={15} />整套加入</>}
                  </button>
                </div>
              </article>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
