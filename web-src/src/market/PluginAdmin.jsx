import { useCallback, useEffect, useState } from 'react'
import Modal, { ModalHead } from '../Modal.jsx'
import {
  addSource, checkUpdate, confirmImport, fileToBase64, listPlugins, previewImport, previewSourcePlugin,
  removeSource, setPluginEnabled, syncSource, uninstallPlugin,
} from './api.js'
import { shortRef, sourceLink } from './model.js'

/*
 * 插件管理（仅 Owner，契约见 docs/proposals/2026-10-round14-plugins.md）：
 *  - 导入：填 GitHub / Gitee 仓库地址，或上传 zip → 信任预览（作者、版本、来源 commit、权限、工具、缺失依赖、
 *    主页与隐私政策）→「确认安装」；
 *  - 已装：启用 / 停用（内置也能停）、卸载（只限导入的）、检查更新（有新版先看预览再确认升级）；
 *  - 插件源：添加一个含 .agents/plugins/marketplace.json 的仓库或 zip，同步后逐个预览安装。
 */

const MAX_ZIP = 10 * 1024 * 1024
const SOURCE_TYPE = { github: 'GitHub', gitee: 'Gitee', zip: '上传的 zip', builtin: '内置' }

function SourceLine({ source }) {
  if (!source) return null
  const link = sourceLink({ source })
  const label = source.repo ? `${SOURCE_TYPE[source.type] || source.type} · ${source.repo}` : SOURCE_TYPE[source.type] || '未知来源'
  return (
    <span className="jvm-src">
      {link ? <a href={link} target="_blank" rel="noreferrer noopener">{label}</a> : label}
      {source.ref ? <code title={source.ref}>@{shortRef(source.ref)}</code> : null}
      {source.path ? <span>/{source.path}</span> : null}
    </span>
  )
}

/** 安装前的信任确认卡：像 Codex / ChatGPT 的插件安装提示 */
export function TrustPreview({ preview, busy, onConfirm, onCancel }) {
  const p = preview.plugin || {}
  const links = preview.links || {}
  const upgrade = preview.upgrade
  return (
    <section className="jvm-trust" aria-label={`安装预览：${p.name}`}>
      <header className="jvm-trust-head">
        <span className="jvm-card-icon" aria-hidden="true">{p.icon || '🧩'}</span>
        <div>
          <h4>{p.name}{p.kind === 'skill' ? <span className="jvm-badge">提示词技能</span> : null}</h4>
          <p className="jvm-trust-meta">
            {upgrade ? `v${upgrade.from_version || '?'} → v${upgrade.to_version}` : `v${p.version}`}
            {p.author ? ` · 作者 ${p.author}` : ''}
            {p.license ? ` · ${p.license}` : ''}
          </p>
          <p className="jvm-card-summary">{p.summary}</p>
        </div>
      </header>
      <dl className="jvm-trust-list">
        <dt>来源</dt>
        <dd><SourceLine source={preview.source} /></dd>
        <dt>权限</dt>
        <dd>
          <ul className="jvm-perms">
            {(preview.permissions || []).map(item => (
              <li key={item.key} className={item.level === 'warn' ? 'is-warn' : ''}>{item.label}</li>
            ))}
          </ul>
        </dd>
        {preview.tools?.length ? (
          <>
            <dt>工具</dt>
            <dd><ul className="jvm-tools">{preview.tools.map(t => <li key={t.name}><code>{t.name}</code>{t.description ? ` ${t.description}` : ''}</li>)}</ul></dd>
          </>
        ) : null}
        {preview.skill?.split?.length ? (
          <>
            <dt>技能</dt>
            <dd>{preview.skill.split.map(s => s.name).join('、')}</dd>
          </>
        ) : null}
        {preview.python_packages?.length ? (
          <>
            <dt>依赖</dt>
            <dd>{preview.python_packages.map(pkg => (
              <span key={pkg.name} className={`jvm-pkg${pkg.installed ? '' : ' is-missing'}`}>
                {pkg.name}{pkg.installed ? ' ✓' : '（缺失）'}
              </span>
            ))}</dd>
          </>
        ) : null}
        <dt>文件</dt>
        <dd>{preview.file_count} 个 · {Math.max(1, Math.round((preview.total_size || 0) / 1024))} KB</dd>
        {links.homepage || links.privacy || links.terms ? (
          <>
            <dt>链接</dt>
            <dd className="jvm-trust-links">
              {links.homepage ? <a href={links.homepage} target="_blank" rel="noreferrer noopener">主页</a> : null}
              {links.privacy ? <a href={links.privacy} target="_blank" rel="noreferrer noopener">隐私政策</a> : null}
              {links.terms ? <a href={links.terms} target="_blank" rel="noreferrer noopener">服务条款</a> : null}
            </dd>
          </>
        ) : null}
      </dl>
      {preview.warnings?.length ? (
        <ul className="jvm-warns" role="note">{preview.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      ) : null}
      <div className="jvm-trust-actions">
        <button type="button" className="jvm-btn jvm-btn--ghost" onClick={onCancel} disabled={busy}>取消</button>
        <button type="button" className="jvm-btn" onClick={onConfirm} disabled={busy} data-autofocus>
          {busy ? '正在安装…' : upgrade ? '确认升级' : '确认安装'}
        </button>
      </div>
    </section>
  )
}

function ImportForm({ busy, onPreview }) {
  const [mode, setMode] = useState('url')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault()
    setError('')
    if (mode === 'url') {
      if (!url.trim()) { setError('先填一个仓库地址'); return }
      onPreview({ url: url.trim() })
      return
    }
    if (!file) { setError('先选一个 zip 文件'); return }
    if (file.size > MAX_ZIP) { setError('zip 超过 10MB，只打包插件目录就好'); return }
    try {
      onPreview({ zip_base64: await fileToBase64(file), zip_name: file.name })
    } catch (err) { setError(err.message) }
  }
  return (
    <form className="jvm-import" onSubmit={submit}>
      <div className="jvm-cats" role="group" aria-label="导入方式">
        <button type="button" aria-pressed={mode === 'url'} onClick={() => setMode('url')}>仓库地址</button>
        <button type="button" aria-pressed={mode === 'zip'} onClick={() => setMode('zip')}>上传 zip</button>
      </div>
      {mode === 'url' ? (
        <label className="jvm-field">
          <span>GitHub / Gitee 仓库地址（可带分支、子目录）</span>
          <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/作者/仓库/tree/main/插件目录"
            data-autofocus />
        </label>
      ) : (
        <label className="jvm-field">
          <span>插件目录打成的 zip（≤ 10MB）</span>
          <input type="file" accept=".zip,application/zip" onChange={e => setFile(e.target.files?.[0] || null)} />
        </label>
      )}
      {error ? <p className="jvm-form-error" role="alert">{error}</p> : null}
      <button type="submit" className="jvm-btn" disabled={busy}>{busy ? '正在读取…' : '预览'}</button>
    </form>
  )
}

