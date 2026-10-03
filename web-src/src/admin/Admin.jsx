import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { APP_PATH, navigate } from '../routes.js'
import { applyTheme, currentTheme } from '../theme.js'
import Accounts from './Accounts.jsx'
import Alerts from './Alerts.jsx'
import { getAlerts, getUsage, markAlertsRead, RANGES, rangeOf } from './api.js'
import KindBars from './KindBars.jsx'
import { failRate, fmtCompact, fmtInt, fmtPct, fmtYuan, rangeText } from './model.js'
import QuotaSheet from './QuotaSheet.jsx'
import TrendChart from './TrendChart.jsx'
import { ErrorBox, Segmented } from './ui.jsx'
import './admin.css'

/* 管理后台（/admin，仅 Owner；第二十轮契约 docs/proposals/2026-10-round20-flows-ops.md §5、§6.2）：
 *   顶栏：回对话 · 管理后台 · 今天 / 近 7 天 / 近 30 天
 *   概览六格（模型调用、token、估算花费、流程运行、失败率、活跃账号）
 *   趋势（每日调用柱 + 花费折线）· 按类别分布
 *   账号表（搜索、排序、今天用量 / 配额、改配额）
 *   告警（未读高亮、单条 / 全部已读）
 * 第一次加载给骨架；切换范围时保留上一份数据淡一点显示，不闪；401 交给 onExpired 回登录页。 */

const RANGE_KEY = 'jv-admin-range'
const readRange = () => { try { return rangeOf(localStorage.getItem(RANGE_KEY)).id } catch { return '7d' } }
const writeRange = id => { try { localStorage.setItem(RANGE_KEY, id) } catch { /* 隐私模式：不记 */ } }

function Estimate({ pricing }) {
  const prices = pricing.input_per_m !== null && pricing.output_per_m !== null
  return (
    <span className="ad-est">
      <button type="button" className="ad-est-chip" aria-describedby="ad-est-pop">
        估算<Icon name="help" size={12} />
      </button>
      <span role="tooltip" id="ad-est-pop" className="ad-est-pop">
        {pricing.note || '按模型的公开价目粗算，仅供参考，实际以服务商账单为准。'}
        {prices ? <span className="ad-est-price">输入 ¥{pricing.input_per_m} · 输出 ¥{pricing.output_per_m}（每百万 token）</span> : null}
      </span>
    </span>
  )
}

function Tiles({ data, days }) {
  const t = data.totals
  const rate = failRate(t.flow_runs, t.flow_failures)
  const tone = rate === null ? '' : rate >= 0.25 ? 'bad' : rate >= 0.1 ? 'warn' : ''
  const p = data.pricing
  const tiles = [
    { key: 'calls', label: '模型调用', value: fmtInt(t.calls), sub: days > 1 ? `日均 ${fmtInt(t.calls / days)} 次` : '今天零点起' },
    { key: 'tokens', label: 'Token', value: fmtCompact(t.input_tokens + t.output_tokens),
      sub: `其中输出 ${fmtCompact(t.output_tokens)}` },
    { key: 'cost', label: '估算花费', value: fmtYuan(t.cost_yuan), extra: <Estimate pricing={p} />,
      sub: p.input_per_m !== null && p.output_per_m !== null ? `按 ¥${p.input_per_m} / ¥${p.output_per_m} 每百万 token` : '按公开价目粗算' },
    { key: 'runs', label: '流程运行', value: fmtInt(t.flow_runs),
      sub: t.flow_runs ? `成功 ${fmtInt(t.flow_runs - t.flow_failures)} 次` : '这段时间没跑过' },
    { key: 'rate', label: '失败率', value: fmtPct(rate), tone,
      sub: rate === null ? '没有运行' : t.flow_failures ? `失败 ${fmtInt(t.flow_failures)} 次` : '没有失败' },
    { key: 'active', label: '活跃账号', value: fmtInt(t.active_accounts), sub: `共 ${fmtInt(data.accounts.length)} 个账号` },
  ]
  return (
    <ul className="ad-tiles">
      {tiles.map(x => (
        <li key={x.key} className={`ad-tile${x.tone ? ` is-${x.tone}` : ''}`} data-tile={x.key}>
          <div className="ad-tile-label"><span>{x.label}</span>{x.extra || null}</div>
          <div className="ad-tile-value">
            {x.value}
            {x.tone ? <span className="ad-tile-flag"><Icon name="up" size={12} />偏高</span> : null}
          </div>
          <div className="ad-tile-sub">{x.sub}</div>
        </li>
      ))}
    </ul>
  )
}

