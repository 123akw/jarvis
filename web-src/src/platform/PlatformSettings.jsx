import { useEffect, useState } from 'react'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { navigate } from '../routes.js'
import { normalizeHex, PLATFORM_ACCENTS, PLATFORM_ICONS, pluginMeta, savePlatform } from './platform.js'
import './platform.css'

const NAME_MAX = 20
const TAGLINE_MAX = 40

/**
 * 平台设置：名称、一句话介绍、图标、主题色、插件（可移除，「添加更多」去市场）→ PUT /api/platform。
 * 名称 / 图标 / 主题色改动经 onPreview 实时反映到顶栏与主页；关掉不保存时由调用方撤销预览。
 */
export default function PlatformSettings({ platform, plugins = null, onSaved, onPreview, onClose, onExpired }) {
  const [name, setName] = useState(platform.name || '')
  const [tagline, setTagline] = useState(platform.tagline || '')
  const [icon, setIcon] = useState(platform.icon || PLATFORM_ICONS[0])
  const [accent, setAccent] = useState(normalizeHex(platform.accent))
  const [ids, setIds] = useState(() => [...(platform.plugins || [])])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 表外的旧色值 / 旧图标也留在选项里，不会因为打开设置就被换掉
  const accents = PLATFORM_ACCENTS.some(a => a.hex === normalizeHex(platform.accent))
    ? PLATFORM_ACCENTS : [...PLATFORM_ACCENTS, { name: '当前颜色', hex: normalizeHex(platform.accent) }]
  const icons = PLATFORM_ICONS.includes(platform.icon) || !platform.icon ? PLATFORM_ICONS : [platform.icon, ...PLATFORM_ICONS]

  useEffect(() => {
    onPreview?.({ name: name.trim() || platform.name, icon, accent })
  }, [name, icon, accent]) // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    const n = name.trim()
    if (!n) { setError('给平台起个名字吧'); return }
    setBusy(true)
    setError('')
    try {
      const saved = await savePlatform({ name: n, tagline: tagline.trim(), icon, accent, plugins: ids })
      onSaved?.(saved || { ...platform, name: n, tagline: tagline.trim(), icon, accent, plugins: ids })
      onClose()
    } catch (err) {
      if (err.message === '401') { onExpired?.(); return }
      setError(err.message || '没能保存，请稍后再试')
      setBusy(false)
    }
  }

  return (
    <Modal label="平台设置" onClose={onClose} dismissOnBackdrop={false}>
      <ModalHead title="平台设置" subtitle="改完点保存，扫码打开的人看到的也会一起变" onClose={onClose} />
      <form className="jv-modal-body pf-settings" onSubmit={submit}>
        <div className="pf-preview" aria-hidden="true">
          <span className="pf-tile lg">{icon}</span>
          <span className="pf-preview-text">
            <span className="pf-preview-name">{name.trim() || '平台名称'}</span>
            <span className="pf-preview-tag">{tagline.trim() || '一句话介绍'}</span>
          </span>
        </div>
        <label className="pf-field">
          <span>名称</span>
          <input value={name} maxLength={NAME_MAX} onChange={e => { setName(e.target.value); setError('') }}
            placeholder="比如：小王的项目台" data-autofocus />
          <em className="pf-count">{[...name].length}/{NAME_MAX}</em>
        </label>
        <label className="pf-field">
          <span>一句话介绍</span>
          <input value={tagline} maxLength={TAGLINE_MAX} onChange={e => setTagline(e.target.value)}
            placeholder="比如：项目资料、待办、飞书汇总，一处搞定" />
          <em className="pf-count">{[...tagline].length}/{TAGLINE_MAX}</em>
        </label>

        <fieldset className="pf-fieldset">
          <legend>图标</legend>
          <div className="pf-icons" role="radiogroup" aria-label="平台图标">
            {icons.map(i => (
              <button key={i} type="button" role="radio" aria-checked={icon === i} aria-label={`图标 ${i}`}
                className={`pf-icon-opt${icon === i ? ' on' : ''}`} onClick={() => setIcon(i)}>{i}</button>
            ))}
          </div>
        </fieldset>

        <fieldset className="pf-fieldset">
          <legend>主题色</legend>
          <div className="pf-swatches" role="radiogroup" aria-label="主题色">
            {accents.map(a => (
              <button key={a.hex} type="button" role="radio" aria-checked={accent === a.hex} aria-label={a.name} title={a.name}
                className={`pf-swatch${accent === a.hex ? ' on' : ''}`} style={{ '--sw': a.hex }} onClick={() => setAccent(a.hex)}>
                {accent === a.hex ? <Icon name="check" size={15} /> : null}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="pf-fieldset">
          <legend>插件</legend>
          {ids.length ? (
            <ul className="pf-plugins">
              {ids.map(id => {
                const m = pluginMeta(id, plugins)
                return (
                  <li key={id} className="pf-plugin">
                    <span className="pf-tile sm" aria-hidden="true">{m.icon}</span>
                    <span className="pf-plugin-text">
                      <span className="pf-plugin-name">{m.name}</span>
                      {m.summary ? <span className="pf-plugin-sum">{m.summary}</span> : null}
                    </span>
                    <button type="button" className="pf-remove" aria-label={`移除 ${m.name}`} title="移除"
                      onClick={() => setIds(list => list.filter(x => x !== id))}>
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : <p className="pf-empty">还没有插件，去市场挑几个吧。</p>}
          <button type="button" className="jv-btn jv-btn--sm pf-more" onClick={() => { onClose(); navigate('/market') }}>
            <Icon name="store" size={15} />添加更多
          </button>
        </fieldset>

        {error ? <p className="pf-error" role="alert">{error}</p> : null}
        <div className="pf-actions">
          <button type="button" className="jv-btn" onClick={onClose}>取消</button>
          <button type="submit" className="jv-btn jv-btn--primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </Modal>
  )
}
