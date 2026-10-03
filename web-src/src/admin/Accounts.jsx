import { useMemo, useState } from 'react'
import Icon from '../Icon.jsx'
import {
  fmtCompact, fmtInt, fmtYuan, isOwner, meterTone, quotaLimit, QUOTA_LABELS, relTime, SORTS, sortAccounts,
} from './model.js'
import { Segmented, useNarrow } from './ui.jsx'

/* 账号表：搜索（账号名 / 智能体名）、排序（用量 / 花费 / 失败 / 最近活跃）；
 * 每行：账号与智能体、今天用了多少 / 配额、这段时间的调用与花费、流程运行与失败、最近活跃、改配额。
 * 宽屏是表格，窄屏（≤720）换成一张张卡片。Owner 不限额，不给改。 */

const initialOf = name => String(name || '').trim().slice(0, 1).toUpperCase() || '·'

function Who({ a }) {
  return (
    <div className="ad-who">
      <span className="ad-avatar" aria-hidden="true">{initialOf(a.username)}</span>
      <span className="ad-who-text">
        <span className="ad-who-name">
          <span className="ad-who-user" title={a.username}>{a.username}</span>
          {isOwner(a) ? <span className="ad-chip">管理员</span> : null}
        </span>
        {a.platform ? (
          <span className="ad-who-pf" title={a.platform.name}>
            <span className="ad-pf-icon" aria-hidden="true">{a.platform.icon || '✨'}</span>{a.platform.name}
          </span>
        ) : <span className="ad-who-pf is-none">未建智能体</span>}
      </span>
    </div>
  )
}

function Meter({ field, used, limit, who }) {
  const { short, title } = QUOTA_LABELS[field]
  const tone = meterTone(used, limit)
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0
  return (
    <div className={`ad-meter is-${tone}`}>
      <div className="ad-meter-text">
        <span className="ad-meter-label">{short}</span>
        <b>{fmtInt(used)}</b>
        <span className="ad-meter-limit">{limit === null ? '不限' : `/ ${fmtInt(limit)}`}</span>
        {tone === 'full' ? <span className="ad-meter-flag">已用完</span> : null}
      </div>
      <div className="ad-meter-track" role={limit === null ? undefined : 'progressbar'}
        aria-label={limit === null ? undefined : `${who} 今天${title.replace('每天的', '')}`}
        aria-valuemin={limit === null ? undefined : 0} aria-valuemax={limit ?? undefined}
        aria-valuenow={limit === null ? undefined : Math.min(used, limit)}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function TodayMeters({ a, defaults }) {
  return (
    <div className="ad-meters">
      {['daily_model_calls', 'daily_flow_runs'].map(f => (
        <Meter key={f} field={f} who={a.username}
          used={f === 'daily_model_calls' ? a.today.calls : a.today.flow_runs}
          limit={quotaLimit(a.quota, f, a, defaults)} />
      ))}
    </div>
  )
}

function QuotaAction({ a, onEdit }) {
  if (isOwner(a)) return <span className="ad-chip is-quiet" title="管理员不受每日配额限制">管理员不限</span>
  return (
    <button type="button" className="jv-btn jv-btn--sm ad-quota-btn" onClick={() => onEdit(a)} aria-label={`改 ${a.username} 的配额`}>
      改配额
    </button>
  )
}

function Flows({ a }) {
  return (
    <span className="ad-flows">
      <b>{fmtInt(a.flow_runs)}</b>
      {a.flow_failures ? <span className="ad-fail">失败 {fmtInt(a.flow_failures)}</span> : <span className="ad-dim">{a.flow_runs ? '全部成功' : '没跑过'}</span>}
    </span>
  )
}

export default function Accounts({ accounts, defaults, rangeLabel, onEdit, now = new Date() }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('usage')
  const narrow = useNarrow()
  const rows = useMemo(() => sortAccounts(accounts, { query, sort }), [accounts, query, sort])
  const sortCol = { usage: 'calls', cost: 'cost', failures: 'flows', recent: 'recent' }[sort]
  const ariaSort = col => (col === sortCol ? 'descending' : undefined)

  return (
    <div className="ad-accounts">
      <div className="ad-toolbar">
        <label className="ad-search">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜账号或智能体"
            aria-label="搜索账号" enterKeyHint="search" autoComplete="off" spellCheck={false} />
          {query ? (
            <button type="button" className="ad-search-clear" onClick={() => setQuery('')} aria-label="清空搜索">
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </label>
        <div className="ad-sort">
          <span className="ad-sort-label" aria-hidden="true">排序</span>
          <Segmented label="排序" size="sm" options={SORTS} value={sort} onChange={setSort} />
        </div>
      </div>

      {!accounts.length ? <p className="ad-empty-line">还没有账号</p>
        : !rows.length ? <p className="ad-empty-line">没有找到「{query.trim()}」</p>
          : narrow ? (
            <ul className="ad-acct-cards" aria-label="账号">
              {rows.map(a => (
                <li key={a.user_id || a.username} className="ad-acct-card" data-user={a.username}>
                  <div className="ad-acct-card-top"><Who a={a} /><QuotaAction a={a} onEdit={onEdit} /></div>
                  <div className="ad-acct-card-label">今天</div>
                  <TodayMeters a={a} defaults={defaults} />
                  <dl className="ad-acct-stats">
                    <div><dt>{rangeLabel}调用</dt><dd>{fmtInt(a.calls)}</dd></div>
                    <div><dt>估算花费</dt><dd>{fmtYuan(a.cost_yuan)}</dd></div>
                    <div><dt>流程运行</dt><dd><Flows a={a} /></dd></div>
                    <div><dt>最近活跃</dt><dd>{relTime(a.last_active_at, now)}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ad-table-wrap">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th scope="col">账号</th>
                    <th scope="col">今天 / 配额</th>
                    <th scope="col" className="num" aria-sort={ariaSort('calls')}>{rangeLabel}调用</th>
                    <th scope="col" className="num" aria-sort={ariaSort('cost')}>估算花费</th>
                    <th scope="col" className="num" aria-sort={ariaSort('flows')}>流程运行</th>
                    <th scope="col" aria-sort={ariaSort('recent')}>最近活跃</th>
                    <th scope="col"><span className="sr-only">配额</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(a => (
                    <tr key={a.user_id || a.username} data-user={a.username}>
                      <td><Who a={a} /></td>
                      <td><TodayMeters a={a} defaults={defaults} /></td>
                      <td className="num"><b>{fmtInt(a.calls)}</b><span className="ad-dim">{fmtCompact(a.tokens)} token</span></td>
                      <td className="num"><b>{fmtYuan(a.cost_yuan)}</b></td>
                      <td className="num"><Flows a={a} /></td>
                      <td className="ad-when">{relTime(a.last_active_at, now)}</td>
                      <td className="end"><QuotaAction a={a} onEdit={onEdit} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </div>
  )
}