function TilesSkeleton() {
  return (
    <ul className="ad-tiles" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map(i => <li key={i} className="ad-tile ad-skel"><i /><b /><i /></li>)}
    </ul>
  )
}

/** 趋势卡的内容：今天只有一天，不画「一根柱子的图」，给一句话和去看近 7 天的入口 */
function Trend({ data, days, now, onRange }) {
  const daily = data.daily
  const any = daily.some(d => d.calls > 0 || d.cost_yuan > 0)
  if (days <= 1 || daily.length < 2) {
    const t = data.totals
    return (
      <div className="ad-trend-today">
        <p className="ad-trend-today-big">{fmtInt(t.calls)}<span> 次调用</span></p>
        <p className="ad-dim">今天到现在 · 估算 {fmtYuan(t.cost_yuan)} · 流程 {fmtInt(t.flow_runs)} 次</p>
        <button type="button" className="ad-link" onClick={() => onRange('7d')}>看近 7 天的趋势</button>
      </div>
    )
  }
  if (!any) return <p className="ad-empty-line ad-trend-empty">这段时间还没有模型调用，有人用了这里就会画出来</p>
  return <TrendChart daily={daily} now={now} label={`${days} 天里每天的模型调用与估算花费`} />
}

export default function Admin({ onExpired, now: nowProp }) {
  const now = nowProp || new Date()
  // App 每次渲染都给新的 onExpired：放进 ref，副作用里用稳定的函数
  const expiredRef = useRef(onExpired)
  expiredRef.current = onExpired
  const expired = useCallback(() => expiredRef.current?.(), [])

  // 后台页不挂 Hud，主题自己套；读不到存储（隐私模式）按暗色
  useEffect(() => {
    let theme = 'dark'
    try { theme = currentTheme() } catch { /* 存储不可用 */ }
    applyTheme(theme)
  }, [])

  const [range, setRange] = useState(readRange)
  const r = rangeOf(range)
  const pickRange = id => { setRange(id); writeRange(id) }

  /* ---- 用量 ---- */
  const [usage, setUsage] = useState({ data: null, loading: true, error: '' })
  const [usageTick, setUsageTick] = useState(0)
  useEffect(() => {
    const ctrl = new AbortController()
    setUsage(u => ({ ...u, loading: true, error: '' }))
    getUsage(r.days, { signal: ctrl.signal })
      .then(data => { if (!ctrl.signal.aborted) setUsage({ data, loading: false, error: '' }) })
      .catch(e => {
        if (ctrl.signal.aborted || e?.name === 'AbortError') return
        if (e?.message === '401') { expired(); return }
        setUsage(u => ({ ...u, loading: false, error: e?.message || '没加载出来' }))
      })
    return () => ctrl.abort()
  }, [r.days, usageTick, expired])
  const retryUsage = () => setUsageTick(t => t + 1)

  /* ---- 告警 ---- */
  const [alerts, setAlerts] = useState({ list: null, unread: 0, loading: true, error: '', busy: false })
  const [alertTick, setAlertTick] = useState(0)
  useEffect(() => {
    const ctrl = new AbortController()
    setAlerts(a => ({ ...a, loading: true, error: '' }))
    getAlerts(50, { signal: ctrl.signal })
      .then(({ alerts: list, unread }) => { if (!ctrl.signal.aborted) setAlerts({ list, unread, loading: false, error: '', busy: false }) })
      .catch(e => {
        if (ctrl.signal.aborted || e?.name === 'AbortError') return
        if (e?.message === '401') { expired(); return }
        setAlerts(a => ({ ...a, loading: false, error: e?.message || '告警没加载出来' }))
      })
    return () => ctrl.abort()
  }, [alertTick, expired])

  async function readAlerts(ids) {
    const before = alerts
    const all = ids === 'all'
    const hit = new Set(all ? [] : ids)
    const list = (before.list || []).map(a => (all || hit.has(a.id) ? { ...a, read: true } : a))
    const cleared = (before.list || []).filter(a => !a.read && (all || hit.has(a.id))).length
    setAlerts({ ...before, list, unread: all ? 0 : Math.max(0, before.unread - cleared), busy: true, error: '' })
    try {
      await markAlertsRead(all ? { all: true } : { ids })
      setAlerts(a => ({ ...a, busy: false }))
    } catch (e) {
      if (e?.message === '401') { expired(); return }
      setAlerts({ ...before, busy: false, error: `没标上已读：${e?.message || '请再试一次'}` })
    }
  }

  /* ---- 改配额 ---- */
  const [editing, setEditing] = useState(null)
  const [toast, setToast] = useState('')
  useEffect(() => {
    if (!toast) return undefined
    const t = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(t)
  }, [toast])
  function quotaSaved(account, quota) {
    setUsage(u => (u.data ? {
      ...u,
      data: { ...u.data, accounts: u.data.accounts.map(a => (a.user_id === account.user_id ? { ...a, quota } : a)) },
    } : u))
    setEditing(null)
    setToast(`已更新 ${account.username} 的每日配额`)
  }

  const alertsRef = useRef(null)
  const data = usage.data
  const stale = usage.loading && Boolean(data)

  return (
    <div className="ad-page">
      <header className="ad-top">
        <button type="button" className="ad-back" onClick={() => navigate(APP_PATH)} aria-label="返回对话">
          <Icon name="chevron" size={16} className="ad-flip" /><span>对话</span>
        </button>
        <h1 className="ad-title">管理后台</h1>
        <div className="ad-top-end">
          <Segmented label="时间范围" options={RANGES} value={r.id} onChange={pickRange} />
        </div>
      </header>

      <main className="ad-scroll">
        <div className="ad-wrap">
          <div className="ad-head">
            <div>
              <h2 className="ad-h2">概览</h2>
              <p className="ad-dim">{rangeText(r.days, now)}</p>
            </div>
            {alerts.unread > 0 ? (
              <button type="button" className="ad-unread-pill"
                onClick={() => alertsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}>
                <span className="ad-dot" aria-hidden="true" />{alerts.unread} 条未读告警
              </button>
            ) : null}
          </div>

          {usage.error && !data ? (
            <ErrorBox message={`用量没加载出来：${usage.error}`} onRetry={retryUsage} />
          ) : (
            <div className={`ad-usage${stale ? ' is-stale' : ''}`} aria-busy={usage.loading || undefined}>
              {usage.error ? <ErrorBox message={`刷新没成功：${usage.error}`} onRetry={retryUsage} compact /> : null}
              {data ? <Tiles data={data} days={r.days} /> : <TilesSkeleton />}

              <div className="ad-row">
                <section className="ad-card ad-card--trend" aria-labelledby="ad-h-trend">
                  <div className="ad-card-head">
                    <h2 className="ad-h3" id="ad-h-trend">每日趋势</h2>
                    <span className="ad-dim">{r.days > 1 ? r.label : '今天'}</span>
                  </div>
                  {data ? <Trend data={data} days={r.days} now={now} onRange={pickRange} /> : <div className="ad-skel ad-skel-chart" aria-hidden="true" />}
                </section>
                <section className="ad-card ad-card--kinds" aria-labelledby="ad-h-kinds">
                  <div className="ad-card-head"><h2 className="ad-h3" id="ad-h-kinds">按类别</h2><span className="ad-dim">模型调用次数</span></div>
                  {data ? <KindBars byKind={data.by_kind} /> : <div className="ad-skel ad-skel-kinds" aria-hidden="true"><i /><i /><i /><i /></div>}
                </section>
              </div>

              <section className="ad-card" aria-labelledby="ad-h-accounts">
                <div className="ad-card-head">
                  <h2 className="ad-h3" id="ad-h-accounts">账号{data ? <span className="ad-count">{data.accounts.length}</span> : null}</h2>
                  <span className="ad-dim">{r.days > 1 ? `今天的用量对照每日配额；其余是${r.label}` : '今天的用量对照每日配额'}</span>
                </div>
                {data ? (
                  <Accounts accounts={data.accounts} defaults={data.defaults} rangeLabel={r.days > 1 ? r.label : '今天'}
                    onEdit={setEditing} now={now} />
                ) : <div className="ad-skel ad-skel-table" aria-hidden="true"><i /><i /><i /><i /></div>}
              </section>
            </div>
          )}

          <section className="ad-card ad-card--alerts" aria-labelledby="ad-h-alerts" ref={alertsRef}>
            <div className="ad-card-head">
              <h2 className="ad-h3" id="ad-h-alerts">告警{alerts.unread > 0 ? <span className="ad-count is-hot">{alerts.unread} 未读</span> : null}</h2>
              <button type="button" className="ad-link" onClick={() => readAlerts('all')}
                disabled={!alerts.unread || alerts.busy}>全部标为已读</button>
            </div>
            <Alerts alerts={alerts.list} loading={alerts.loading} error={alerts.error} busy={alerts.busy}
              onRead={readAlerts} onRetry={() => setAlertTick(t => t + 1)} now={now} />
          </section>
        </div>
      </main>

      {editing ? (
        <QuotaSheet account={editing} defaults={data?.defaults} onClose={() => setEditing(null)}
          onSaved={quotaSaved} onExpired={expired} />
      ) : null}
      {toast ? <div className="jv-toast" role="status">{toast}</div> : null}
    </div>
  )
}
