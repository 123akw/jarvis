import { useEffect, useRef, useState } from 'react'
import { createFeishuBindCode, getFeishuStatus, unbindFeishu } from './api.js'
import { copyText } from './clipboard.js'
import Icon from './Icon.jsx'
import Modal, { ModalHead } from './Modal.jsx'

/** 长连接状态 → 文案 + 状态点样式 */
const CONN = {
  connected: ['已连接', 'online'],
  connecting: ['连接中…', 'busy'],
  reconnecting: ['重连中…', 'busy'],
  error: ['连接异常', 'error'],
  stopped: ['未启动', 'idle'],
  disabled: ['未启动', 'idle'],
}

const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/**
 * 飞书绑定面板：把当前贾维斯账号绑到飞书用户上。
 *  - 未绑定：生成 6 位一次性绑定码（10 分钟），在飞书里私聊机器人发送「绑定 123456」；
 *    发码后轮询状态，绑上即自动切到「已绑定」。
 *  - 已绑定：可解绑（二次确认）。
 * onChange(status) 把最新状态回传给 Hud（菜单里显示「已绑定」）。
 */
export default function FeishuConnect({ onClose, onExpired, onChange, pollMs = 3000 }) {
  const [status, setStatus] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [issued, setIssued] = useState(null)    // { code, command, expiresAt }
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef(0)
  const alive = useRef(true)
  // 按钮被替换后焦点别掉到 body：发码后落在「复制」，进入确认时落在「取消」（破坏性操作默认不选中确认）
  const copyRef = useRef(null)
  const cancelRef = useRef(null)
  const unbindRef = useRef(null)
  const focusNext = useRef(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  async function refresh() {
    try {
      const s = await getFeishuStatus()
      if (!alive.current) return null
      setStatus(s)
      setLoadErr('')
      onChangeRef.current?.(s)
      if (s.bound) setIssued(null)   // 在飞书里发完绑定码：码作废，切到已绑定
      return s
    } catch (e) {
      if (e.message === '401') onExpired?.()
      else if (alive.current) setLoadErr(e.message || '读取失败')
      return null
    }
  }

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false; clearTimeout(copyTimer.current) }
  }, [])

  useEffect(() => {
    const target = focusNext.current
    focusNext.current = null
    target?.current?.focus()
  })

  const remaining = issued ? Math.max(0, Math.ceil((issued.expiresAt - now) / 1000)) : 0
  const waiting = Boolean(issued) && remaining > 0 && !status?.bound

  // 有码在等：每秒走倒计时，按 pollMs 轮询是否已在飞书里完成绑定
  useEffect(() => {
    if (!waiting) return undefined
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => { void refresh() }, pollMs)
    return () => { clearInterval(tick); clearInterval(poll) }
  }, [waiting, pollMs])

  async function issue() {
    setBusy(true); setErr(''); setCopied(false)
    try {
      const r = await createFeishuBindCode()
      const t = Date.now()
      setNow(t)
      setIssued({ code: r.code, command: r.command || `绑定 ${r.code}`, expiresAt: t + (Number(r.expires_in) || 600) * 1000 })
      focusNext.current = copyRef
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setErr(`没能生成绑定码：${e.message || '请稍后再试'}`)
    } finally {
      setBusy(false)
    }
  }

  async function unbind() {
    setBusy(true); setErr('')
    try {
      await unbindFeishu()
      setConfirming(false)
      await refresh()
    } catch (e) {
      if (e.message === '401') { onExpired?.(); return }
      setErr(`解绑没有成功：${e.message || '请稍后再试'}`)
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    const ok = await copyText(issued.command)
    setCopied(ok)
    if (!ok) setErr('复制失败，请手动输入这句话')
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  const bot = status?.bot_name || '贾维斯'
  const [connText, connDot] = CONN[status?.state] || ['未知', 'idle']
  const expired = Boolean(issued) && remaining === 0

  return (
    <Modal label="接入飞书" onClose={onClose} size="sm">
      <ModalHead title="接入飞书" subtitle="绑定后，在飞书里私聊机器人就能和贾维斯对话" onClose={onClose} closeLabel="关闭飞书接入" />
      <div className="jv-modal-body">
        {!status ? (
          loadErr
            ? <div className="wx-err" role="alert">暂时读不到飞书状态：{loadErr}</div>
            : <p className="jv-muted" role="status">正在读取飞书状态…</p>
        ) : (
          <>
            <dl className="fs-status">
              <div><dt>机器人</dt><dd><span className={`status-dot ${connDot}`} aria-hidden="true" />{connText}</dd></div>
              <div><dt>我的账号</dt><dd>{status.bound ? <b className="fs-bound">已绑定</b> : '未绑定'}</dd></div>
            </dl>
            {status.state !== 'connected' ? (
              <p className="fs-warn">
                机器人现在没连上飞书，发过去的消息可能暂时收不到；稍后会自动重连。
                {status.error ? <><br />原因：{status.error}</> : null}
              </p>
            ) : null}

            {status.bound ? (
              <div className="fs-done">
                <div className="wx-ok" aria-hidden="true"><Icon name="check" size={30} /></div>
                <div className="wx-big">飞书已绑定</div>
                <p className="wx-hint">在飞书里私聊机器人「{bot}」就能直接对话；群聊里 @ 它也行。</p>
                {confirming ? (
                  <div className="fs-confirm" role="group" aria-label="确认解绑">
                    <p>解绑后，飞书里将无法再和贾维斯对话（之后可以随时重新绑定）。</p>
                    <div className="jv-actions">
                      <button ref={cancelRef} type="button" className="jv-btn" disabled={busy}
                        onClick={() => { setConfirming(false); focusNext.current = unbindRef }}>取消</button>
                      <button type="button" className="jv-btn jv-btn--danger" onClick={() => void unbind()} disabled={busy}>
                        {busy ? '解绑中…' : '确认解绑'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button ref={unbindRef} type="button" className="jv-btn jv-btn--danger jv-btn--block"
                    onClick={() => { setConfirming(true); focusNext.current = cancelRef }}>解绑飞书</button>
                )}
              </div>
            ) : issued && !expired ? (
              <div className="fs-issued">
                <p className="wx-lead">在飞书里<b>私聊机器人「{bot}」</b>，发送这句话：</p>
                <div className="fs-command">
                  <span className="fs-verb">绑定</span>
                  <span className="fs-code" aria-label="绑定码">{issued.code}</span>
                </div>
                <button ref={copyRef} type="button" className={`jv-btn jv-btn--primary jv-btn--block${copied ? ' is-done' : ''}`} onClick={() => void copy()}>
                  <Icon name={copied ? 'check' : 'copy'} size={16} />
                  {copied ? '已复制，去飞书粘贴发送' : `复制「${issued.command}」`}
                </button>
                <p className="fs-countdown">
                  <span className="mono">{mmss(remaining)}</span> 后失效 · 只能用一次
                  <span className="sr-only">（绑定成功后这里会自动更新）</span>
                </p>
                <p className="wx-wait" aria-live="polite">● 等你在飞书里发送…</p>
              </div>
            ) : (
              <div className="fs-start">
                {expired ? <div className="wx-err" role="alert">绑定码已过期</div> : null}
                <ol className="wx-steps">
                  <li>点下方按钮，生成一个 <b>6 位绑定码</b>（10 分钟内有效）</li>
                  <li>在飞书里搜索并<b>私聊机器人「{bot}」</b></li>
                  <li>发送「<b>绑定 + 绑定码</b>」，例如「绑定 123456」</li>
                </ol>
                <button type="button" className="jv-btn jv-btn--primary jv-btn--block" onClick={() => void issue()} disabled={busy}>
                  {busy ? '生成中…' : expired ? '重新生成绑定码' : '生成绑定码'}
                </button>
              </div>
            )}
            {err ? <div className="wx-err fs-err" role="alert">{err}</div> : null}
          </>
        )}
      </div>
    </Modal>
  )
}