function SourcesPanel({ sources, busy, run, onPreview }) {
  const [url, setUrl] = useState('')
  return (
    <section className="jvm-admin-sec" aria-label="插件源">
      <h4>插件源</h4>
      <p className="jvm-step-sub">添加一个带 .agents/plugins/marketplace.json 的仓库，同步后逐个预览安装（不会自动安装）。</p>
      <form className="jvm-inline" onSubmit={e => { e.preventDefault(); if (url.trim()) run(() => addSource({ url: url.trim() }), '插件源已同步') }}>
        <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/作者/插件源仓库" aria-label="插件源仓库地址" />
        <button type="submit" className="jvm-btn jvm-btn--ghost" disabled={busy}>添加</button>
      </form>
      {sources.map(s => (
        <div key={s.id} className="jvm-source">
          <div className="jvm-source-head">
            <b>{s.display_name || s.name}</b>
            <SourceLine source={s.origin} />
            <span className="jvm-admin-actions">
              <button type="button" onClick={() => run(() => syncSource(s.id), '已同步')} disabled={busy}>同步</button>
              <button type="button" onClick={() => run(() => removeSource(s.id), '已移除插件源')} disabled={busy}>移除</button>
            </span>
          </div>
          <ul className="jvm-admin-list">
            {s.plugins.map(p => (
              <li key={p.name}>
                <span>{p.display_name || p.name}{p.description ? <small> · {p.description}</small> : null}</span>
                {p.installed ? <span className="jvm-badge">已安装 v{p.installed_version}</span>
                  : p.id_taken ? <span className="jvm-badge">同名插件已存在</span>
                    : <button type="button" onClick={() => onPreview(() => previewSourcePlugin(s.id, p.name))} disabled={busy}>预览安装</button>}
              </li>
            ))}
            {(s.skipped || []).map(p => <li key={`skip-${p.name}`} className="is-off"><span>{p.name}</span><small>{p.reason}</small></li>)}
          </ul>
        </div>
      ))}
    </section>
  )
}

