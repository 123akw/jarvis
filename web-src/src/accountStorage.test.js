import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_KEYS, accountKey, currentAccount, migrateLegacy, readAccount, setCurrentAccount, writeAccount,
} from './accountStorage.js'
import { receiptsOn, setReceipts } from './memoryPrefs.js'

function memoryStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: k => { m.delete(k) },
  }
}

describe('按账号区分的本地存储', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('sessionStorage', memoryStorage())
    setCurrentAccount('')
  })
  afterEach(() => { vi.unstubAllGlobals(); setCurrentAccount('') })

  it('账号数据的键名带用户名（不分大小写），没有账号时就是原键', () => {
    expect(accountKey('jws_thread', 'Alice')).toBe('jws_thread:alice')
    expect(accountKey('jws_thread', '')).toBe('jws_thread')
    writeAccount(ACCOUNT_KEYS.thread, 't-a', 'alice')
    writeAccount(ACCOUNT_KEYS.thread, 't-b', 'bob')
    expect(readAccount(ACCOUNT_KEYS.thread, 'ALICE')).toBe('t-a')
    expect(readAccount(ACCOUNT_KEYS.thread, 'bob')).toBe('t-b')
    expect(readAccount(ACCOUNT_KEYS.thread, 'carol')).toBeNull()
  })

  it('不传用户名时用当前账号；弱口令「稍后」记在 sessionStorage', () => {
    setCurrentAccount('alice')
    expect(currentAccount()).toBe('alice')
    writeAccount(ACCOUNT_KEYS.weakDismissed, '1')
    expect(sessionStorage.getItem('jws_weak_pw_dismissed:alice')).toBe('1')
    setCurrentAccount('bob')
    expect(readAccount(ACCOUNT_KEYS.weakDismissed)).toBeNull()      // 换个账号照样提醒
  })

  it('旧键迁给当前登录的账号一次（已有值不覆盖），之后旧键消失', () => {
    localStorage.setItem('jws_thread', 't-old')
    localStorage.setItem('jws_brief_hide', '2026-10-02')
    localStorage.setItem(accountKey('jws_brief_hide', 'admin'), '2026-10-01')
    sessionStorage.setItem('jws_weak_pw_dismissed', '1')
    migrateLegacy('admin')
    expect(localStorage.getItem('jws_thread:admin')).toBe('t-old')
    expect(localStorage.getItem('jws_brief_hide:admin')).toBe('2026-10-01')
    expect(sessionStorage.getItem('jws_weak_pw_dismissed:admin')).toBe('1')
    expect(localStorage.getItem('jws_thread')).toBeNull()
    migrateLegacy('bob')                                            // 迁过一次就没有了
    expect(localStorage.getItem('jws_thread:bob')).toBeNull()
  })

  it('存储不可用（隐私模式抛错）时读写都不报错', () => {
    const deny = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: deny, setItem: deny, removeItem: deny })
    expect(readAccount(ACCOUNT_KEYS.thread, 'alice')).toBeNull()
    expect(() => writeAccount(ACCOUNT_KEYS.thread, 'x', 'alice')).not.toThrow()
    expect(() => migrateLegacy('alice')).not.toThrow()
  })

  it('换号时复位内存里的账号状态（记忆回执开关）', async () => {
    setCurrentAccount('alice')
    await Promise.resolve()
    setReceipts(false)
    setCurrentAccount('alice')                                      // 同一个账号：不动
    await Promise.resolve()
    expect(receiptsOn()).toBe(false)
    setCurrentAccount('bob')
    expect(receiptsOn()).toBe(false)                                // 渲染途中不同步触发
    await Promise.resolve()
    expect(receiptsOn()).toBe(true)
  })
})
