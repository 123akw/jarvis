import { ICONS, NAME_MAX, TAGLINE_MAX, greetingFor } from './model.js'
import './flow-pages.css'

/* 第 2 步：给智能体起名（第十七轮「少即是多」，对齐 docs/design/2026-10-market-references.md §5）：
 * 标题一句（顶栏已有步骤条，不再写「第 2 步」）；名字输入框 48 高、进页自动聚焦，左侧小图标随图标 / 主题色实时变化；
 * 图标 8×2 网格、主题色一排色块（色名只在 title / aria-label）；一句话介绍可选；字数到上限 80% 才显示计数。
 * 右侧（手机上在下面）是一台小巧的手机预览；生成按钮只在底部 Dock 里，是全页唯一的主按钮。 */

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
/** 字数到上限 80% 才显示计数（16/20、32/40） */
const countOf = (v, max) => (v.length >= Math.ceil(max * 0.8) ? `${v.length}/${max}` : '')

/** 给智能体起名：名字、图标、主题色、一句话介绍（可选）。生成按钮只在底部 Dock 里 */
export default function Brand({ brand, accents, onBrand, profession, plugins }) {
  const set = patch => onBrand({ ...brand, ...patch })
  const nameCount = countOf(brand.name, NAME_MAX)
  const tagCount = countOf(brand.tagline, TAGLINE_MAX)
  return (
    <section className="jvm-step jvm-bp" aria-labelledby="jvm-bp-title" style={{ '--pa': brand.accent }}>
      <header className="jvm-bp-head">
        <h1 id="jvm-bp-title" className="jvm-bp-title" tabIndex={-1}>给你的智能体起个名字</h1>
      </header>
      <div className="jvm-bp-grid">
        <div className="jvm-bp-form">
          <div className="jvm-bp-field">
            <div className="jvm-bp-label-row">
              <label htmlFor="jvm-step-title" className="jvm-bp-label">名字</label>
              {nameCount ? <span className="jvm-bp-count">{nameCount}</span> : null}
            </div>
            <div className="jvm-bp-name">
              <span className="jvm-bp-tile" aria-hidden="true">{brand.icon}</span>
              {/* id 沿用 Market 的约定：换到这一步时 Market 把焦点放到 #jvm-step-title——这里就是名字输入框（进页自动聚焦） */}
              <input id="jvm-step-title" value={brand.name} maxLength={NAME_MAX} placeholder="比如：奶茶店小管家" autoComplete="off"
                enterKeyHint="done" onChange={e => set({ name: e.target.value })} />
            </div>
          </div>

          <fieldset className="jvm-bp-field">
            <legend className="jvm-bp-label">图标</legend>
            <div className="jvm-bp-icons">
              {ICONS.map(icon => (
                <label key={icon} className={`jvm-bp-icon${brand.icon === icon ? ' is-on' : ''}`}>
                  <input type="radio" name="jvm-icon" value={icon} checked={brand.icon === icon}
                    onChange={() => set({ icon })} aria-label={`图标 ${icon}`} />
                  <span aria-hidden="true">{icon}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="jvm-bp-field">
            <legend className="jvm-bp-label">主题色</legend>
            <div className="jvm-bp-swatches">
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

          <div className="jvm-bp-field">
            <div className="jvm-bp-label-row">
              <label htmlFor="jvm-bp-tagline" className="jvm-bp-label">一句话介绍（可选）</label>
              {tagCount ? <span className="jvm-bp-count">{tagCount}</span> : null}
            </div>
            <input id="jvm-bp-tagline" className="jvm-bp-input" value={brand.tagline} maxLength={TAGLINE_MAX}
              placeholder="比如：记订单、排班、写上新文案" autoComplete="off" enterKeyHint="done" onChange={e => set({ tagline: e.target.value })} />
          </div>
        </div>
        <div className="jvm-bp-preview"><PhonePreview brand={brand} profession={profession} plugins={plugins} /></div>
      </div>
    </section>
  )
}
