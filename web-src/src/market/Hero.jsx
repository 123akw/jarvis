import { useEffect, useState } from 'react'
import Presence from '../Presence.jsx'

const ORBIT_FALLBACK = ['📅', '✅', '📝', '🌤️', '🔎', '💬', '✨', '🔗']

const orbSizeFor = () => {
  if (typeof window === 'undefined') return 96
  return window.innerWidth >= 960 ? 132 : Math.round(Math.max(80, Math.min(104, window.innerWidth * 0.24)))
}

/** 市场顶部的一句话：几分钟拼出你自己的 AI 智能体；光球外绕一圈插件小图标，暗示「拼装」 */
export default function Hero({ catalog }) {
  const [orb, setOrb] = useState(orbSizeFor)
  useEffect(() => {
    let t = 0
    const on = () => { clearTimeout(t); t = setTimeout(() => setOrb(orbSizeFor()), 120) }
    window.addEventListener('resize', on)
    return () => { clearTimeout(t); window.removeEventListener('resize', on) }
  }, [])
  const icons = catalog?.plugins?.length
    ? [...new Set(catalog.plugins.filter(p => p.kind !== 'step').map(p => p.icon))].slice(0, 8)
    : ORBIT_FALLBACK

  return (
    <section className="jvm-hero" aria-labelledby="jvm-hero-title">
      <div className="jvm-hero-stage" style={{ '--orb': `${orb}px` }}>
        <div className="jvm-orbit" aria-hidden="true">
          {icons.map((icon, i) => (
            <span key={`${icon}-${i}`} className="jvm-orbit-tile" style={{ '--i': i, '--n': icons.length }}>
              <span>{icon}</span>
            </span>
          ))}
        </div>
        <Presence size={orb} state="idle" decorative />
      </div>
      <div className="jvm-hero-copy">
        <p className="jvm-eyebrow">智能体市场</p>
        <h1 id="jvm-hero-title" className="jvm-hero-title" tabIndex={-1}>
          几分钟，<br />拼出你自己的 AI 智能体
        </h1>
        <p className="jvm-hero-sub">从市场里挑插件放进工具箱，起个名字，就得到一套专属账号和口令——登录后，就是按你的插件组装好的智能体。</p>
        <ol className="jvm-hero-steps" aria-label="三步拿到智能体">
          <li><b>1</b><span>挑插件</span></li>
          <li><b>2</b><span>起名字</span></li>
          <li className="is-end"><b>✓</b><span>拿到账号口令</span></li>
        </ol>
      </div>
    </section>
  )
}