function ManageList({ plugins, busy, run, onPreview }) {
  const imported = plugins.filter(p => !p.builtin)
  const broken = plugins.filter(p => p.builtin && p.status !== 'ok')
  const builtinOff = plugins.filter(p => p.builtin && !p.enabled)
  async function update(p) {
    run(async () => {
      const r = await checkUpdate(p.id)
      if (r.has_update && r.preview) onPreview(() => Promise.resolve(r.preview))
      return r
    }, r => (r.has_update ? `发现新版本 v${r.latest_version}` : `已是最新（v${r.current_version}）`))
  }
  const row = p => (
    <li key={`${p.builtin ? 'b' : 'i'}-${p.id}`} className={p.status === 'ok' ? '' : 'is-off'}>
      <span>
        {p.icon} {p.name}{p.version ? <small> v{p.version}</small> : null}
        {p.status !== 'ok' ? <small className="jvm-reason"> · {p.reason}</small> : null}
        {!p.builtin ? <><br /><SourceLine source={p.source} /></> : null}
      </span>
      <span className="jvm-admin-actions">
        <button type="button" disabled={busy} onClick={() => run(() => setPluginEnabled(p.id, !p.enabled), p.enabled ? `已停用「${p.name}」` : `已启用「${p.name}」`)}>
          {p.enabled ? '停用' : '启用'}
        </button>
        {!p.builtin && ['github', 'gitee'].includes(p.source?.type) ? <button type="button" disabled={busy} onClick={() => update(p)}>检查更新</button> : null}
        {!p.builtin ? (
          <button type="button" disabled={busy} onClick={() => {
            if (window.confirm?.(`卸载「${p.name}」？装了它的智能体会失去这项能力。`) === false) return
            run(() => uninstallPlugin(p.id), `已卸载「${p.name}」`)
          }}>卸载</button>
        ) : null}
      </span>
    </li>
  )
  return (
    <section className="jvm-admin-sec" aria-label="已装插件">
      <h4>已导入的插件<span>{imported.length}</span></h4>
      {imported.length ? <ul className="jvm-admin-list">{imported.map(row)}</ul> : <p className="jvm-step-sub">还没有导入过插件。</p>}
      {builtinOff.length || broken.length ? (
        <>
          <h4>停用或异常的内置插件</h4>
          <ul className="jvm-admin-list">{[...builtinOff, ...broken.filter(p => p.enabled)].map(row)}</ul>
        </>
      ) : null}
    </section>
  )
}

/** Owner 在市场顶部看到的「导入插件」入口 + 管理弹窗 */
export default function PluginAdmin({ onChanged, initialTab = 'import', onSources, external = null }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState(initialTab)
  const [data, setData] = useState({ plugins: [], sources: [] })
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)

  const reload = useCallback(async () => {
    try {
      const d = await listPlugins()
      const next = { plugins: Array.isArray(d.plugins) ? d.plugins : [], sources: Array.isArray(d.sources) ? d.sources : [] }
      setData(next)
      onSources?.(next.sources)
    } catch (e) { setNotice({ kind: 'error', text: e.message }) }
  }, [onSources])
  useEffect(() => { reload() }, [reload])
  // 市场里插件源页签上点「预览安装」：打开弹窗直接进预览
  useEffect(() => {
    if (!external?.load) return
    setOpen(true)
    loadPreview(external.load)
  }, [external]) // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn, done) {
    setBusy(true)
    setNotice(null)
    try {
      const r = await fn()
      setNotice({ kind: 'ok', text: typeof done === 'function' ? done(r) : done })
      await reload()
      onChanged?.()
    } catch (e) {
      setNotice({ kind: 'error', text: e.message, hint: e.hint })
    } finally { setBusy(false) }
  }
  async function loadPreview(fn) {
    setBusy(true)
    setNotice(null)
    try { setPreview(await fn()) } catch (e) { setNotice({ kind: 'error', text: e.message, hint: e.hint }) } finally { setBusy(false) }
  }
  async function install() {
    const token = preview?.token
    await run(async () => { const r = await confirmImport(token); setPreview(null); return r },
      r => (r.status === 'ok' ? `「${r.name}」装好了，新对话里生效` : `「${r.name}」已安装，但暂不可用：${r.reason}`))
  }
  const close = () => { setOpen(false); setPreview(null); setNotice(null) }

  return (
    <>
      <button type="button" className="jvm-btn jvm-btn--ghost jvm-import-btn" onClick={() => { setOpen(true); setTab('import') }}>
        导入插件
      </button>
      <button type="button" className="jvm-link-btn" onClick={() => { setOpen(true); setTab('manage') }}>管理插件</button>
      {open ? (
        <Modal label="插件管理" size="lg" onClose={close} className="jvm-admin">
          <ModalHead title="插件管理" subtitle="从 GitHub、Gitee 或 zip 导入插件；第三方代码在独立子进程里运行" onClose={close} />
          <div className="jv-modal-body">
            {preview ? (
              <TrustPreview preview={preview} busy={busy} onConfirm={install} onCancel={() => setPreview(null)} />
            ) : (
              <>
                <div className="jvm-cats" role="tablist" aria-label="插件管理">
                  {[['import', '导入'], ['manage', '已装'], ['sources', '插件源']].map(([id, label]) => (
                    <button key={id} type="button" role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>
                  ))}
                </div>
                {tab === 'import' ? <ImportForm busy={busy} onPreview={body => loadPreview(() => previewImport(body))} /> : null}
                {tab === 'manage' ? <ManageList plugins={data.plugins} busy={busy} run={run} onPreview={loadPreview} /> : null}
                {tab === 'sources' ? <SourcesPanel sources={data.sources} busy={busy} run={run} onPreview={loadPreview} /> : null}
              </>
            )}
            {notice ? (
              <p className={`fl-notice jvm-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
                {notice.text}{notice.hint ? <><br /><small>{notice.hint}</small></> : null}
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  )
}
