import { useEffect, useMemo, useState } from 'react'
import { getDesktopSettings, getMeetingSettings, getProviderSettings, getRadio, getVoiceSettings, restoreIntegration, restoreLLMSettings, saveDesktopSettings, saveIntegration, saveLLMSettings, saveMeetingSettings, saveRadio, saveVoiceSettings, testIntegration, testLLMSettings } from './api.js'
import { desktopWindow, pingDesktop } from './desktopWake.js'
import { ModalHead } from './Modal.jsx'

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
  if (!settings) return <section className="jv-sheet provider-sheet" aria-label="设置中心"><ModalHead title="设置中心" onClose={onClose} closeLabel="关闭 API 设置" /><div className="jv-modal-body"><p role="status" className="jv-muted">{message || '正在读取 API 设置…'}</p></div></section>
  return <section className="jv-sheet provider-sheet" aria-label="设置中心">
    <ModalHead title="设置中心" subtitle={`${session.username} · 密钥不会回显`} onClose={onClose} closeLabel="关闭 API 设置" />
    <div className="jv-modal-body">
    <SettingsTabs tab={tab} onChange={next => { setTab(next); setMessage('') }} owner={session.role === 'Owner'} />
    <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
    {tab === 'voice' ? <VoiceSettingsPane onMessage={setMessage} onExpired={onExpired} /> : null}
    {tab === 'desktop' ? <DesktopMeetingPane onMessage={setMessage} onExpired={onExpired} /> : null}
    {tab === 'llm' ? <div className="provider-pane">
      <label>Provider<select aria-label="Provider" value={provider} onChange={event => { const id = event.target.value; const item = settings.catalog.find(row => row.id === id); setProvider(id); setBaseUrl(item?.base_url || ''); setKeep(false); setApiKey('') }}>{settings.catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Base URL<input aria-label="Base URL" value={baseUrl} readOnly={!catalog?.editable} onChange={event => { setBaseUrl(event.target.value); setKeep(false); setApiKey('') }} /></label>
      <label>模型<input aria-label="模型" value={model} onChange={event => setModel(event.target.value)} /></label>
      <label>API Key<input aria-label="API Key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" placeholder={settings.llm.key_configured ? '已配置；新 Key 留空不代表读取' : '请输入个人 API Key'} /></label>
      {settings.llm.key_configured && sameScope ? <label className="provider-check"><input type="checkbox" checked={keep} onChange={event => setKeep(event.target.checked)} />保留同一 Provider 与 Origin 的现有 Key</label> : null}
      <label>当前口令<input aria-label="当前口令" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>
      <p className="provider-risk">测试会执行极少量非流式工具、流式文本和流式工具请求，可能产生少量模型费用。自定义中转方可以读取问题、上下文、工具调用和输出，建议使用独立、低额度、可吊销的 Key。</p>
      {catalog?.key_url ? <a href={catalog.key_url} target="_blank" rel="noopener noreferrer">打开官方 API Key 申请页</a> : null}
      <div className="provider-actions"><button disabled={busy || !password} onClick={() => action('test')}>测试连接</button><button className="primary" disabled={busy || !settings.writable || !password} onClick={() => action('save')}>保存并应用</button><button disabled={busy || !settings.writable || !password} onClick={restore}>恢复服务器配置</button></div>
    </div> : null}
    {tab === 'search' ? <IntegrationSettings settings={settings} password={password} setPassword={setPassword} onMessage={setMessage} onRefresh={refresh} onExpired={onExpired} /> : null}
    </div>
    {message ? <p className="provider-message" role="status">{message}</p> : null}
    </div>
  </section>
}

const TABS = [['llm', '模型 API'], ['voice', '语音'], ['desktop', '桌面与会议'], ['search', '联网数据源']]

/** 页签：WAI-ARIA tabs 模式（role=tab + aria-selected，←/→/Home/End 切换并移焦点，只有当前页签在 Tab 序列里） */
function SettingsTabs({ tab, onChange, owner }) {
  const tabs = TABS.filter(([id]) => owner || id !== 'search')
  function onKey(e) {
    const i = tabs.findIndex(([id]) => id === tab)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(tabs[next][0])
    e.currentTarget.parentElement.querySelectorAll('[role=tab]')[next]?.focus()
  }
  return (
    <div className="provider-tabs" role="tablist" aria-label="设置分类">
      {tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" id={`settings-tab-${id}`} aria-selected={tab === id}
          aria-controls={`settings-panel-${id}`} tabIndex={tab === id ? 0 : -1}
          className={tab === id ? 'on' : ''} onClick={() => onChange(id)} onKeyDown={onKey}>{label}</button>
      ))}
    </div>
  )
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
    <div className="provider-actions"><button disabled={!password} onClick={() => act('test')}>测试连接</button><button className="primary" disabled={!settings.writable || !password} onClick={() => act('save')}>保存</button><button disabled={!settings.writable || !password} onClick={() => act('restore')}>恢复环境配置</button></div>
  </div>
}

