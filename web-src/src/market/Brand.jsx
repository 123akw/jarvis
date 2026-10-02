import { ICONS, NAME_MAX, TAGLINE_MAX, greetingFor } from './model.js'

const DEFAULT_CHIPS = ['今天有什么安排？', '帮我记一下', '明天天气怎么样？']

/** 快捷问题：职业主页给的优先，否则从已选插件的示例里取 */
export function chipsFor(profession, plugins) {
  if (profession?.home?.chips?.length) return profession.home.chips.slice(0, 3)
  const fromPlugins = plugins.flatMap(p => p.examples.slice(0, 1)).slice(0, 3)
  return fromPlugins.length ? fromPlugins : DEFAULT_CHIPS
}

/** 「手机里的样子」：智能体名字 + 问候 + 快捷问题 + 主题色光晕，随表单实时变化 */
export function PhonePreview({ brand, profession, plugins }) {
  const name = brand.name.trim() || '我的智能体'
  const chips = chipsFor(profession, plugins)
  return (
    <figure className="jvm-phone" style={{ '--pa': brand.accent }} aria-label={`预览：${name}在手机里的样子`}>
      <div className="jvm-phone-screen">
        <div className="jvm-phone-glow" aria-hidden="true" />
        <div className="jvm-phone-status" aria-hidden="true"><span>9:41</span><span className="jvm-phone-island" /><span>●●●</span></div>
        <div className="jvm-phone-head">
          <span className="jvm-app-icon" aria-hidden="true">{brand.icon}</span>
          <div>
            <div className="jvm-phone-name">{name}</div>
            <div className="jvm-phone-by">由贾维斯驱动</div>
          </div>
        </div>
        <p className="jvm-phone-greet">{greetingFor(name, profession)}</p>
        {brand.tagline.trim() ? <p className="jvm-phone-tag">{brand.tagline.trim()}</p> : null}
        <ul className="jvm-phone-chips">{chips.map(c => <li key={c}>{c}</li>)}</ul>
        {plugins.length ? (
          <div className="jvm-phone-dock">
            <span>{plugins.length} 个插件</span>
            <span className="jvm-phone-dock-icons" aria-hidden="true">{plugins.slice(0, 6).map(p => <i key={p.id}>{p.icon}</i>)}</span>
          </div>
        ) : null}
        <div className="jvm-phone-input" aria-hidden="true"><span>问问{name}…</span><i /></div>
      </div>
    </figure>
  )
}

/** 给智能体起名：名字、图标、主题色、一句话介绍 */
export default function Brand({ brand, accents, onBrand, profession, plugins }) {
  const set = patch => onBrand({ ...brand, ...patch })
  return (
    <section className="jvm-step jvm-brand" aria-labelledby="jvm-step-title">
      <header className="jvm-step-head">
        <p className="jvm-eyebrow">第 2 步</p>
        <h1 id="jvm-step-title" className="jvm-step-title" tabIndex={-1}>给你的智能体起个名字</h1>
        <p className="jvm-step-sub">名字、图标和颜色会出现在登录后的主页上，以后随时能改。</p>
      </header>
      <div className="jvm-brand-grid">
        <div className="jvm-brand-preview"><PhonePreview brand={brand} profession={profession} plugins={plugins} /></div>
        <div className="jvm-form">
          <label className="jvm-field">
            <span className="jvm-field-label">名字<em aria-hidden="true">{brand.name.length}/{NAME_MAX}</em></span>
            <input value={brand.name} maxLength={NAME_MAX} placeholder="比如：奶茶店小管家" autoComplete="off"
              onChange={e => set({ name: e.target.value })} />
          </label>
          <label className="jvm-field">
            <span className="jvm-field-label">一句话介绍<em aria-hidden="true">{brand.tagline.length}/{TAGLINE_MAX}</em></span>
            <input value={brand.tagline} maxLength={TAGLINE_MAX} placeholder="比如：记订单、排班、写上新文案" autoComplete="off"
              onChange={e => set({ tagline: e.target.value })} />
          </label>
          <fieldset className="jvm-field">
            <legend className="jvm-field-label">图标</legend>
            <div className="jvm-icons">
              {ICONS.map(icon => (
                <label key={icon} className={`jvm-icon-opt${brand.icon === icon ? ' is-on' : ''}`}>
                  <input type="radio" name="jvm-icon" className="sr-only" value={icon} checked={brand.icon === icon}
                    onChange={() => set({ icon })} aria-label={`图标 ${icon}`} />
                  <span aria-hidden="true">{icon}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="jvm-field">
            <legend className="jvm-field-label">主题色</legend>
            <div className="jvm-accents">
              {accents.map(a => (
                <label key={a.hex} className={`jvm-accent-opt${brand.accent.toLowerCase() === a.hex.toLowerCase() ? ' is-on' : ''}`}
                  style={{ '--sw': a.hex }}>
                  <input type="radio" name="jvm-accent" className="sr-only" value={a.hex}
                    checked={brand.accent.toLowerCase() === a.hex.toLowerCase()}
                    onChange={() => set({ accent: a.hex })} aria-label={`主题色 ${a.name || a.hex}`} />
                  <span className="jvm-swatch" aria-hidden="true" />
                  {a.name ? <span className="jvm-accent-name" aria-hidden="true">{a.name}</span> : null}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </div>
    </section>
  )
}
