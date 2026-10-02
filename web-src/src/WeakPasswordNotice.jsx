import { useState } from 'react'
import { ACCOUNT_KEYS, readAccount, writeAccount } from './accountStorage.js'

// 「稍后」按账号记（sessionStorage 的 jws_weak_pw_dismissed:<用户名>）：换个弱口令账号登录照样提醒
function readDismissed() {
  return readAccount(ACCOUNT_KEYS.weakDismissed) === '1'
}

/** 弱口令提醒：服务端 /api/session 返回 password_weak=true 时出现。
 *  「稍后」只在本次浏览器会话内不再出现，下次打开仍会提醒；改完口令后服务端不再下发该标记。 */
export default function WeakPasswordNotice({ weak, onFix }) {
  const [dismissed, setDismissed] = useState(readDismissed)
  if (!weak || dismissed) return null
  const later = () => {
    writeAccount(ACCOUNT_KEYS.weakDismissed, '1')   // 无痕模式写不进：仅本页隐藏
    setDismissed(true)
  }
  return (
    <div className="jv-banner" role="alert">
      <span className="jv-banner-text">当前账号的口令过于简单，网站在公网上，任何人都可能登录。建议尽快修改。</span>
      <button type="button" className="jv-banner-act" onClick={onFix}>去修改</button>
      <button type="button" className="jv-banner-later" onClick={later}>稍后</button>
    </div>
  )
}