function VoiceSettingsPane({ onMessage, onExpired }) {
  const [voice, setVoice] = useState(''), [speed, setSpeed] = useState(1)
  const [catalog, setCatalog] = useState(null), [busy, setBusy] = useState(false)
  const [radioTime, setRadioTime] = useState('')
  useEffect(() => {
    getVoiceSettings()
      .then(v => { setVoice(v.voice); setSpeed(v.speed); setCatalog(v.catalog) })
      .catch(error => { if (error.message === '401') onExpired?.(); else onMessage(errorText(error)) })
    getRadio().then(r => setRadioTime(r.time || '')).catch(() => {})
  }, [])
  async function save() {
    setBusy(true)
    try {
      await saveVoiceSettings(voice, Number(speed))
      await saveRadio(radioTime)
      onMessage('语音设置已保存；下一通语音通话生效。')
    }
    catch (error) { if (error.message === '401') onExpired?.(); onMessage(errorText(error)) }
    finally { setBusy(false) }
  }
  if (!catalog) return <div className="provider-pane"><p role="status" className="jv-muted">正在读取语音设置…</p></div>
  return <div className="provider-pane">
    <label>音色<select aria-label="音色" value={voice} onChange={event => setVoice(event.target.value)}>{catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>语速 · {Number(speed).toFixed(2)}×
      <input aria-label="语速" type="range" min="0.5" max="2" step="0.05" value={speed} onChange={event => setSpeed(event.target.value)} />
    </label>
    <label>晨报电台（留空关闭）
      <input aria-label="晨报时间" type="time" value={radioTime} onChange={event => setRadioTime(event.target.value)} />
    </label>
    <p className="provider-risk">音色与语速只影响你自己的语音通话答复（网页与桌面端共用）。晨报电台会在每天设定时间把「天气+日程+待办」做成语音条+文字发到你的微信——需要先在微信里对贾维斯说「提醒发给我」完成绑定。</p>
    <div className="provider-actions"><button className="primary" disabled={busy || !voice} onClick={save}>保存</button></div>
  </div>
}

function DesktopMeetingPane({ onMessage, onExpired }) {
  const [alive, setAlive] = useState(null)          // null=探测中 / {loggedIn} / false=未运行
  const [ballVisible, setBallVisible] = useState(true)
  const [mailTo, setMailTo] = useState(''), [mailDefault, setMailDefault] = useState('')
  const [smtpReady, setSmtpReady] = useState(true)
  const [quitArmed, setQuitArmed] = useState(false), [busy, setBusy] = useState(false)
  useEffect(() => {
    pingDesktop().then(result => setAlive(result || false)).catch(() => setAlive(false))
    getDesktopSettings().then(d => setBallVisible(Boolean(d.ball_visible))).catch(() => {})
    getMeetingSettings()
      .then(m => { setMailTo(m.mail_to || ''); setMailDefault(m.default || ''); setSmtpReady(Boolean(m.smtp_configured)) })
      .catch(error => { if (error.message === '401') onExpired?.() })
  }, [])
  async function setBall(visible) {
    setBusy(true)
    try {
      await saveDesktopSettings(visible)            // 服务端偏好：跨机 10 秒内轮询生效
      setBallVisible(visible)
      const local = await desktopWindow(visible ? 'show' : 'hide')  // 同机快路径：秒级生效
      onMessage(local.status === 'done'
        ? (visible ? '悬浮球已显示。' : '悬浮球已隐藏（托盘和快捷键仍可唤回）。')
        : (visible ? '偏好已保存；桌面端在线后 10 秒内显示悬浮球。' : '偏好已保存；桌面端在线后 10 秒内隐藏悬浮球。'))
    } catch (error) { if (error.message === '401') onExpired?.(); onMessage(errorText(error)) }
    finally { setBusy(false) }
  }
  async function quitDesktop() {
    if (!quitArmed) { setQuitArmed(true); setTimeout(() => setQuitArmed(false), 4000); return }
    setQuitArmed(false)
    setBusy(true)
    try {
      const result = await desktopWindow('quit')
      onMessage(result.status === 'done' ? '桌面端已彻底关闭；需要时重新启动应用即可。'
        : result.status === 'not-running' ? '桌面端不在这台电脑上运行（或已经关闭）。'
          : '关闭请求没有送达，请在桌面端托盘里退出。')
      if (result.status === 'done') setAlive(false)
    } finally { setBusy(false) }
  }
  async function saveMail() {
    setBusy(true)
    try { const saved = await saveMeetingSettings(mailTo.trim()); onMessage(`会议纪要将发送至 ${saved.mail_to}。`) }
    catch (error) { if (error.message === '401') onExpired?.(); onMessage(errorText(error)) }
    finally { setBusy(false) }
  }
  return <div className="provider-pane">
    <p role="status" className="jv-muted">桌面端状态：{alive === null ? '探测中…' : alive ? '在这台电脑上运行中' : '未运行（或不在这台电脑上；跨机时以下开关经服务器下发）'}</p>
    <label className="provider-check"><input type="checkbox" checked={ballVisible} disabled={busy} onChange={event => void setBall(event.target.checked)} />在桌面显示悬浮球</label>
    <div className="provider-actions">
      <button disabled={busy} onClick={() => void setBall(true)}>显示悬浮球</button>
      <button disabled={busy} onClick={() => void setBall(false)}>隐藏悬浮球</button>
      <button disabled={busy} onClick={() => void quitDesktop()}>{quitArmed ? '再点一次确认关闭' : '彻底关闭桌面端'}</button>
    </div>
    <label>会议纪要收件邮箱
      <input aria-label="会议纪要收件邮箱" value={mailTo} onChange={event => setMailTo(event.target.value)} placeholder={mailDefault ? `留空使用默认：${mailDefault}` : '如 1539598168@qq.com'} />
    </label>
    <p className="provider-risk">会议纪要由 macOS 桌面端采集（你的麦克风 + 系统里对方的声音），结束后自动整理并发送到上面的邮箱。{smtpReady ? '' : '当前服务器还没配置 SMTP 发信（.env 里的 JARVIS_SMTP_*），纪要会保存但发不出邮件。'}对话里说「监控会议」也能远程开始。</p>
    <div className="provider-actions"><button className="primary" disabled={busy} onClick={() => void saveMail()}>保存收件邮箱</button></div>
  </div>
}

function origin(value) { try { return new URL(value).origin } catch { return '' } }
