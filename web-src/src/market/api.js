import { csrfHeaders } from '../api.js'

/* 智能平台市场的接口封装（契约见 docs/proposals/2026-10-round13-platform.md 4.2）。
 * 出错一律抛带 status / code 的 Error，message 已是能直接给人看的中文。 */

const FALLBACK = {
  0: '网络好像断了，检查一下再试',
  400: '填写的内容有点问题，检查一下再试',
  401: '登录已过期，请重新登录',
  403: '这一步暂时没有权限',
  404: '没找到要的东西，刷新一下试试',
  409: '刚才没生成成功，再试一次',
  413: '内容太长了，删短一点再试',
  422: '填写的内容有点问题，检查一下再试',
  429: '操作太频繁了，歇一会儿再试',
}

export function humanError(status, serverText = '') {
  const text = typeof serverText === 'string' ? serverText.trim() : ''
  // 服务端给的是人话就直接用；英文报错、堆栈之类换成兜底文案
  if (text && /[一-龥]/.test(text) && text.length <= 80) return text
  if (status >= 500) return '服务器开小差了，稍后再试'
  return FALLBACK[status] || '出了点问题，稍后再试'
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = body === undefined ? { ...csrfHeaders() } : { 'Content-Type': 'application/json', ...csrfHeaders() }
  let response
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    const error = new Error(humanError(0))
    error.status = 0
    throw error
  }
  let data = null
  try { data = await response.json() } catch { data = null }
  if (!response.ok) {
    const error = new Error(humanError(response.status, data?.error))
    error.status = response.status
    error.code = data?.code || ''
    throw error
  }
  return data || {}
}

export const getCatalog = () => request('/api/market/catalog')

/** { profession?, description? } → { plugins, flows, reason, source } */
export function recommend({ profession, description } = {}) {
  const body = {}
  if (profession) body.profession = profession
  if (description) body.description = description.slice(0, 300)
  return request('/api/market/recommend', { method: 'POST', body })
}

/** 生成平台 = 开一个独立账号：{ platform: PlatformIn, invite_code? } → 201 { username, password, platform }。
 *  不登录、不种 cookie；已登录的 Owner 不受市场注册开关限制，Member 得 403 */
export function marketSignup(platform, inviteCode = '') {
  const body = { platform }
  if (inviteCode) body.invite_code = inviteCode
  return request('/api/market/signup', { method: 'POST', body })
}
