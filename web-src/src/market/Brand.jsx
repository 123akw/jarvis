import { ICONS, NAME_MAX, TAGLINE_MAX, greetingFor } from './model.js'
import './flow-pages.css'

/* 第 2 步：给智能体起名（第十七轮「少即是多」）。
 * 名字是主角：一个大输入框，左边的应用图标随图标 / 主题色实时变化；图标与主题色各是一行可横滑的小选择器；
 * 一句话介绍可选；右侧（手机上在下面）是一台小巧的手机预览。说明文字只留一句。 */

const DEFAULT_CHIPS = ['今天有什么安排？', '帮我记一下', '明天天气怎么样？']

/** 快捷问题：职业主页给的优先，否则从已选插件的示例里取 */
export function chipsFor(profession, plugins) {
  if (profession?.home?.chips?.length) return profession.home.chips.slice(0, 3)
  const fromPlugins = plugins.flatMap(p => p.examples.slice(0, 1)).slice(0, 3)
  return fromPlugins.length ? fromPlugins : DEFAULT_CHIPS
}

/** 「手机里的样子」：状态栏、应用头、问候、快捷问题、插件、输入框，随表单实时变化 */
export function PhonePreview({ brand, profession, plugins }) {
  const name = brand.name.trim() || '我的智能体'
  const chips = chipsFor(profession, plugins)
  return (
    <figure className="jvm-ph" style={{ '--pa': brand.accent }} aria-label={`预览：${name}在手机里的样子`}>
      <div className="jvm-ph-screen">
        <div className="jvm-ph-glow" aria-hidden="true" />
        <div className="jvm-ph-status" aria-hidden="true">
          <span>9:41</span><span className="jvm-ph-island" /><span className="jvm-ph-sig"><i /><i /><i /><i /></span>
        </div>
        <div className="jvm-ph-head">
          <span className="jvm-ph-app" aria-hidden="true">{brand.icon}</span>
          <div className="jvm-ph-titles">
            <div className="jvm-ph-name">{name}</div>
            <div className="jvm-ph-by">由贾维斯驱动</div>
          </div>
        </div>
        <p className="jvm-ph-greet">{greetingFor(name, profession)}</p>
        {brand.tagline.trim() ? <p className="jvm-ph-tag">{brand.tagline.trim()}</p> : null}
        <ul className="jvm-ph-chips">{chips.map(c => <li key={c}>{c}</li>)}</ul>
        <div className="jvm-ph-foot">
          {plugins.length ? (
            <div className="jvm-ph-dock">
              <span className="jvm-ph-dock-icons" aria-hidden="true">{plugins.slice(0, 5).map(p => <i key={p.id}>{p.icon}</i>)}</span>
              <span>{plugins.length} 个插件</span>
            </div>
          ) : null}
          <div className="jvm-ph-input" aria-hidden="true"><span>问问{name}…</span><i /></div>
        </div>
      </div>
    </figure>
  )
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/** 给智能体起名：名字、图标、主题色、一句话介绍（可选） */
export default function Brand({ brand, accents, onBrand, profession, plugins }) {
  const set = patch => onBrand({ ...brand, ...patch })
  const accentName = accents.find(a => same(a.hex, brand.accent))?.name || ''
  return (
    <section className="jvm-step jvm-bp" aria-labelledby="jvm-step-title" style={{ '--pa': brand.accent }}>
      <header className="jvm-bp-head">
        <p className="jvm-bp-eyebrow">第 2 步</p>
        <h1 id="jvm-step-title" className="jvm-bp-title" tabIndex={-1}>给你的智能体起个名字</h1>
        <p className="jvm-bp-sub">以后随时能改。</p>
      </header>
      <div className="jvm-bp-grid">
        <div className="jvm-bp-form">
          <div className="jvm-bp-name">
            <span className="jvm-bp-tile" aria-hidden="true">{brand.icon}</span>
            <div className="jvm-bp-name-field">
              <label htmlFor="jvm-bp-name-input" className="jvm-bp-label">名字</label>
              <input id="jvm-bp-name-input" value={brand.name} maxLength={NAME_MAX} placeholder="比如：奶茶店小管家" autoComplete="off"
                enterKeyHint="done" onChange={e => set({ name: e.target.value })} />
            </div>
            <span className="jvm-bp-count" aria-hidden="true">{brand.name.length}/{NAME_MAX}</span>
          </div>

          <div className="jvm-bp-looks">
            <fieldset className="jvm-bp-row">
              <legend className="jvm-bp-label">图标</legend>
              <div className="jvm-bp-scroller">
                {ICONS.map(icon => (
                  <label key={icon} className={`jvm-bp-icon${brand.icon === icon ? ' is-on' : ''}`}>
                    <input type="radio" name="jvm-icon" value={icon} checked={brand.icon === icon}
                      onChange={() => set({ icon })} aria-label={`图标 ${icon}`} />
                    <span aria-hidden="true">{icon}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="jvm-bp-row">
              <legend className="jvm-bp-label">主题色{accentName ? <span aria-hidden="true"> · {accentName}</span> : null}</legend>
              <div className="jvm-bp-scroller is-swatches">
                {accents.map(a => (
                  <label key={a.hex} className={`jvm-bp-swatch${same(a.hex, brand.accent) ? ' is-on' : ''}`} style={{ '--sw': a.hex }}
                    title={a.name || a.hex}>
                    <input type="radio" name="jvm-accent" value={a.hex} checked={same(a.hex, brand.accent)}
                      onChange={() => set({ accent: a.hex })} aria-label={`主题色 ${a.name || a.hex}`} />
                    <span aria-hidden="true" />
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="jvm-bp-tagline">
            <label htmlFor="jvm-bp-tagline-input" className="jvm-bp-label">
              一句话介绍<span className="jvm-bp-opt">可选</span>
            </label>
            <input id="jvm-bp-tagline-input" value={brand.tagline} maxLength={TAGLINE_MAX} placeholder="比如：记订单、排班、写上新文案"
              autoComplete="off" enterKeyHint="done" onChange={e => set({ tagline: e.target.value })} />
          </div>
        </div>
        <div className="jvm-bp-preview"><PhonePreview brand={brand} profession={profession} plugins={plugins} /></div>
      </div>
    </section>
  )
}
