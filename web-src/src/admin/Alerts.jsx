import Icon from '../Icon.jsx'
import { alertKind, relTime } from './model.js'
import { ErrorBox } from './ui.jsx'

/* 告警列表：定时流程被暂停、渠道断开、配额用完、定时流程连续失败……
 * 未读的有蓝点、字重一点；每条可单独标已读，页头「全部已读」。没有告警时说「一切正常」。 */

function Skeleton() {
  return (
    <ul className="ad-alerts" aria-hidden="true">
      {[0, 1, 2].map(i => <li key={i} className="ad-alert ad-skel-row"><i /><span><i /><i /></span></li>)}
    </ul>
  )
}

export default function Alerts({ alerts, loading, error, busy, onRead, onRetry, now = new Date() }) {
  if (loading && !alerts) return <Skeleton />
  if (error && !alerts) return <ErrorBox message={error} onRetry={onRetry} compact />
  if (!alerts?.length) {
    return (
      <div className="ad-calm">
        <span className="ad-calm-mark" aria-hidden="true"><Icon name="check" size={18} /></span>
        <div>
          <p className="ad-calm-title">一切正常</p>
          <p className="ad-dim">定时流程、飞书 / 微信连接和各账号的配额都没出状况。</p>
        </div>
      </div>
    )
  }
  return (
    <>
      {error ? <ErrorBox message={error} onRetry={onRetry} compact /> : null}
      <ul className="ad-alerts">
        {alerts.map(a => {
          const k = alertKind(a.kind)
          return (
            <li key={a.id} className={`ad-alert${a.read ? '' : ' is-unread'}`} data-alert={a.id}>
              <span className="ad-alert-icon" aria-hidden="true"><Icon name={k.icon} size={16} /></span>
              <div className="ad-alert-body">
                <p className="ad-alert-title">
                  {a.read ? null : <span className="sr-only">未读：</span>}
                  {a.title || k.label}
                </p>
                {a.detail ? <p className="ad-alert-detail">{a.detail}</p> : null}
                <p className="ad-alert-meta">
                  <span>{k.label}</span>
                  {a.owner ? <span>{a.owner.username}</span> : null}
                  <time dateTime={a.created_at} title={a.created_at ? new Date(a.created_at).toLocaleString('zh-CN') : ''}>{relTime(a.created_at, now)}</time>
                </p>
              </div>
              {a.read ? null : (
                <button type="button" className="ad-alert-read" onClick={() => onRead([a.id])} disabled={busy}
                  aria-label={`标为已读：${a.title || k.label}`} title="标为已读">
                  <Icon name="check" size={14} /><span className="ad-alert-read-text">标为已读</span>
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
