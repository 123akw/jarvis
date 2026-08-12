import { useEffect, useMemo, useState } from 'react'
import { getProviderSettings, restoreIntegration, restoreLLMSettings, saveIntegration, saveLLMSettings, testIntegration, testLLMSettings } from './api.js'

const errorText = error => error?.message === '401' ? '登录已失效，请重新登录。' : (error?.message || '操作失败。')

export default function ProviderSettings({ session, onClose, onExpired, onApplied }) {
  const [settings, setSettings] = useState(null), [tab, setTab] = useState('llm')
  const [provider, setProvider] = useState('deepseek'), [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState(''), [password, setPassword] = useState(''), [keep, setKeep] = useState(false)
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  async function refresh() {
    try { const value = await getProviderSettings(); setSettings(value); setProvider(value.llm.provider); setBaseUrl(value.llm.base_url); setModel(value.llm.model); setApiKey(''); setPassword(''); setKeep(false) }
    catch (error) { if (error.message === '401') onExpired?.(); else setMessage(errorText(error)) }
  }
  useEffect(() => { void refresh() }, [])
  const catalog = useMemo(() => settings?.catalog?.find(item => item.id === provider), [settings, provider])
  const sameScope = settings?.llm?.provider === provider && origin(settings?.llm?.base_url) === origin(baseUrl)
  const body = () => ({ provider, base_url: baseUrl, model, api_key: apiKey || null, keep_existing_key: Boolean(keep && sameScope), admin_password: password, expected_generation: settings.llm.generation })
  async function action(kind) {
    setBusy(true); setMessage('')
    try { const result = kind === 'test' ? await testLLMSettings(body()) : await saveLLMSettings(body()); setMessage(kind === 'test' ? `测试通过 · ${result.latency_ms ?? 0} ms · 流式与工具调用兼容` : '已保存并应用；新请求使用新配置。'); if (kind === 'save') { await refresh(); onApplied?.() } }
    catch (error) { if (error.message === '401') onExpired?.(); setMessage(errorText(error)) }
    finally { setApiKey(''); setPassword(''); setBusy(false) }
  }
  async function restore() {
    setBusy(true); setMessage('')
    try { await restoreLLMSettings({ admin_password: password, expected_generation: settings.llm.generation }); setMessage('已恢复服务器环境配置。'); await refresh(); onApplied?.() }
    catch (error) { if (error.message === '401') onExpired?.(); setMessage(errorText(error)) }
    finally { setPassword(''); setApiKey(''); setBusy(false) }
  }
  if (!settings) return <section className="provider-card"><p role="status">{message || '正在读取 API 设置…'}</p></section>
  return <section className="provider-card" aria-label="API 设置中心">
    <div className="account-head"><div><b>API 设置中心</b><small>{session.username} · 密钥不会回显</small></div><button className="wx-x" onClick={onClose} aria-label="关闭 API 设置">×</button></div>
    <div className="provider-tabs" role="tablist"><button className={tab === 'llm' ? 'on' : ''} onClick={() => setTab('llm')}>模型 API</button>{session.role === 'Owner' ? <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>联网数据源</button> : null}</div>
    {tab === 'llm' ? <div className="provider-pane">
      <label>Provider<select aria-label="Provider" value={provider} onChange={event => { const id = event.target.value; const item = settings.catalog.find(row => row.id === id); setProvider(id); setBaseUrl(item?.base_url || ''); setKeep(false); setApiKey('') }}>{settings.catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Base URL<input aria-label="Base URL" value={baseUrl} readOnly={!catalog?.editable} onChange={event => { setBaseUrl(event.target.value); setKeep(false); setApiKey('') }} /></label>
      <label>模型<input aria-label="模型" value={model} onChange={event => setModel(event.target.value)} /></label>
      <label>API Key<input aria-label="API Key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" placeholder={settings.llm.key_configured ? '已配置；新 Key 留空不代表读取' : '请输入个人 API Key'} /></label>
      {settings.llm.key_configured && sameScope ? <label className="provider-check"><input type="checkbox" checked={keep} onChange={event => setKeep(event.target.checked)} />保留同一 Provider 与 Origin 的现有 Key</label> : null}
      <label>当前口令<input aria-label="当前口令" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>
      <p className="provider-risk">测试会执行极少量非流式工具、流式文本和流式工具请求，可能产生少量模型费用。自定义中转方可以读取问题、上下文、工具调用和输出，建议使用独立、低额度、可吊销的 Key。</p>
      {catalog?.key_url ? <a href={catalog.key_url} target="_blank" rel="noopener noreferrer">打开官方 API Key 申请页</a> : null}
      <div className="provider-actions"><button disabled={busy || !password} onClick={() => action('test')}>测试连接</button><button disabled={busy || !settings.writable || !password} onClick={() => action('save')}>保存并应用</button><button disabled={busy || !settings.writable || !password} onClick={restore}>恢复服务器配置</button></div>
    </div> : <IntegrationSettings settings={settings} password={password} setPassword={setPassword} onMessage={setMessage} onRefresh={refresh} onExpired={onExpired} />}
    {message ? <p className="provider-message" role="status">{message}</p> : null}
  </section>
}

function IntegrationSettings({ settings, password, setPassword, onMessage, onRefresh, onExpired }) {
  const [name, setName] = useState('searxng'), [enabled, setEnabled] = useState(Boolean(settings.integrations.searxng?.enabled))
  const [baseUrl, setBaseUrl] = useState(settings.integrations.searxng?.base_url || 'http://127.0.0.1:18888'), [key, setKey] = useState(''), [keep, setKeep] = useState(false)
  const current = settings.integrations[name]
  useEffect(() => { const next = settings.integrations[name]; setEnabled(Boolean(next?.enabled)); setBaseUrl(next?.base_url || 'http://127.0.0.1:18888'); setKey(''); setKeep(false) }, [name, settings])
  const body = () => ({ enabled, base_url: baseUrl, api_key: key || null, keep_existing_key: keep, admin_password: password, expected_generation: current.generation })
  async function act(kind) {
    try { if (kind === 'restore') await restoreIntegration(name, { admin_password: password, expected_generation: current.generation }); else if (kind === 'test') await testIntegration(name, body()); else await saveIntegration(name, body()); onMessage(kind === 'test' ? '联网数据源测试通过。' : kind === 'restore' ? '已恢复环境配置。' : '联网数据源已保存。'); if (kind !== 'test') await onRefresh() }
    catch (error) { if (error.message === '401') onExpired?.(); onMessage(errorText(error)) }
    finally { setKey(''); setPassword('') }
  }
  return <div className="provider-pane">
    <label>数据源<select aria-label="数据源" value={name} onChange={event => setName(event.target.value)}><option value="searxng">SearXNG</option><option value="tavily">Tavily</option><option value="pandascore">PandaScore</option></select></label>
    <label className="provider-check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用</label>
    {name === 'searxng' ? <label>Base URL<input aria-label="联网 Base URL" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label> : <><label>API Key<input aria-label="联网 API Key" type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="new-password" placeholder={current.key_configured ? '已配置；可勾选保留' : '请输入 API Key'} /></label>{current.key_configured ? <label className="provider-check"><input type="checkbox" checked={keep} onChange={event => setKeep(event.target.checked)} />保留现有 Key</label> : null}</>}
    <label>Owner 当前口令<input aria-label="Owner 当前口令" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>
    <div className="provider-actions"><button disabled={!password} onClick={() => act('test')}>测试连接</button><button disabled={!settings.writable || !password} onClick={() => act('save')}>保存</button><button disabled={!settings.writable || !password} onClick={() => act('restore')}>恢复环境配置</button></div>
  </div>
}

function origin(value) { try { return new URL(value).origin } catch { return '' } }
