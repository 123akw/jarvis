import { useState } from 'react'
import Icon from '../Icon.jsx'
import { requireText, shortRef, sourceLink } from './model.js'

const KIND_TAG = { channel: '通道', step: '流程积木', skill: '提示词技能' }

/** 一张插件卡：图标、名称、一句话、专业版 / 社区 / 需绑定提示，右侧「加入」开关；暂不可用的灰显并写原因 */
export function PluginCard({ plugin, picked, onToggle, showAvailability = false }) {
  const p = plugin
  const example = p.kind === 'tool' && p.examples[0]
  const broken = p.status === 'unavailable'
  const link = !p.builtin ? sourceLink(p) : ''
  return (
    <article className={`jvm-card${picked ? ' is-picked' : ''}${broken ? ' is-off' : ''}`} aria-label={p.name}>
      <span className="jvm-card-icon" aria-hidden="true">{p.icon}</span>
      <div className="jvm-card-body">
        <h4 className="jvm-card-name">
          {p.name}
          {p.tier === 'pro' ? <span className="jvm-badge is-pro">专业版</span> : null}
          {!p.builtin ? <span className="jvm-badge is-community">社区</span> : null}
          {KIND_TAG[p.kind] ? <span className="jvm-badge">{KIND_TAG[p.kind]}</span> : null}
        </h4>
        {p.summary ? <p className="jvm-card-summary">{p.summary}</p> : null}
        {example ? <p className="jvm-card-example">“{example}”</p> : null}
        {!p.builtin ? (
          <p className="jvm-card-source">
            {p.version ? `v${p.version}` : ''}{p.author ? ` · ${p.author}` : ''}
            {link ? <> · <a href={link} target="_blank" rel="noreferrer noopener">来源{p.source?.ref ? ` @${shortRef(p.source.ref)}` : ''}</a></> : null}
          </p>
        ) : null}
        {broken ? <p className="jvm-card-req is-off">暂不可用：{p.reason || '插件没加载成功'}</p> : null}
        {!broken && (p.requires.length || (showAvailability && !p.available)) ? (
          <p className="jvm-card-req">
            {p.requires.map(requireText).join(' · ')}
            {showAvailability && !p.available ? `${p.requires.length ? ' · ' : ''}当前账号暂不可用` : ''}
          </p>
        ) : null}
      </div>
      <button type="button" className={`jvm-add${picked ? ' is-on' : ''}`} aria-pressed={picked} disabled={broken && !picked}
        aria-label={picked ? `移出工具箱：${p.name}` : `加入工具箱：${p.name}`} onClick={() => onToggle(p.id)}>
        {picked ? <><Icon name="check" size={15} /><span>已加入</span></> : <><Icon name="plus" size={15} /><span>加入</span></>}
      </button>
    </article>
  )
}

/** 插件源页签：源里的插件逐个列出，已装的就是普通插件卡，没装的给「预览安装」（仅 Owner 看得到） */
function SourceTab({ source, catalog, picked, onToggle, authed, onInstall }) {
  const byId = new Map(catalog.plugins.map(p => [p.id, p]))
  return (
    <section className="jvm-group" aria-label={source.display_name || source.name}>
      <p className="jvm-step-sub">来自插件源「{source.display_name || source.name}」，装好后和其他插件一样加入工具箱。</p>
      <div className="jvm-grid">
        {source.plugins.map(item => {
          const installed = item.installed ? byId.get(item.id) : null
          if (installed) {
            return <PluginCard key={item.name} plugin={installed} picked={picked.has(installed.id)} onToggle={onToggle} showAvailability={authed} />
          }
          return (
            <article key={item.name} className="jvm-card is-remote" aria-label={item.display_name || item.name}>
              <span className="jvm-card-icon" aria-hidden="true">🧩</span>
              <div className="jvm-card-body">
                <h4 className="jvm-card-name">{item.display_name || item.name}<span className="jvm-badge is-community">社区</span></h4>
                {item.description ? <p className="jvm-card-summary">{item.description}</p> : null}
                {item.note ? <p className="jvm-card-example">{item.note}</p> : null}
              </div>
              <button type="button" className="jvm-add" disabled={item.id_taken} onClick={() => onInstall(source.id, item.name)}
                aria-label={`预览安装：${item.display_name || item.name}`}>
                <Icon name="plus" size={15} /><span>{item.id_taken ? '同名已装' : '安装'}</span>
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

/** 插件市场：页签（官方 / 已导入 / 各插件源）+ 分类筛选 + 按分类分组的插件卡 */
export default function Skills({ catalog, picked, onToggle, authed, admin = null, sources = [], onInstallFromSource }) {
  const [cat, setCat] = useState('all')
  const [tab, setTab] = useState('official')
  const imported = catalog.plugins.filter(p => !p.builtin)
  const tabs = [{ id: 'official', name: '官方' }]
  if (imported.length || admin) tabs.push({ id: 'imported', name: '已导入', count: imported.length })
  sources.forEach(s => tabs.push({ id: `source:${s.id}`, name: s.display_name || s.name, count: s.plugins.length }))
  const current = tabs.some(t => t.id === tab) ? tab : 'official'
  const source = current.startsWith('source:') ? sources.find(s => `source:${s.id}` === current) : null
  const pool = current === 'imported' ? imported : catalog.plugins.filter(p => p.builtin)
  const groups = catalog.categories
    .filter(c => cat === 'all' || c.id === cat)
    .map(c => ({ ...c, plugins: pool.filter(p => p.category === c.id) }))
    .filter(g => g.plugins.length || current === 'official')
  const pickedSet = new Set(picked)

  return (
    <section className="jvm-catalog" aria-labelledby="jvm-catalog-title">
      <header className="jvm-catalog-head">
        <h2 id="jvm-catalog-title" className="jvm-catalog-title">插件市场<span>{catalog.plugins.length}</span></h2>
        <p className="jvm-step-sub">点「加入」放进工具箱，随时可以拿掉。</p>
        {admin ? <div className="jvm-admin-entry">{admin}</div> : null}
      </header>
      {tabs.length > 1 ? (
        <div className="jvm-tabs" role="tablist" aria-label="插件来源">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={current === t.id} onClick={() => setTab(t.id)}>
              {t.name}{t.count !== undefined ? <span>{t.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {source ? (
        <SourceTab source={source} catalog={catalog} picked={pickedSet} onToggle={onToggle} authed={authed}
          onInstall={onInstallFromSource} />
      ) : (
        <>
          <div className="jvm-cats" role="group" aria-label="按分类看">
            <button type="button" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>全部</button>
            {catalog.categories.map(c => (
              <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{c.name}</button>
            ))}
          </div>
          {current === 'imported' && !imported.length ? (
            <p className="jvm-box-empty">还没有导入的插件：点上面的「导入插件」，从 GitHub、Gitee 或 zip 装一个。</p>
          ) : null}
          {groups.map(g => (
            <section key={g.id} className="jvm-group" aria-label={g.name}>
              <h3 className="jvm-group-title">{g.name}<span>{g.plugins.length}</span></h3>
              <div className="jvm-grid">
                {g.plugins.map(p => (
                  <PluginCard key={p.id} plugin={p} picked={pickedSet.has(p.id)} onToggle={onToggle} showAvailability={authed} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </section>
  )
}
