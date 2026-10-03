/* 新手引导「看过没」的存取（第十八轮）。
 *
 *  - 登录用户：以服务端 /api/onboarding 为准（换设备也只出现一次），同时缓存到 localStorage（键按账号区分）；
 *    接口失败时退回本地缓存。本地写了、服务端还没收到的记录带 local 标记，下次读到服务端结果时补交。
 *  - 游客（市场页未登录）：只用 localStorage（不带账号的键）。游客在这台设备上看过的引导，登录后并入账号
 *    （刚在市场看过引导再登录，不会马上又弹一遍）。
 *  - 读写一律 try/catch：隐私模式、存储被禁时只影响「下次还会不会弹」。 */
import { csrfHeaders } from '../api.js'
import { accountKey, currentAccount } from '../accountStorage.js'

export const LOCAL_KEY = 'jws_tour_seen'
const STATUSES = new Set(['done', 'skipped'])
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/

let cache = { who: null, seen: {}, promise: null }

function clean(raw, { keepLocal = true } = {}) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, entry] of Object.entries(raw)) {
    if (!ID_RE.test(id) || !entry || typeof entry !== 'object' || !STATUSES.has(entry.status)) continue
    out[id] = { status: entry.status, at: String(entry.at || '') }
    if (keepLocal && entry.local) out[id].local = true
  }
  return out
}

function readLocal(who) {
  try { return clean(JSON.parse(window.localStorage.getItem(accountKey(LOCAL_KEY, who)) || '{}')) } catch { return {} }
}

function writeLocal(who, seen) {
  try {
    const key = accountKey(LOCAL_KEY, who)
    if (Object.keys(seen).length) window.localStorage.setItem(key, JSON.stringify(seen))
    else window.localStorage.removeItem(key)
  } catch { /* 写不进只影响下次 */ }
}

const plain = seen => Object.fromEntries(Object.entries(seen).map(([id, e]) => [id, { status: e.status, at: e.at }]))

async function request(method, body) {
  if (typeof fetch !== 'function') throw new Error('offline')
  const init = method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body),
  }
  const r = await fetch('/api/onboarding', init)
  if (!r || r.ok === false || (r.status && r.status >= 400)) throw new Error(String(r?.status || 'error'))
  const data = await r.json()
  if (!data || typeof data !== 'object') throw new Error('bad response')
  return data
}

/** 把一笔本地记录补交给服务端；成功就去掉 local 标记 */
function push(who, id, entry) {
  request('PUT', { tour: id, status: entry.status })
    .then(() => {
      if (cache.who !== who || !cache.seen[id]) return
      cache.seen[id] = { status: cache.seen[id].status, at: cache.seen[id].at }
      writeLocal(who, cache.seen)
    })
    .catch(() => { /* 留着 local 标记，下次再补 */ })
}

function ensureAccount() {
  const who = currentAccount()
  if (cache.who !== who) cache = { who, seen: readLocal(who), promise: null }
  return who
}

/** 拉服务端记录并与本地合并（失败就沿用本地缓存，不抛） */
function syncFromServer(who) {
  return request('GET')
    .then(data => {
      if (cache.who !== who) return
      const merged = clean(data.seen, { keepLocal: false })
      const pending = []
      for (const [id, entry] of Object.entries(cache.seen)) {
        if (entry.local && !merged[id]) { merged[id] = entry; pending.push(id) }
      }
      for (const [id, entry] of Object.entries(readLocal(''))) {   // 游客时看过的：并入账号
        if (!merged[id]) { merged[id] = { ...entry, local: true }; pending.push(id) }
      }
      cache.seen = merged
      writeLocal(who, merged)
      pending.forEach(id => push(who, id, merged[id]))
    })
    .catch(() => { /* 接口不通：用本地缓存 */ })
}

/** 当前账号看过的引导：{ id: { status, at } }。同一账号只向服务端请求一次（force 重新拉）；
 *  返回的总是加载完成后的最新状态（包括之后 markSeen 记下的）。 */
export function loadSeen({ force = false } = {}) {
  const who = ensureAccount()
  if (!cache.promise || force) cache.promise = who ? syncFromServer(who) : Promise.resolve()
  return cache.promise.then(() => plain(cache.who === who ? cache.seen : readLocal(who)))
}

/** 同步查（用已加载的缓存；还没加载过就读本地） */
export function hasSeen(id) {
  ensureAccount()
  return Boolean(cache.seen[id])
}

/** 记一笔：先写本地，登录用户再同步给服务端（失败留 local 标记下次补交） */
export function markSeen(id, status) {
  if (!ID_RE.test(String(id)) || !STATUSES.has(status)) return Promise.resolve(false)
  const who = ensureAccount()
  const entry = { status, at: new Date().toISOString() }
  cache.seen = { ...cache.seen, [id]: who ? { ...entry, local: true } : entry }
  writeLocal(who, cache.seen)
  if (!who) return Promise.resolve(true)
  return request('PUT', { tour: id, status })
    .then(() => {
      if (cache.who === who && cache.seen[id]) {
        cache.seen = { ...cache.seen, [id]: { status: cache.seen[id].status, at: cache.seen[id].at } }
        writeLocal(who, cache.seen)
      }
      return true
    })
    .catch(() => false)
}

/** 重置所有引导：清本地（账号与这台设备的游客记录），登录用户再清服务端。返回服务端是否清成功（游客恒为 true） */
export function resetSeen() {
  const who = ensureAccount()
  cache.seen = {}
  writeLocal(who, {})
  writeLocal('', {})
  if (!who) {
    cache.promise = Promise.resolve()
    return Promise.resolve(true)
  }
  const done = request('PUT', { reset: true }).then(() => true).catch(() => false)
  cache.promise = done.then(() => {})   // 之后的读取等重置落地，不再拿旧记录
  return done
}

/** 测试用：清掉内存缓存 */
export function _resetStoreCache() {
  cache = { who: null, seen: {}, promise: null }
}
