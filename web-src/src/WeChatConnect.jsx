import { useEffect, useRef, useState } from 'react'
import { csrfHeaders } from './api.js'

async function j(path, opts) {
  const r = await fetch(path, opts)
  if (r.status === 401) throw new Error('401')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export default function WeChatConnect({ onClose, onExpired }) {
  const [s, setS] = useState(null)
  const timer = useRef()

  async function refresh() {
    try { setS(await j('/api/wechat/status')) }
    catch (e) { if (e.message === '401') onExpired?.() }
  }
  useEffect(() => {
    void refresh()
    timer.current = setInterval(refresh, 2000)
    return () => clearInterval(timer.current)
  }, [onExpired])

  async function connect() {
    setS({ state: 'loading' })
    try { setS(await j('/api/wechat/connect', { method: 'POST', headers: csrfHeaders() })) }
    catch (e) {
      if (e.message === '401') onExpired?.()
      else setS({ state: 'error', error: '连不上微信桥，请稍后重试' })
    }
  }
  async function disconnect() {
    try { setS(await j('/api/wechat/disconnect', { method: 'POST', headers: csrfHeaders() })) }
    catch (e) {
      if (e.message === '401') onExpired?.()
      else setS({ state: 'error', error: '断开失败，请稍后重试' })
    }
  }

  const state = s?.state
  return (
    <div className="wx-backdrop" onClick={onClose}>
      <div className="wx-card" role="dialog" aria-modal="true"
        aria-label="接入个人微信" onClick={e => e.stopPropagation()}>
        <div className="wx-head">
          <span className="wx-title">接入个人微信</span>
          <button type="button" className="wx-x" aria-label="关闭微信接入"
            onClick={onClose}>✕</button>
        </div>

        {state === 'connected' ? (
          <div className="wx-body wx-center">
            <div className="wx-ok">✓</div>
            <div className="wx-big">微信已连接</div>
            <p className="wx-hint">现在在微信里给这个号发消息，贾维斯就会回你——记备忘、查天气、问日程都行。</p>
            <button type="button" className="wx-btn ghost" onClick={disconnect}>断开连接</button>
          </div>
        ) : state === 'waiting' ? (
          <div className="wx-body wx-center">
            <div className="wx-qrwrap">
              {s.qr_uri && <img className="wx-qr" src={s.qr_uri} alt="微信登录二维码" />}
            </div>
            <div className="wx-big">请用微信扫码</div>
            <p className="wx-hint">打开微信 → 扫一扫 → 扫描上方二维码 → 手机上确认登录。<br/>建议用<b>专用小号</b>，扫码后可关闭本窗口。</p>
            <div className="wx-wait">● 等待扫码…（{s.since} 起）</div>
            <button type="button" className="wx-btn ghost" onClick={disconnect}>
              取消本次扫码
            </button>
          </div>
        ) : state === 'loading' ? (
          <div className="wx-body wx-center"><div className="wx-big">正在取二维码…</div></div>
        ) : (
          <div className="wx-body">
            <p className="wx-lead">扫一次码，就能在<b>微信里直接和贾维斯对话</b>。桥接跑在服务器上，全天在线，你的电脑不用一直开着。</p>
            <ol className="wx-steps">
              <li>准备一个<b>专用微信小号</b>（别用主号，第三方接入有封号风险）</li>
              <li>点下方按钮生成二维码</li>
              <li>用小号微信「扫一扫」，手机确认登录</li>
              <li>之后给这个小号发消息，就是在和贾维斯聊天</li>
            </ol>
            {s?.error && <div className="wx-err">⚠ {s.error}</div>}
            <button type="button" className="wx-btn" onClick={connect}>生成二维码，开始接入</button>
          </div>
        )}
      </div>
    </div>
  )
}
