import Presence from '../Presence.jsx'

/** 首屏一句话：价值主张 + 两个入口（开始挑插件 / 一句话帮我推荐）。手机上收得很紧，让插件尽早露出来；
 *  宽屏右侧是光球外绕一圈插件小图标，暗示「拼装」 */
export default function Hero({ catalog, onBrowse, onAsk, wide = false, asking }) {
  const icons = catalog?.plugins?.length
    ? [...new Set(catalog.plugins.filter(p => p.kind !== 'step').map(p => p.icon))].slice(0, 8)
    : ['📅', '✅', '📝', '🌤️', '🔎', '💬', '✨', '🔗']
  const count = catalog?.plugins?.length || 0
  return (
    <section className="jvm-hero" aria-labelledby="jvm-hero-title">
      <div className="jvm-hero-copy">
        <p className="jvm-eyebrow">智能体市场{count ? <span> · {count} 个插件</span> : null}</p>
        <h1 id="jvm-hero-title" className="jvm-hero-title" tabIndex={-1}>
          挑几个插件，<br className="jvm-br" />拼出你自己的 AI 智能体
        </h1>
        <p className="jvm-hero-sub">放进工具箱、起个名字，就拿到一套专属账号——登录即用，只按你选的插件干活。</p>
        <div className="jvm-hero-actions">
          <button type="button" className="jvm-btn jvm-btn--hero" onClick={onBrowse}>开始挑插件</button>
          <button type="button" className="jvm-btn jvm-btn--soft" onClick={onAsk}
            aria-expanded={asking} aria-controls={asking === undefined ? undefined : 'jvm-helper'}>
            <span className="jvm-ai-dot" aria-hidden="true" />一句话帮我推荐
          </button>
        </div>
      </div>
      {wide ? (
        <div className="jvm-hero-stage" aria-hidden="true">
          <div className="jvm-orbit">
            {icons.map((icon, i) => (
              <span key={`${icon}-${i}`} className="jvm-orbit-tile" style={{ '--i': i, '--n': icons.length }}>
                <span>{icon}</span>
              </span>
            ))}
          </div>
          <Presence size={104} state="idle" decorative />
        </div>
      ) : null}
    </section>
  )
}
